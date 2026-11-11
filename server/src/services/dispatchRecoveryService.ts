import {runAsTrustedSystem,assertLockedComplaintAccess} from '../auth/accessScope';
import {env} from '../config/env';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {findOrderByAssignmentId} from '../repositories/dispatchRepo';
import {claimOutbox,dueRequests,readOutbox,ownsLease,canRecoverUnknown,type OutboxRow} from '../repositories/dispatchOutboxRepo';
import {insertRequestLog} from '../repositories/dispatchRequestLogRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {dispatchRecoveryTransport,currentTransportIdentity,type RecoveryTransport,type PuTransportOutcome,type SerializedBody} from '../clients/publicUtilityClient';
import {restoreSnapshot,validatePushIdentity,classifyOutcome} from './dispatchPushService';
import {applyPushSuccessInTx} from './dispatchService';
import {reconcilePendingEvents} from './callbackService';
import type {DeliveryState,PushResultKind} from '../types/api';
import {AppError} from '../http/errors';

export interface RecoveryOutcome {state:DeliveryState|'busy'|'missing';taskId:string|null;reason:string}
interface LockedDelivery {status:string;taskId:string|null;bytes:SerializedBody;active:boolean}
/** Server-owned execution of an already authenticated, scoped, immutable intent.
 * No user route calls this function or acquires its trusted worker context. */
export async function recoverDispatch(requestId:string,transport:RecoveryTransport=dispatchRecoveryTransport):Promise<RecoveryOutcome>{
 const leaseMs=Math.max(60_000,env.pu.timeoutMs*3);const claim=await claimOutbox(requestId,leaseMs);
 if(!claim){const existing=await readOutbox(pool,requestId);return {state:existing?.state??'missing',taskId:existing?.task_id??null,reason:existing?.state==='sending'?'busy':'settled'};}
 return runAsTrustedSystem(async()=>{
  // The claim transaction has committed before taking any business lock.
  let checkpoint:LockedDelivery|null;
  try{checkpoint=await withTransaction(tx=>lockDelivery(tx,claim));}
  catch{await settleOrphan(claim);return {state:'unknown',taskId:null,reason:'binding_unavailable'};}
  if(!checkpoint)return {state:'busy',taskId:null,reason:'lease_lost'};
  let targetMatches=false;try{targetMatches=claim.transport_identity===currentTransportIdentity();}catch{}
  if(!targetMatches)return complete(claim,'unknown',null,'TARGET_CHANGED',null,null);
  if(checkpoint.taskId)return complete(claim,'succeeded',checkpoint.taskId,null,null,null);
  if(!checkpoint.active)return complete(claim,claim.has_unknown?'unknown':'failed',null,'DISPATCH_INACTIVE',null,null);
  if(claim.has_unknown){
   const lookup=await transport.queryByRequestId(claim.request_id).catch(()=>({kind:'unknown' as const}));
   if(lookup.kind==='found'){
    if(lookup.requestId!==claim.request_id||lookup.assignmentId!==claim.assignment_id||lookup.sourceBusinessId!==claim.complaint_id||lookup.sourceAppCode!==env.pu.appCode||lookup.payloadHash!==claim.payload_hash||!lookup.taskId.trim())return complete(claim,'unknown',null,'LOOKUP_BINDING_MISMATCH',null,null);
    return complete(claim,'succeeded',lookup.taskId,null,null,null);
   }
   // Even a "missing" lookup can mean delayed visibility, never permission to invent a new request.
   if(claim.recovery_mode!=='same-body-idempotent'||!claim.contract_version||env.pu.recoveryMode!=='same-body-idempotent'||claim.contract_version!==env.pu.recoveryContractVersion)return complete(claim,'unknown',null,lookup.kind==='unsupported'?'LOOKUP_UNSUPPORTED':'MANUAL_VERIFICATION',null,null);
  }
  // Cancellation before this checkpoint prevents a new send. Cancellation after it can race
  // with the unlocked HTTP; any late result remains linked to this historical assignment.
  const fresh=await withTransaction(tx=>lockDelivery(tx,claim));if(!fresh)return {state:'busy',taskId:null,reason:'lease_lost'};
  if(fresh.taskId)return complete(claim,'succeeded',fresh.taskId,null,null,null);
  if(!fresh.active)return complete(claim,claim.has_unknown?'unknown':'failed',null,'DISPATCH_INACTIVE',null,null);
  try{if(claim.transport_identity!==currentTransportIdentity())return complete(claim,'unknown',null,'TARGET_CHANGED',null,null);}catch{return complete(claim,'unknown',null,'TARGET_CHANGED',null,null);}
  const startedAt=new Date();let outcome:PuTransportOutcome;
  try{outcome=await transport.sendExact(fresh.bytes);}catch{outcome={kind:'network_error',message:'transport interrupted'};}
  const classified=classifyOutcome(outcome);
  const ambiguous=outcome.kind!=='response'||outcome.httpStatus>=500||classified.result==='unknown';
  const state:DeliveryState=classified.taskId?'succeeded':ambiguous||claim.has_unknown?'unknown':classified.result==='replay'&&claim.attempts<3?'pending':'failed';
  return complete(claim,state,classified.taskId,classified.errorCode,outcome,startedAt);
 });
}

