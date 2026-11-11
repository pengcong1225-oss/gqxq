import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
import {withTransaction} from '../db/tx';
import {AppError} from '../http/errors';
import {assertPuCredentials,serializeOnce,buildAttempt,postIntegrationTask} from '../clients/publicUtilityClient';
import {enterpriseService,readEnterpriseIn} from './enterpriseService';
import {readSupportStore,saveSupportStore} from './tenderSupportService';
import {canonicalUtilitySnapshot} from './utilityIntegrationService';
import {puEnterpriseSchema,PU_ENTERPRISE_SYSTEM_USER,choosePuEnterpriseTarget,sourceEnterpriseStatus,validSourceCreditCode,type PuEnterpriseSource} from '../domain/puEnterprise';
import type {MasterDataContext} from '../types/masterData';
import {insertAudit} from '../repositories/auditLogRepo';

const STORE='pu-enterprise-feed-real';
export const puEnterpriseSystemContext:MasterDataContext={userId:PU_ENTERPRISE_SYSTEM_USER,userName:'填报系统企业主数据同步',clientIp:null,permissionCodes:['enterprise.manage','enterprise.read'],access:{userId:PU_ENTERPRISE_SYSTEM_USER,roles:[],scopeVersion:0,rules:[{kind:'all'}],canReadSource:false}};
export function puEnterpriseSyncEnabled(){return process.env.GQXQ_PU_ENTERPRISE_SYNC_ENABLED==='true';}
const parsed=(value:any)=>typeof value==='string'?JSON.parse(value):value;
export interface PuEnterpriseBindingView {sourceSystem:'public-utility';sourceKind:string;sourceId:string;sourceEnterpriseId:string;sourceSubjectId:string|null;sourceAppCode:string|null;organizationCode:string|null;gqxqSubjectCode:string;sourceRevision:string;accountReadiness:PuEnterpriseSource['accountReadiness'];subjectAliases:PuEnterpriseSource['subjectAliases'];sourceStatus:string;ownedFields:string[];lastSyncedAt:string}
export async function puEnterpriseBinding(code:string,db:any=pool):Promise<PuEnterpriseBindingView|null>{
 const [rows]=await db.query('select source_kind,source_id,source_enterprise_id,source_subject_id,source_app_code,source_organization_code,gqxq_subject_code,source_revision,account_readiness,source_payload,updated_at from pu_enterprise_binding where enterprise_code=?',[code]);const r=rows[0];if(!r)return null;
 const source=parsed(r.source_payload);
 return {sourceSystem:'public-utility',sourceKind:r.source_kind,sourceId:r.source_id,sourceEnterpriseId:r.source_enterprise_id,sourceSubjectId:r.source_subject_id,sourceAppCode:r.source_app_code,organizationCode:r.source_organization_code,gqxqSubjectCode:r.gqxq_subject_code,sourceRevision:r.source_revision,accountReadiness:parsed(r.account_readiness),subjectAliases:source.subjectAliases??[],sourceStatus:source.sourceAvailability==='unavailable'?'unavailable':source.status,ownedFields:source.ownedFields??[],lastSyncedAt:new Date(r.updated_at).toISOString()};
}
export async function applyPuEnterprise(source:PuEnterpriseSource){
 if(source.dataMode!=='real')throw AppError.validation('模拟企业不写入真实企业主数据');
 const outcomes:{enterpriseCode:string;changed:boolean;reason:string}[]=[];
 for(const businessType of source.businessTypes){
  outcomes.push(await withTransaction(async tx=>{
   const [bindings]=await tx.query<any[]>('select enterprise_code enterpriseCode from pu_enterprise_binding where source_system=? and source_kind=? and source_id=? and business_type=?',['public-utility',source.sourceKind,source.sourceId,businessType]);
   const credit=validSourceCreditCode(source.creditCode);
   const [matches]=credit?await tx.query<any[]>('select enterprise_code enterpriseCode,business_type businessType from enterprise where uscc=? and business_type=?',[credit,businessType]):[[],[]];
   const target=choosePuEnterpriseTarget(source,businessType,bindings[0]??null,matches),before=await readEnterpriseIn(tx,target.enterpriseCode);
   if(!bindings.length&&before&&target.reason==='new_source_identity')throw AppError.conflict('来源稳定编码已被其他档案占用，未按企业名称合并');
   const [owners]=await tx.query<any[]>('select source_kind,source_id,business_type,source_revision,source_payload from pu_enterprise_binding where enterprise_code=?',[target.enterpriseCode]);
   if(owners.length&&(owners[0].source_kind!==source.sourceKind||owners[0].source_id!==source.sourceId||owners[0].business_type!==businessType))throw AppError.conflict('信用代码候选已绑定另一来源企业，需人工核实');
   const addressProvided=Object.prototype.hasOwnProperty.call(source,'address')&&source.address!==undefined;
   const address=addressProvided?(source.address==null?null:source.address.trim()||null):undefined;
   const ownedFields=['enterpriseName','businessType','status',...(credit?['uscc']:[]),...(addressProvided?['address']:[])];
   const payload={...source,...(addressProvided?{address}:{}),ownedFields};
   const expectedStatus=sourceEnterpriseStatus(source.status);
   const unchanged=owners.length&&canonicalUtilitySnapshot(parsed(owners[0].source_payload))===canonicalUtilitySnapshot(payload)&&before?.enterpriseName===source.companyName&&before?.businessType===businessType&&before?.status===expectedStatus&&(!credit||before?.uscc===credit)&&(!addressProvided||before?.address===address);
   if(unchanged)return {enterpriseCode:target.enterpriseCode,changed:false,reason:target.reason};
   // Only fields that the source actually supplies are authoritative. The
   // service preserves household versions, grids, service area, local contacts,
   // district management scope, score and display settings.
   await enterpriseService.saveInTx(tx,{enterpriseCode:target.enterpriseCode,enterpriseName:source.companyName,businessType,status:expectedStatus,expectedVersion:before?.version??0,...(credit?{uscc:credit}:{}),...(addressProvided?{address}:{}),...(before?{}:{displayOnScreen:false}),...(expectedStatus==='disabled'?{disableReason:source.status==='unknown'?'来源主体状态尚未确认':'填报系统来源主体已停用'}:{})},puEnterpriseSystemContext);
   await tx.execute('insert into pu_enterprise_binding(source_system,source_kind,source_id,business_type,enterprise_code,source_enterprise_id,source_subject_id,source_app_code,source_organization_code,gqxq_subject_code,source_revision,account_readiness,source_payload,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(6)) on duplicate key update source_subject_id=values(source_subject_id),source_app_code=values(source_app_code),source_organization_code=values(source_organization_code),gqxq_subject_code=values(gqxq_subject_code),source_revision=values(source_revision),account_readiness=values(account_readiness),source_payload=values(source_payload),updated_at=NOW(6)',['public-utility',source.sourceKind,source.sourceId,businessType,target.enterpriseCode,source.sourceEnterpriseId,source.sourceSubjectId??null,source.sourceAppCode??null,source.organizationCode??null,source.gqxqSubjectCode,source.revision,JSON.stringify(source.accountReadiness),JSON.stringify(payload)]);
   await insertAudit(tx,{userId:PU_ENTERPRISE_SYSTEM_USER,appCode:'gqxq',resourceCode:'enterprise',action:'PU_ENTERPRISE_SYNC',bizType:'enterprise',bizId:target.enterpriseCode,result:'success',clientIp:null,createdAt:new Date(),detail:{sourceKind:source.sourceKind,sourceId:source.sourceId,sourceRevision:source.revision,enterpriseCode:target.enterpriseCode,targetReason:target.reason,sourceAccountReady:source.accountReadiness.canReceiveTask}});
   return {enterpriseCode:target.enterpriseCode,changed:true,reason:target.reason};
  }));
 }
 return outcomes;
}
/** Called only after every page passed validation. Missing/department-converted
 * sources lose availability while their identity and historical links remain. */
