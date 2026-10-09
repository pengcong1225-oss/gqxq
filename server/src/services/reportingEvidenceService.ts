import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { AppError } from '../http/errors';
import { env } from '../config/env';
import { findOrderByAssignmentId } from '../repositories/dispatchRepo';
import { assertPuCredentials,buildAttempt,serializeOnce,postIntegrationTask,PU_HEADERS,lowercaseHexSha256 } from '../clients/publicUtilityClient';
import { validateEvent, relationError, reconcilePendingEvents,resolveAckBody,payloadDigest } from './callbackService';
import { withTransaction } from '../db/tx';
import { findEventById,insertBusinessEvent,updateEventProcessing } from '../repositories/businessEventRepo';

export async function reportingResult(assignmentId:string){
 const order=await findOrderByAssignmentId(pool,assignmentId);if(!order)throw AppError.notFound('交办不存在');
 const [rows]=await pool.query("select event_id as eventId,processed_result as state,processed_message as message,payload from business_event where task_id=? and source_business_id=? order by occurred_at,id",[order.reporting_task_id,order.complaint_id]) as [Array<{eventId:string;state:string;message:string;payload:unknown}>,unknown];
 return {assignmentId,taskId:order.reporting_task_id,events:rows.map(row=>({...row,payload:typeof row.payload==='string'?JSON.parse(row.payload):row.payload})),taskUrl:env.pu.baseUrl?env.pu.baseUrl.replace(/\/+$/,'')+'/mobile/tasks/'+encodeURIComponent(String(order.reporting_task_id)):null};
}
async function queryContext(assignmentId:string){
 assertPuCredentials();
 const order=await findOrderByAssignmentId(pool,assignmentId);if(!order||!order.reporting_task_id)throw AppError.notFound('填报任务关联尚未建立');
 return {order,payload:{sourceAppCode:env.pu.appCode,requestId:'query:'+randomUUID(),taskId:Number(order.reporting_task_id),sourceRequestId:String(order.request_id)}};
}
export async function reportingAttachment(assignmentId:string,attachmentId:string){
 const result=await reportingResult(assignmentId);
 const events=result.events.filter(row=>row.state==='applied').map(row=>row.payload as Record<string,unknown>);
 const match=events.flatMap(e=>Array.isArray(e.attachments)?e.attachments.map(a=>({attachment:a as Record<string,unknown>,version:e.submissionVersion})):[]).find(a=>String(a.attachment.attachmentId)===attachmentId);
 if(!match)throw AppError.notFound('附件不属于本交办的已接收提交版本');
 const {payload}=await queryContext(assignmentId);
 const attempt=buildAttempt(serializeOnce({...payload,attachmentId:Number(attachmentId),submissionVersion:match.version}),{endpointPath:'/api/integrations/'+env.pu.appCode+'/tasks/attachment'});
 const response=await fetch(new URL(env.pu.baseUrl).origin+attempt.path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(env.pu.timeoutMs),headers:{'Content-Type':'application/json',[PU_HEADERS.keyId]:env.pu.keyId,[PU_HEADERS.timestamp]:attempt.timestamp,[PU_HEADERS.nonce]:attempt.nonce,[PU_HEADERS.signature]:attempt.signature},body:attempt.bodyBytes});
 if(!response.ok)throw AppError.internal('签名附件取件失败，状态 '+response.status);
 const expected=Number(match.attachment.size);if(!Number.isSafeInteger(expected)||expected<0||expected>20*1024*1024)throw AppError.internal('attachment size invalid');
 const reader=response.body?.getReader();if(!reader)throw AppError.internal('attachment response empty');let size=0;const chunks:Buffer[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>expected)throw AppError.internal('attachment size mismatch');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel();}
 const bytes=Buffer.concat(chunks);if(size!==expected||lowercaseHexSha256(bytes)!==String(match.attachment.sha256).toLowerCase())throw AppError.internal('attachment digest mismatch');
 return {bytes,fileName:String(match.attachment.fileName),contentType:String(match.attachment.contentType)};
}
type StatePage={taskId:unknown;events:unknown[];hasMore?:boolean;nextCursor?:string;snapshotEventId?:string;maxPageSize?:number};
export async function* fetchStatePages(payload:Record<string,unknown>,fetchPage:(payload:Record<string,unknown>)=>Promise<StatePage>){
 let cursor=String(payload.afterEventId??'0'),snapshot:string|undefined;
 for(let count=0;count<10000;count++){
  const page=await fetchPage({...payload,requestId:'state:'+randomUUID(),afterEventId:cursor,pageSize:100,...(snapshot===undefined?{}:{snapshotEventId:snapshot})});
  if(String(page.taskId)!==String(payload.taskId)||!Array.isArray(page.events)||page.events.length>(page.hasMore===undefined?500:100))throw AppError.internal('invalid reconciliation page');
  if(page.hasMore===undefined){yield page;return;}
  if(typeof page.hasMore!=='boolean'||typeof page.nextCursor!=='string'||!/^\d{1,19}$/.test(page.nextCursor)||typeof page.snapshotEventId!=='string'||!/^\d{1,19}$/.test(page.snapshotEventId)||page.maxPageSize!==100)throw AppError.internal('invalid state cursor envelope');
  if(snapshot!==undefined&&snapshot!==page.snapshotEventId)throw AppError.internal('state snapshot cursor changed');snapshot=page.snapshotEventId;
  if(BigInt(page.nextCursor)<BigInt(cursor)||BigInt(page.nextCursor)>BigInt(snapshot)||(page.events.length>0&&BigInt(page.nextCursor)<=BigInt(cursor))||(page.hasMore&&page.events.length===0))throw AppError.internal('state cursor failed to advance');
  yield page;cursor=page.nextCursor;if(!page.hasMore)return;
 }
 throw AppError.internal('state page budget exhausted; stored recovery cursor retained');
}
export async function reconcileReporting(assignmentId:string){
 const {order,payload}=await queryContext(assignmentId);
 const [cursors]=await pool.query('select last_reconciled_event_id as lastEventId from dispatch_order where assignment_id=?',[assignmentId]) as [Array<{lastEventId:string}>,unknown];
 const pages=fetchStatePages({...payload,afterEventId:cursors[0]?.lastEventId??'0'},async pageQuery=>{
 const outcome=await postIntegrationTask(buildAttempt(serializeOnce(pageQuery),{endpointPath:'/api/integrations/'+env.pu.appCode+'/tasks/state'}),2*1024*1024);
 if(outcome.kind!=='response'||outcome.httpStatus!==200)throw AppError.internal('签名状态对账失败'+(outcome.kind==='response'?' HTTP '+outcome.httpStatus:''));
 return JSON.parse(outcome.bodyText) as StatePage;});
 let recovered=0,applied=0;
 for await(const state of pages){
 for(const raw of state.events){const parsed=validateEvent(raw);if(!parsed.ok)throw AppError.internal('invalid reconciliation event');const event=parsed.event;
  const mismatch=relationError(event,{assignmentId,complaintId:String(order.complaint_id),status:String(order.status),requestId:String(order.request_id),subjectCode:String(order.target_enterprise_code),taskId:String(order.reporting_task_id),lastEventSequence:0,reportingItemId:null});if(mismatch)throw AppError.internal(mismatch);
  await withTransaction(async tx=>{const existing=await findEventById(tx,event.eventId);if(existing){const stored=typeof existing.payload==='string'?JSON.parse(existing.payload):existing.payload;if(payloadDigest(stored)!==payloadDigest(raw))throw AppError.conflict('同一事件标识的不可变内容不一致');if(existing.processedResult==='ignored'&&event.contractVersion===1&&['task_approved','task_rejected'].includes(event.eventType)&&['pushed','accepted','processing','returned'].includes(String(order.status)))await updateEventProcessing(tx,event.eventId,'pending','reconcile trusted legacy final event');return;}await insertBusinessEvent(tx,{eventId:event.eventId,eventType:event.eventType,sourceAppCode:event.sourceAppCode,sourceBusinessId:event.sourceBusinessId,taskId:event.taskId,sceneCode:event.sceneCode,subjectCode:event.subjectCode,subjectName:event.subjectName,approvalConclusion:event.approvalConclusion,templateVersion:event.templateVersion,submissionVersion:event.submissionVersion,occurredAt:event.occurredAt,approvedAt:event.approvedAt,payload:raw as Record<string,unknown>,signatureKeyId:null,signatureKeyVersion:null,processedResult:'pending',processedMessage:'recovered by authorized signed query',ackBody:resolveAckBody().ackBody,receivedAt:new Date()});recovered++;});
 }
 applied+=await reconcilePendingEvents(String(order.reporting_task_id));
 if(state.nextCursor!==undefined)await pool.execute("update dispatch_order set last_reconciled_event_id=GREATEST(CAST(last_reconciled_event_id AS UNSIGNED),CAST(? AS UNSIGNED)) where assignment_id=?",[state.nextCursor,assignmentId]);
 }
 return {recovered,applied};
}

export async function reconcileOpenReporting():Promise<void>{
 if(!env.pu.reconciliationEnabled)return;
 assertPuCredentials();
 const [rows]=await pool.query("select assignment_id as assignmentId from dispatch_order where reporting_task_id is not null and status in ('pushed','accepted','processing','returned') order by coalesce(last_reconciled_at,created_at) limit 25") as [Array<{assignmentId:string}>,unknown];
 for(const row of rows){try{await reconcileReporting(row.assignmentId);}catch{console.error('[integration] signed reconciliation failed; object retained for next scan');}finally{await pool.execute('update dispatch_order set last_reconciled_at=? where assignment_id=?',[new Date(),row.assignmentId]);}}
}
