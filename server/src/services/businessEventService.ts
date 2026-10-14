import {z} from 'zod';
import {pool} from '../db/pool';
import {withTransaction} from '../db/tx';
import {AppError} from '../http/errors';
import {insertAudit} from '../repositories/auditLogRepo';
import {eventRows,eventView,eventScope,readEvent,writeEvent} from '../repositories/sourceBusinessRepo';
import {businessEventKey,parseBusinessEvent,sourceRevision,classifySourceRevision,verifyBusinessSource,isSourceTimestamp} from '../domain/businessEvents';
import type {BusinessEventContext,BusinessEventKind,BusinessSourceConfig,BusinessSourceHeaders} from '../types/businessEvents';

function authorize(ctx:BusinessEventContext,kind:BusinessEventKind){if(!ctx.permissionCodes.includes(kind==='shutdown'?'shutdown.read':kind==='pipeline'?'pipeline.read':'complaint.read'))throw AppError.forbidden();}
const querySchema=z.object({page:z.coerce.number().int().min(1).default(1),size:z.coerce.number().int().min(1).max(100).default(20),search:z.string().trim().max(128).optional(),businessType:z.enum(['water','gas']).optional(),approvalState:z.enum(['pending','approved','rejected','cancelled','unknown']).optional(),state:z.enum(['planned','active','ended','cancelled','unknown']).optional(),from:z.string().refine(isSourceTimestamp).optional(),to:z.string().refine(isSourceTimestamp).optional(),complaintId:z.string().max(64).optional()}).strict();
export class BusinessEventService {
 async receive(raw:Buffer,headers:BusinessSourceHeaders,configs:BusinessSourceConfig[],clientIp:string|null,clock=new Date()){
  const config=configs.find(c=>c.sourceId===headers.sourceId);if(!config||!verifyBusinessSource(raw,headers,config,clock))throw AppError.unauthenticated('来源签名无效或未配置');
  let body:unknown;try{body=JSON.parse(raw.toString('utf8'));}catch{throw AppError.validation('JSON 无效');}
  const input=parseBusinessEvent(body);if(input.sourceId!==headers.sourceId)throw AppError.unauthenticated('正文来源与签名不一致');
  const id=businessEventKey(input),revision=sourceRevision(input);
  return withTransaction(async tx=>{
   // Insert the unique identity first. Concurrent initial deliveries serialize on this row.
   await tx.execute('insert ignore into source_business_head(event_id,source_id,kind,source_object_id,source_version,enterprise_code,district_code,payload_hash,content,received_at) values(?,?,?,?,?,?,?,?,?,?)',[id,input.sourceId,input.kind,input.sourceObjectId,0,input.enterpriseCode,input.districtCode,'',JSON.stringify(input),clock]);
   const current=await readEvent(tx,id,true);const result=classifySourceRevision(current?.payloadHash?{sourceId:current.sourceId,kind:current.kind,sourceObjectId:current.sourceObjectId,sourceVersion:current.sourceVersion,payloadHash:current.payloadHash}:null,revision);
   if(result==='new')await writeEvent(tx,input,id,revision.payloadHash,clock);
   await insertAudit(tx,{userId:null,appCode:'gqxq',resourceCode:'business.source',action:'SOURCE_BUSINESS_RECEIVE',bizType:'source_business',bizId:id,result:result==='new'?'success':result==='duplicate'?'duplicate':'rejected',clientIp,detail:{sourceId:input.sourceId,kind:input.kind,sourceVersion:input.sourceVersion,result},createdAt:clock});
   return {id,result,sourceVersion:result==='new'?input.sourceVersion:current!.sourceVersion};
  });
 }
 async list(kind:BusinessEventKind,raw:unknown,ctx:BusinessEventContext){
  authorize(ctx,kind);const parsed=querySchema.safeParse(raw);if(!parsed.success)throw AppError.validation('查询参数无效');const q=parsed.data;if(q.from&&q.to&&Date.parse(q.from)>Date.parse(q.to))throw AppError.validation('时间范围无效');
  const scope=eventScope(ctx.access),clauses=['e.kind=?',scope.sql],params:unknown[]=[kind,...scope.params];
  for(const [value,path] of [[q.businessType,'businessType'],[q.approvalState,'approvalState'],[q.state,'state'],[q.complaintId,'complaintId']] as const)if(value){clauses.push("json_unquote(json_extract(e.content,'$.payload."+path+"'))=?");params.push(value);}
  if(q.search){clauses.push("(e.source_object_id like ? or json_unquote(json_extract(e.content,'$.payload.title')) like ?)");params.push('%'+q.search+'%','%'+q.search+'%');}
  if(q.from){clauses.push('e.received_at>=?');params.push(new Date(q.from));}if(q.to){clauses.push('e.received_at<=?');params.push(new Date(q.to));}
  const where=clauses.join(' and ');const count=await eventRows(pool,'select count(*) as n from source_business_head e where '+where,params);
  const rows=await eventRows(pool,'select e.event_id,e.content,e.payload_hash,e.received_at from source_business_head e where '+where+' order by e.received_at desc,e.event_id limit ? offset ?',[...params,q.size,(q.page-1)*q.size]);const total=Number(count[0].n);
  return {content:rows.map(eventView),total,page:q.page,size:q.size,totalPages:Math.ceil(total/q.size)};
 }
 async detail(kind:BusinessEventKind,id:string,ctx:BusinessEventContext){authorize(ctx,kind);const scope=eventScope(ctx.access);const rows=await eventRows(pool,'select e.event_id,e.content,e.payload_hash,e.received_at from source_business_head e where e.event_id=? and e.kind=? and '+scope.sql,[id,kind,...scope.params]);if(!rows[0])throw AppError.notFound('来源记录不存在');const history=await eventRows(pool,'select event_id,content,payload_hash,received_at from source_business_revision where event_id=? order by source_version desc',[id]);return {...eventView(rows[0]),history:history.map(eventView)};}
}
export const businessEventService=new BusinessEventService();
