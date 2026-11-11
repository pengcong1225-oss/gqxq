import {randomUUID,createHash} from 'node:crypto';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {assertAllScope} from '../auth/accessScope';
import type {MasterDataContext} from '../types/masterData';
import {resolveAuthorizationFrom} from '../repositories/roleRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {canonicalJson} from '../repositories/canonicalJson';
import {parseComplaintExport,type ParsedComplaintRow} from './complaintImportParser';
import {importNewAppealInTx,isRetryableIntakeError,YIJIEJIEBAN_SYSTEM,type IntakeCommand} from './intakeService';
export type ComplaintImportContext=MasterDataContext & {sessionVersion?:number};

export interface ComplaintImportCounts {total:number;unique:number;duplicates:number;create:number;skip:number;error:number}
export interface ComplaintImportPreview {batchId:string;name:string;expiresAt:string;counts:ComplaintImportCounts;canCommit:boolean}
export interface ComplaintImportResult {batchId:string;state:'succeeded';created:number;skipped:number;completedAt:string}
export interface ComplaintImportDetail {row:number;sourceId:string;title:string;businessType:string|null;complaintType:string|null;districtName:string|null;action:'create'|'skip'|'duplicate'|'error';errors:string[]}
interface Batch {batchId:string;ownerId:string;preview:ComplaintImportPreview;details:ComplaintImportDetail[];rows:ParsedComplaintRow[];requestId:string|null;result:ComplaintImportResult|null;expiresAt:Date}
const json=<T>(value:unknown,fallback:T):T=>value==null?fallback:(typeof value==='string'?JSON.parse(value):value) as T;
function authorize(ctx:ComplaintImportContext){
 if(!ctx.userId||!ctx.permissionCodes.includes('complaint.import')||!ctx.permissionCodes.includes('complaint.read')||ctx.access.roles.includes('readonly'))throw AppError.forbidden('当前账号没有诉求导入权限');
 assertAllScope(ctx.access);
}
async function freshContext(tx:Tx,ctx:ComplaintImportContext):Promise<ComplaintImportContext>{
 await tx.query('select version from platform_authorization_state where id=1 for share');
 const auth=await resolveAuthorizationFrom(tx,ctx.userId!);
 const scope=await readUserScope(tx,ctx.userId!);
 const [users]=await tx.query('select must_change_password,session_version from app_user where user_id=? for share',[ctx.userId]);
 const identity=(users as {must_change_password:unknown;session_version:unknown}[])[0];
 if(ctx.sessionVersion!==undefined&&Number(identity?.session_version)!==ctx.sessionVersion)throw AppError.unauthenticated('登录已过期，请重新登录');
 if(Number((users as {must_change_password:unknown}[])[0]?.must_change_password)!==0)throw AppError.forbidden('请先完成账号初始化');
 const current={...ctx,permissionCodes:auth.permissionCodes,access:{...ctx.access,roles:auth.roleCodes,userId:ctx.userId!,...scope}};authorize(current);return current;
}
async function readBatch(tx:Tx,id:string,ctx:ComplaintImportContext,lock=false):Promise<Batch>{
 if(!/^CIMP-[a-f0-9-]{36}$/.test(id))throw AppError.notFound('导入批次不存在');
 const [data]=await tx.query('select batch_id,owner_id,preview,details,request_id,result,expires_at'+(lock?',plan_rows':'')+' from complaint_import_batch where batch_id=? and owner_id=?'+(lock?' for update':''),[id,ctx.userId]);
 const row=(data as Record<string,unknown>[])[0];if(!row)throw AppError.notFound('导入批次不存在');
 return {batchId:id,ownerId:String(row.owner_id),preview:json<ComplaintImportPreview>(row.preview,null as never),details:json(row.details,[]),rows:json(row.plan_rows,[]),requestId:row.request_id==null?null:String(row.request_id),result:json(row.result,null),expiresAt:new Date(row.expires_at as Date)};
}
function publicBatch(b:Batch){const expired=Date.now()>=b.expiresAt.getTime();return {preview:{...b.preview,canCommit:b.preview.canCommit&&!expired&&!b.result},result:b.result,expired,details:expired?[]:b.details};}
export async function pruneExpiredComplaintImports(){return withTransaction(async tx=>{await tx.query('update complaint_import_batch set plan_rows=null,details=null where expires_at<=now() and (plan_rows is not null or details is not null)');});}