/** Normal lock order, exact binding; job/token lock is LAST, never claim -> complaint. */
async function lockDelivery(tx:Tx,claim:OutboxRow):Promise<LockedDelivery|null>{
 const hint=await findOrderByAssignmentId(tx,claim.assignment_id);
 if(!hint||String(hint.complaint_id)!==claim.complaint_id)throw AppError.notFound('交办关联不可用');
 await assertLockedComplaintAccess(tx,claim.complaint_id);
 const [orders]=await tx.query('select complaint_id,request_id,status,target_enterprise_code,reporting_task_id,active_complaint_id from dispatch_order where assignment_id=? for update',[claim.assignment_id]) as [Array<Record<string,unknown>>,unknown];const order=orders[0];
 if(!order||String(order.complaint_id)!==claim.complaint_id||String(order.request_id)!==claim.request_id)throw AppError.conflict('交办绑定已变化');
 const [snapshots]=await tx.query('select request_id,body,sha256 from dispatch_push_snapshot where assignment_id=?',[claim.assignment_id]) as [Array<{request_id:string;body:string;sha256:string}>,unknown];const snapshot=snapshots[0];
 if(!snapshot||snapshot.request_id!==claim.request_id||snapshot.sha256!==claim.payload_hash)throw AppError.conflict('持久请求绑定不一致');
 const bytes=restoreSnapshot(snapshot.body,snapshot.sha256);validatePushIdentity(bytes,claim.assignment_id,claim.complaint_id,claim.request_id,String(order.target_enterprise_code));
 const job=await readOutbox(tx,claim.request_id,true);if(!ownsLease(job,claim))return null;
 return {status:String(order.status),taskId:order.reporting_task_id==null?null:String(order.reporting_task_id),bytes,active:['pending','pushed','accepted','processing','returned'].includes(String(order.status))&&String(order.active_complaint_id)===claim.complaint_id};
}

async function complete(claim:OutboxRow,state:DeliveryState,taskId:string|null,errorCode:string|null,transport:PuTransportOutcome|null,startedAt:Date|null):Promise<RecoveryOutcome>{
 const result=await withTransaction(async tx=>{
  const locked=await lockDelivery(tx,claim);if(!locked)return {state:'busy' as const,taskId:null,reason:'lease_lost'};
  if(taskId&&locked.taskId&&taskId!==locked.taskId)throw AppError.conflict('填报任务绑定冲突');
  if(locked.taskId){taskId=locked.taskId;state='succeeded';}
  const at=new Date();const classified=transport?classifyOutcome(transport):null;
  const resultKind:PushResultKind=state==='succeeded'?'success':state==='unknown'?'unknown':classified?.result??'validation_failed';
  if(transport&&startedAt)await insertRequestLog(tx,{assignmentId:claim.assignment_id,complaintId:claim.complaint_id,requestId:claim.request_id,endpoint:JSON.parse(claim.transport_identity).path,nonce:null,signature:null,httpStatus:classified?.httpStatus??null,result:resultKind,errorCode,errorMessage:null,taskId,requestBody:locked.bytes.bodyText,responseBody:transport.kind==='response'?transport.bodyText:null,startedAt,finishedAt:at});
  if(state==='succeeded'&&taskId)await applyPushSuccessInTx(tx,claim.assignment_id,claim.complaint_id,locked.status,taskId,at);
  else await tx.execute('update dispatch_order set sync_status=?,updated_at=? where assignment_id=?',[state==='unknown'?'unknown':state==='pending'?'pending':'failed',at,claim.assignment_id]);
  const auto=state==='unknown'&&canRecoverUnknown({...claim,state:'unknown'});
  const next=state==='pending'||auto?new Date(at.getTime()+30_000):null;
  await tx.execute('update dispatch_outbox set state=?,has_unknown=?,next_attempt_at=?,lease_token=null,lease_expires_at=null,last_result=?,last_http_status=?,last_error_code=?,task_id=?,updated_at=? where request_id=? and lease_token=?',[state,state==='unknown'||claim.has_unknown?1:0,next,resultKind,classified?.httpStatus??null,errorCode,taskId,at,claim.request_id,claim.lease_token]);
  await insertAudit(tx,{userId:claim.initiator_id,appCode:'gqxq',resourceCode:claim.assignment_id,action:'DISPATCH_PUSH',bizType:'dispatch_order',bizId:claim.complaint_id,result:state==='succeeded'?'success':state==='unknown'?'unknown':state==='pending'?'pending':'failed',clientIp:claim.client_ip,createdAt:at,detail:{assignmentId:claim.assignment_id,complaintId:claim.complaint_id,taskId,stage:'delivery',deliveryState:state,attempts:Number(claim.attempts),scopeVersion:Number(claim.scope_version),authorizationVersion:Number(claim.authorization_version)}});
  return {state,taskId,reason:errorCode??state};
 });
 if(result.state==='succeeded'&&taskId)await reconcilePendingEvents(taskId).catch(()=>undefined);
 return result;
}
/** No business-row mutation when exact ownership cannot be resolved. */
async function settleOrphan(claim:OutboxRow):Promise<void>{await withTransaction(async tx=>{
 const job=await readOutbox(tx,claim.request_id,true);if(!ownsLease(job,claim))return;
 await tx.execute("update dispatch_outbox set state='unknown',has_unknown=1,last_result='unknown',last_error_code='BINDING_UNAVAILABLE',lease_token=null,lease_expires_at=null,next_attempt_at=null,updated_at=? where request_id=?",[new Date(),claim.request_id]);
});}
export async function recoverPendingDispatches():Promise<void>{
 if(!env.pu.deliveryWorkerEnabled)return;
 for(const requestId of await dueRequests()){try{await recoverDispatch(requestId);}catch{console.error('[delivery] result retained for lease recovery');}}
}