export async function retireMissingPuEnterprises(sources:PuEnterpriseSource[]){
 const [bindings]=await pool.query<any[]>("select source_id,business_type,enterprise_code,source_payload,account_readiness from pu_enterprise_binding where source_system='public-utility' and source_kind='company'");
 let retired=0;
 for(const binding of bindings){
  if(sources.some(s=>s.sourceId===String(binding.source_id)&&s.businessTypes.includes(binding.business_type)))continue;
  const payload=parsed(binding.source_payload),readiness=parsed(binding.account_readiness);
  if(payload.sourceAvailability==='unavailable'&&readiness.canReceiveTask===false)continue;
  await withTransaction(async tx=>{
   const enterprise=await readEnterpriseIn(tx,binding.enterprise_code);if(!enterprise)throw AppError.conflict('来源绑定的企业档案缺失');
   if(enterprise.status!=='disabled')await enterpriseService.saveInTx(tx,{enterpriseCode:enterprise.enterpriseCode,enterpriseName:enterprise.enterpriseName,businessType:enterprise.businessType,status:'disabled',expectedVersion:enterprise.version,disableReason:'完整来源快照中已无此经营企业或该业务类型；保留原档案与业务关联'},puEnterpriseSystemContext);
   await tx.execute('update pu_enterprise_binding set account_readiness=?,source_payload=?,updated_at=NOW(6) where enterprise_code=?',[JSON.stringify({...readiness,canReceiveTask:false}),JSON.stringify({...payload,sourceAvailability:'unavailable'}),binding.enterprise_code]);
   await insertAudit(tx,{userId:PU_ENTERPRISE_SYSTEM_USER,appCode:'gqxq',resourceCode:'enterprise',action:'PU_ENTERPRISE_UNAVAILABLE',bizType:'enterprise',bizId:binding.enterprise_code,result:'success',clientIp:null,createdAt:new Date(),detail:{enterpriseCode:binding.enterprise_code,sourceId:binding.source_id,businessType:binding.business_type,reason:'absent_from_complete_operating_company_snapshot'}});
  });retired++;
 }
 return retired;
}
let syncRunning=false,lastSuccessAt:string|null=null,lastError:string|null=null;
interface SyncRow {sourceEnterpriseId:string;companyName:string;sourceRevision:string;sourceStatus:string;syncStatus:'synced'|'quarantined';enterpriseCodes:string[];issues:string[];source:PuEnterpriseSource}
export async function puEnterpriseSyncStatus(ctx:MasterDataContext){
 const all=ctx.access.rules.some(r=>r.kind==='all');
 if(!all)return {enabled:puEnterpriseSyncEnabled(),restricted:true,running:false,lastSuccessAt:null,lastError:null,source:'公共事业管理的填报系统',syncedAt:null,sourceRevision:null,unclassifiedCount:null,departmentCount:null,unresolvedCount:null,synced:null,quarantined:null,rows:[]};
 const store=await readSupportStore(STORE),content=store?.content;
 return {enabled:puEnterpriseSyncEnabled(),restricted:false,running:syncRunning,lastSuccessAt,lastError,source:'公共事业管理的填报系统',syncedAt:content?.syncedAt??null,sourceRevision:store?.revision??0,unclassifiedCount:content?.unclassifiedCount??0,departmentCount:content?.departmentCount??0,unresolvedCount:content?.unresolvedCount??0,synced:content?.rows.filter((r:SyncRow)=>r.syncStatus==='synced').length??0,quarantined:content?.rows.filter((r:SyncRow)=>r.syncStatus==='quarantined').length??0,rows:all?content?.rows.map(({source,...row}:SyncRow)=>row)??[]:[]};
}
export async function syncPuEnterpriseFeed(){
 if(!puEnterpriseSyncEnabled()||syncRunning)return;
 syncRunning=true;
 try{
  assertPuCredentials();let afterId=0,snapshotMaxId:number|undefined,unclassifiedCount=0,departmentCount=0,unresolvedCount=0,complete=false;const sources:PuEnterpriseSource[]=[];
  for(let page=0;page<100;page++){
   const body=serializeOnce({sourceAppCode:'gqxq',requestId:randomUUID(),mode:'real',afterId,limit:50,...(snapshotMaxId===undefined?{}:{snapshotMaxId})});
   const reply=await postIntegrationTask(buildAttempt(body,{endpointPath:'/api/integrations/gqxq/utility-enterprises'}),2*1024*1024);
   if(reply.kind!=='response'||reply.httpStatus!==200)throw new Error('企业签名接口请求失败：'+(reply.kind==='response'?reply.httpStatus:reply.kind));
   let data:any;try{data=JSON.parse(reply.bodyText);}catch{throw new Error('企业来源接口返回无效JSON');}
   data=data.data??data;
   if(!Array.isArray(data.items)||data.items.length>50||!Number.isSafeInteger(data.snapshotMaxId)||!Number.isSafeInteger(data.nextAfterId)||typeof data.hasMore!=='boolean')throw new Error('企业来源分页契约无效');
   if(snapshotMaxId!==undefined&&snapshotMaxId!==data.snapshotMaxId)throw new Error('企业来源分页快照边界变化');
   snapshotMaxId=data.snapshotMaxId;unclassifiedCount=Number(data.unclassifiedCount)||0;departmentCount+=Number(data.departmentCount)||0;unresolvedCount+=Number(data.unresolvedCount)||0;
   for(const raw of data.items){const result=puEnterpriseSchema.safeParse(raw);if(!result.success)throw new Error('企业来源记录字段无效：'+result.error.issues.map(i=>i.path.join('.')).join('、'));const item=result.data;if(item.dataMode!=='real'||item.feedId<=afterId||item.feedId>snapshotMaxId!||sources.some(s=>s.sourceEnterpriseId===item.sourceEnterpriseId))throw new Error('企业来源模式或稳定标识不一致');sources.push(item);}
   if(!data.hasMore){complete=true;break;}
   if(page===99||data.nextAfterId<=afterId||data.nextAfterId>snapshotMaxId!)throw new Error('企业分页游标无效或超过5000条上限');afterId=data.nextAfterId;
  }
  if(!complete)throw new Error('企业完整快照未完成，未更新来源可用状态');
  const rows:SyncRow[]=[];
  for(const source of sources){
   try{const results=await applyPuEnterprise(source);rows.push({sourceEnterpriseId:source.sourceEnterpriseId,companyName:source.companyName,sourceRevision:source.revision,sourceStatus:source.status,syncStatus:'synced',enterpriseCodes:results.map(r=>r.enterpriseCode),issues:[],source});}
   catch(e){rows.push({sourceEnterpriseId:source.sourceEnterpriseId,companyName:source.companyName,sourceRevision:source.revision,sourceStatus:source.status,syncStatus:'quarantined',enterpriseCodes:[],issues:[e instanceof Error?e.message:'企业同步失败'],source});}
  }
  await retireMissingPuEnterprises(sources);
  const current=await readSupportStore(STORE),stable={rows,unclassifiedCount,departmentCount,unresolvedCount};
  if(!current||canonicalUtilitySnapshot(stable)!==canonicalUtilitySnapshot({rows:current.content.rows,unclassifiedCount:current.content.unclassifiedCount,departmentCount:current.content.departmentCount,unresolvedCount:current.content.unresolvedCount??0}))await saveSupportStore(STORE,{...stable,syncedAt:new Date().toISOString()},current?.revision??0,puEnterpriseSystemContext);
  lastSuccessAt=new Date().toISOString();lastError=null;
 }catch(e){lastError=e instanceof Error?e.message:'企业主数据同步失败';console.error('[pu-enterprise-sync]',lastError);}finally{syncRunning=false;}
}
