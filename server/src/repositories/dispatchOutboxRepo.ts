import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {toIso} from './complaintMapper';
import type {DispatchOutboxItem,DeliveryState,PushResultKind} from '../types/api';
import {currentScopeSql} from '../auth/accessScope';
import {currentTransportIdentity} from '../clients/publicUtilityClient';
export interface OutboxRow {
 request_id:string;assignment_id:string;complaint_id:string;payload_hash:string;transport_identity:string;
 recovery_mode:string;contract_version:string;state:DeliveryState;attempts:number;has_unknown:number;
 next_attempt_at:Date|null;lease_token:string|null;lease_expires_at:Date|null;initiator_id:string;initiator_name:string|null;
 client_ip:string|null;scope_version:number;authorization_version:number;last_result:PushResultKind|null;last_http_status:number|null;last_error_code:string|null;task_id:string|null;
}
const columns='request_id,assignment_id,complaint_id,payload_hash,transport_identity,recovery_mode,contract_version,state,attempts,has_unknown,next_attempt_at,lease_token,lease_expires_at,initiator_id,initiator_name,client_ip,scope_version,authorization_version,last_result,last_http_status,last_error_code,task_id';
export async function readOutbox(db:Tx|typeof pool,requestId:string,lock=false):Promise<OutboxRow|null>{
 const [rows]=await db.query('select '+columns+' from dispatch_outbox where request_id=?'+(lock?' for update':''),[requestId]) as [OutboxRow[],unknown];return rows[0]??null;
}
export function projectOutbox(row:OutboxRow):DispatchOutboxItem {return {requestId:row.request_id,assignmentId:row.assignment_id,payloadHash:row.payload_hash,state:row.state,attempts:Number(row.attempts),nextAttemptAt:toIso(row.next_attempt_at)};}
export function canRecoverUnknown(row:OutboxRow):boolean {
 try{return row.state==='unknown'&&row.recovery_mode==='same-body-idempotent'&&!!row.contract_version&&row.transport_identity===currentTransportIdentity();}catch{return false;}
}
/** User DTO always joins CURRENT complaint scope; no worker identity is involved. */
export async function deliveryViews(ids:string[]):Promise<Map<string,{deliveryState:DeliveryState;deliveryAttempts:number;deliveryNextAttemptAt:string|null;deliveryRetryAllowed:boolean}>>{
 if(!ids.length)return new Map();const scope=currentScopeSql('c');
 const [rows]=await pool.query('select '+columns.split(',').map(c=>'o.'+c).join(',')+' from dispatch_outbox o join dispatch_order d on d.assignment_id=o.assignment_id and d.request_id=o.request_id join complaint c on c.complaint_id=d.complaint_id where o.assignment_id in ('+ids.map(()=>'?').join(',')+') and '+scope.sql,[...ids,...scope.params]) as [OutboxRow[],unknown];
 return new Map(rows.map(r=>[r.assignment_id,{deliveryState:r.state,deliveryAttempts:Number(r.attempts),deliveryNextAttemptAt:toIso(r.next_attempt_at),deliveryRetryAllowed:canRecoverUnknown(r)}]));
}
export async function enqueueInTx(tx:Tx,row:Omit<OutboxRow,'state'|'attempts'|'has_unknown'|'next_attempt_at'|'lease_token'|'lease_expires_at'|'last_result'|'last_http_status'|'last_error_code'|'task_id'>,legacyUnknown:boolean):Promise<OutboxRow>{
 const existing=await readOutbox(tx,row.request_id,true);
 if(existing){if(existing.assignment_id!==row.assignment_id||existing.complaint_id!==row.complaint_id||existing.payload_hash!==row.payload_hash)throw AppError.conflict('原请求号、交办与不可变报文不一致');return existing;}
 const now=new Date();
 await tx.execute('insert into dispatch_outbox(request_id,assignment_id,complaint_id,payload_hash,transport_identity,recovery_mode,contract_version,state,attempts,has_unknown,next_attempt_at,initiator_id,initiator_name,client_ip,scope_version,authorization_version,created_at,updated_at) values(?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)',[
 row.request_id,row.assignment_id,row.complaint_id,row.payload_hash,row.transport_identity,row.recovery_mode,row.contract_version,legacyUnknown?'unknown':'pending',legacyUnknown?1:0,legacyUnknown?null:now,row.initiator_id,row.initiator_name,row.client_ip,row.scope_version,row.authorization_version,now,now]);
 return (await readOutbox(tx,row.request_id))!;
}
/** Only job locks here, committed before any business-object lock or HTTP. */
export async function claimOutbox(requestId:string,leaseMs:number):Promise<OutboxRow|null>{return withTransaction(async tx=>{
 const row=await readOutbox(tx,requestId,true);if(!row)return null;
 const now=new Date();
 if(row.state==='sending'){
  if(row.lease_expires_at&&row.lease_expires_at.getTime()>now.getTime())return null;
  await tx.execute("update dispatch_outbox set state='unknown',has_unknown=1,next_attempt_at=null,lease_token=null,lease_expires_at=null,last_result='unknown',updated_at=? where request_id=?",[now,requestId]);
  row.state='unknown';row.has_unknown=1;
 }
 if(!['pending','unknown'].includes(row.state))return null;
 if(row.next_attempt_at&&row.next_attempt_at.getTime()>now.getTime())return null;
 const token=randomUUID();const expires=new Date(now.getTime()+leaseMs);
 await tx.execute("update dispatch_outbox set state='sending',lease_token=?,lease_expires_at=?,attempts=attempts+1,updated_at=? where request_id=?",[token,expires,now,requestId]);
 return {...row,state:'sending',lease_token:token,lease_expires_at:expires,attempts:Number(row.attempts)+1};
});}
export function ownsLease(row:OutboxRow|null,claim:OutboxRow):boolean{return !!row&&row.state==='sending'&&row.lease_token===claim.lease_token&&!!row.lease_expires_at&&row.lease_expires_at.getTime()>Date.now();}
export async function dueRequests(limit=25):Promise<string[]>{
 const [rows]=await pool.query("select o.request_id from dispatch_outbox o left join dispatch_order d on d.assignment_id=o.assignment_id where (o.state='pending' and (o.next_attempt_at is null or o.next_attempt_at<=?)) or (o.state='sending' and o.lease_expires_at<=?) or (o.state='unknown' and ((o.next_attempt_at is not null and o.next_attempt_at<=?) or d.reporting_task_id is not null)) order by o.updated_at limit ?",[new Date(),new Date(),new Date(),limit]) as [Array<{request_id:string}>,unknown];return rows.map(r=>r.request_id);
}
