import {createHash} from 'node:crypto';
import {verifyBusinessSource} from '../domain/businessEvents';
import {parseSourceProcessDelivery} from '../domain/sourceProcess';
import type {BusinessSourceConfig,BusinessSourceHeaders} from '../types/businessEvents';
import {AppError} from '../http/errors';
import {withTransaction} from '../db/tx';
import {runAsTrustedSystem} from '../auth/accessScope';
import {rowsIn} from '../repositories/serviceGridRepo';
import {saveSourceProcessInTx} from '../repositories/sourceProcessRepo';
import {insertAudit} from '../repositories/auditLogRepo';

/** Signed full/partial push snapshot. No guessed upstream fetch endpoint or user write action. */
export async function receiveSourceProcesses(raw:Buffer,headers:BusinessSourceHeaders,configs:BusinessSourceConfig[],clientIp:string|null,clock=new Date()){
 const config=configs.find(c=>c.sourceId===headers.sourceId);
 if(!config||!verifyBusinessSource(raw,headers,config,clock))throw AppError.unauthenticated('来源签名无效或未配置');
 let body:unknown;try{body=JSON.parse(raw.toString('utf8'));}catch{throw AppError.validation('JSON 无效');}
 if(!config.sourceSystem)throw AppError.unauthenticated('来源过程业务来源映射未配置');
 const input=parseSourceProcessDelivery(body,config.sourceSystem),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 return runAsTrustedSystem(()=>withTransaction(async tx=>{
  const complaints=await rowsIn(tx,'select complaint_id from complaint where source_system=? and source_id=? and coalesce(deleted,0)=0 for update',[input.sourceSystem,input.sourceId]);
  if(complaints.length!==1)throw AppError.notFound('来源案件未接收或标识不唯一');
  const complaintId=String(complaints[0].complaint_id),stream=(await rowsIn(tx,'select version,ingress_version,ingress_hash from source_process_stream where complaint_id=? for update',[complaintId]))[0];
  if(stream?.ingress_version!=null){
   if(input.sourceVersion<Number(stream.ingress_version))return {complaintId,result:'stale'};
   if(input.sourceVersion===Number(stream.ingress_version)){
    if(hash!==stream.ingress_hash)throw AppError.conflict('同一来源快照版本包含不同内容');
    return {complaintId,result:'duplicate'};
   }
  }
  await saveSourceProcessInTx(tx,{complaintId,sourceSystem:input.sourceSystem,sourceId:input.sourceId},Number(stream?.version??0),input.nodes,input.complete?'complete':'partial',input.cutoffAt,null);
  await tx.execute('update source_process_stream set ingress_version=?,ingress_hash=? where complaint_id=?',[input.sourceVersion,hash,complaintId]);
  await tx.execute('update complaint set source_deadline_at=?,source_completed_at=?,source_process_received_at=? where complaint_id=?',[input.deadlineAt===null?null:new Date(input.deadlineAt),input.completedAt===null?null:new Date(input.completedAt),clock,complaintId]);
  await insertAudit(tx,{userId:null,appCode:'gqxq',resourceCode:'business.source',action:'SOURCE_PROCESS_RECEIVE',bizType:'complaint',bizId:complaintId,result:'success',clientIp,detail:{sourceSystem:input.sourceSystem,sourceVersion:input.sourceVersion,sourceId:input.sourceId,deadlineAt:input.deadlineAt,completedAt:input.completedAt,cutoffAt:input.cutoffAt,payloadHash:hash,nodeCount:input.nodes.length,complete:input.complete},createdAt:clock});
  return {complaintId,result:'updated',sourceVersion:input.sourceVersion};
 }));
}