class ComplaintImportService {
 async preview(file:{name:string;bytes:Buffer},ctx:ComplaintImportContext):Promise<ComplaintImportPreview>{
  authorize(ctx);const rows=await parseComplaintExport(file);
  return withTransaction(async tx=>{
   await freshContext(tx,ctx);
   const winners=new Map<string,ParsedComplaintRow>();for(const row of rows)winners.set(row.sourceId.toLowerCase(),row);
   const ids=[...winners.keys()].filter(Boolean);const existing=new Set<string>();
   if(ids.length){const [data]=await tx.query('select source_id from complaint where source_system=? and source_id in ('+ids.map(()=>'?').join(',')+')',[YIJIEJIEBAN_SYSTEM,...ids]);for(const r of data as {source_id:string}[])existing.add(r.source_id.toLowerCase());}
   const details:ComplaintImportDetail[]=rows.map(row=>({row:row.row,sourceId:row.sourceId,title:row.title.replace(/1[3-9]\d{9}/g,'[联系方式已隐去]'),businessType:row.businessType,complaintType:row.complaintType,districtName:row.districtName,action:row.errors.length?'error':winners.get(row.sourceId.toLowerCase())!==row?'duplicate':existing.has(row.sourceId.toLowerCase())?'skip':'create',errors:row.errors}));
   const counts={total:rows.length,unique:winners.size,duplicates:rows.length-winners.size,create:details.filter(d=>d.action==='create').length,skip:details.filter(d=>d.action==='skip').length,error:details.filter(d=>d.action==='error').length};
   const now=new Date(),expires=new Date(now.getTime()+24*3600000);
   const preview:ComplaintImportPreview={batchId:'CIMP-'+randomUUID(),name:file.name,expiresAt:expires.toISOString(),counts,canCommit:counts.error===0&&winners.size>0};
   const plan=[...winners.values()].sort((a,b)=>a.sourceId.toLowerCase().localeCompare(b.sourceId.toLowerCase()));
   await tx.execute('insert into complaint_import_batch(batch_id,owner_id,file_name,file_hash,preview,details,plan_rows,created_at,expires_at) values(?,?,?,?,?,?,?,?,?)',[preview.batchId,ctx.userId,file.name,createHash('sha256').update(file.bytes).digest('hex'),JSON.stringify(preview),JSON.stringify(details),JSON.stringify(plan),now,expires]);
   return preview;
  });
 }
 async get(id:string,ctx:ComplaintImportContext){authorize(ctx);return withTransaction(async tx=>{await freshContext(tx,ctx);return publicBatch(await readBatch(tx,id,ctx));});}
 async list(ctx:ComplaintImportContext){authorize(ctx);return withTransaction(async tx=>{await freshContext(tx,ctx);const [rows]=await tx.query('select batch_id from complaint_import_batch where owner_id=? order by created_at desc,batch_id desc limit 20',[ctx.userId]);const results=[];for(const row of rows as {batch_id:string}[]){const b=await readBatch(tx,row.batch_id,ctx);results.push({preview:publicBatch(b).preview,result:b.result,expired:Date.now()>=b.expiresAt.getTime()});}return results;});}
 async commit(id:string,requestId:string,ctx:ComplaintImportContext):Promise<ComplaintImportResult>{
  authorize(ctx);if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(requestId))throw AppError.validation('确认请求无效，请重新打开导入');
  for(let attempt=0;attempt<3;attempt++){
   try{return await withTransaction(async tx=>{
    const current=await freshContext(tx,ctx);const batch=await readBatch(tx,id,current,true);
    if(batch.result){if(batch.requestId!==requestId)throw AppError.conflict('此批次已确认，请查看导入结果');return batch.result;}
    if(Date.now()>=batch.expiresAt.getTime())throw AppError.conflict('预览已过期，请重新上传');
    if(!batch.preview.canCommit||batch.rows.some(row=>row.errors.length))throw AppError.validation('请修正全部错误后重新上传');
    const [districts]=await tx.query("select item_value,item_label from dict_item where dict_type='district' and status='enabled' and published=1");
    const codes=new Map<string,string[]>();for(const d of districts as {item_label:string;item_value:string}[]){const list=codes.get(d.item_label)??[];list.push(d.item_value);codes.set(d.item_label,list);}
    const receivedAt=new Date();let created=0,skipped=0;const outcomes=new Map<string,'create'|'skip'>();
    for(const row of batch.rows){
     const districtCodes=codes.get(row.districtName??'')??[];
     const channel=row.content?.startsWith('【省12345工单编号')?'省12345':row.content?.startsWith('【省退回重办')?'省退回重办':null;
     const payload={sourceId:row.sourceId,title:row.title,content:row.content,address:row.address,districtName:row.districtName,businessType:row.businessType,complaintType:row.complaintType,createdAt:row.sourceReportedAt,source:channel,metadata:row.metadata};
     const cmd:IntakeCommand={sourceSystem:YIJIEJIEBAN_SYSTEM,sourceId:row.sourceId,channel,title:row.title,content:row.content,address:row.address,districtName:row.districtName,districtCode:districtCodes.length===1?districtCodes[0]:null,longitude:null,latitude:null,explicitBusinessType:row.businessType,explicitComplaintType:row.complaintType,explicitUrgencyLevel:null,sourceReportedAt:row.sourceReportedAt?new Date(row.sourceReportedAt):null,payload,payloadHash:createHash('sha256').update(canonicalJson(payload)).digest('hex'),warnings:[],remoteIp:ctx.clientIp,requestId};
     const result=await importNewAppealInTx(tx,cmd,receivedAt);if(result)created++;else skipped++;outcomes.set(row.sourceId.toLowerCase(),result?'create':'skip');
    }
    const result:ComplaintImportResult={batchId:id,state:'succeeded',created,skipped,completedAt:new Date().toISOString()};
    const details=batch.details.map(d=>d.action==='duplicate'?d:{...d,action:outcomes.get(d.sourceId.toLowerCase())??d.action});
    await tx.execute('update complaint_import_batch set result=?,details=?,request_id=?,plan_rows=null where batch_id=?',[JSON.stringify(result),JSON.stringify(details),requestId,id]);
    await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:'complaint.import',action:'COMPLAINT_IMPORT_COMMIT',bizType:'complaint_import',bizId:id,result:'success',clientIp:ctx.clientIp,detail:{total:batch.preview.counts.total,duplicates:batch.preview.counts.duplicates,created,skipped},createdAt:new Date()});
    return result;
   });}catch(error){if(isRetryableIntakeError(error)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,40*(attempt+1)));continue;}if(error instanceof AppError)throw error;throw AppError.internal('导入未完成，整批已回滚，请重试');}
  }
  throw AppError.conflict('并发导入繁忙，请重试');
 }
}
export const complaintImportService=new ComplaintImportService();
