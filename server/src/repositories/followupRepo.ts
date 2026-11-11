import type {Tx} from '../db/tx';
import type {SqlExecutor} from './userRepo';
import type {AccessContext} from '../auth/accessScope';
import {buildComplaintScopeSql,assertComplaintAccess} from '../auth/accessScope';
import type {FollowupView} from '../types/api';
import {AppError} from '../http/errors';
import {toIso} from './complaintMapper';
export interface FollowupHeader {followupId:string;complaintId:string;ownerId:string;version:number;order:number;createdAt:string}
const hColumns='h.id,h.followup_id,h.complaint_id,h.owner_id,h.current_version,h.created_at';
const rColumns='r.version,r.contacted,r.occurred_at,r.evaluation_code,r.dissatisfaction_reason,r.notes,r.conclusion,r.concluded_by,r.concluded_at,r.action,r.operator_id,r.operator_name,r.reason,r.revised_at';
const nullable=(v:unknown)=>v==null?null:String(v);
function header(r:Record<string,unknown>):FollowupHeader {return {followupId:String(r.followup_id),complaintId:String(r.complaint_id),ownerId:String(r.owner_id),version:Number(r.current_version),order:Number(r.id),createdAt:toIso(r.created_at)!};}
function view(r:Record<string,unknown>):FollowupView {return {...header(r),version:Number(r.version),contacted:Number(r.contacted)===1,occurredAt:toIso(r.occurred_at)!,evaluationCode:r.evaluation_code as FollowupView['evaluationCode'],dissatisfactionReason:nullable(r.dissatisfaction_reason),notes:nullable(r.notes),conclusion:nullable(r.conclusion),concludedBy:nullable(r.concluded_by),concludedAt:toIso(r.concluded_at),action:r.action as FollowupView['action'],operatorId:String(r.operator_id),operatorName:String(r.operator_name),reason:nullable(r.reason),revisedAt:toIso(r.revised_at)!};}
/** Minimal locked canonical identity avoids rereading protected/source-wide detail DTOs. */
export async function lockComplaint(tx:Tx,idOrNo:string,access:AccessContext):Promise<Record<string,unknown>> {
 if(!idOrNo||idOrNo.length>128)throw AppError.validation('诉求标识不合法');
 const numeric=/^\d+$/.test(idOrNo);if(numeric&&!Number.isSafeInteger(Number(idOrNo)))throw AppError.validation('诉求标识不合法');
 const [rows]=await tx.query('select c.complaint_id,c.complaint_no,c.enterprise_code,c.district_code,c.deleted,c.source_payload from complaint c where '+(numeric?'c.id=?':'(c.complaint_id=? or c.complaint_no=?)')+' limit 1 for update',numeric?[Number(idOrNo)]:[idOrNo,idOrNo]) as [Array<Record<string,unknown>>,unknown];
 const row=rows[0];if(!row)throw AppError.notFound('诉求不存在或不在授权范围内');assertComplaintAccess(row,access);return row;
}
export async function readHeader(db:SqlExecutor,followupId:string,access:AccessContext,lock=false):Promise<FollowupHeader> {
 const scope=buildComplaintScopeSql(access,'c');const [rows]=await db.query('select '+hColumns+' from manual_followup h join complaint c on c.complaint_id=h.complaint_id where h.followup_id=? and '+scope.sql+(lock?' for update':''),[followupId,...scope.params]) as [Array<Record<string,unknown>>,unknown];
 if(!rows[0])throw AppError.notFound('回访不存在或不在授权范围内');return header(rows[0]);
}
export async function readRevision(db:SqlExecutor,followupId:string,version:number,access:AccessContext):Promise<FollowupView> {
 const scope=buildComplaintScopeSql(access,'c');const [rows]=await db.query('select '+hColumns+','+rColumns+' from manual_followup h join manual_followup_revision r on r.followup_id=h.followup_id join complaint c on c.complaint_id=h.complaint_id where h.followup_id=? and r.version=? and '+scope.sql,[followupId,version,...scope.params]) as [Array<Record<string,unknown>>,unknown];
 if(!rows[0])throw AppError.notFound('回访版本不存在或不在授权范围内');return view(rows[0]);
}
export async function readHistory(db:SqlExecutor,complaintId:string,access:AccessContext):Promise<FollowupView[]> {
 const scope=buildComplaintScopeSql(access,'c');const [rows]=await db.query('select '+hColumns+','+rColumns+' from manual_followup h join manual_followup_revision r on r.followup_id=h.followup_id join complaint c on c.complaint_id=h.complaint_id where h.complaint_id=? and '+scope.sql+' order by h.id,r.version',[complaintId,...scope.params]) as [Array<Record<string,unknown>>,unknown];return rows.map(view);
}
export async function readRequest(tx:Tx,ownerId:string,complaintId:string,operation:string,requestId:string) {
 const [rows]=await tx.query('select payload_hash,followup_id,result_version from manual_followup_request where owner_id=? and complaint_id=? and operation=? and request_id=? for update',[ownerId,complaintId,operation,requestId]) as [Array<{payload_hash:string;followup_id:string;result_version:number}>,unknown];return rows[0]??null;
}
export async function insertHeader(tx:Tx,id:string,complaintId:string,ownerId:string,now:Date) {await tx.execute('insert into manual_followup(followup_id,complaint_id,owner_id,current_version,created_at) values(?,?,?,1,?)',[id,complaintId,ownerId,now]);}
export async function appendRevision(tx:Tx,v:FollowupView) {
 await tx.execute('insert into manual_followup_revision(followup_id,version,contacted,occurred_at,evaluation_code,dissatisfaction_reason,notes,conclusion,concluded_by,concluded_at,action,operator_id,operator_name,reason,revised_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[v.followupId,v.version,v.contacted?1:0,new Date(v.occurredAt),v.evaluationCode,v.dissatisfactionReason,v.notes,v.conclusion,v.concludedBy,v.concludedAt?new Date(v.concludedAt):null,v.action,v.operatorId,v.operatorName,v.reason,new Date(v.revisedAt)]);
 await tx.execute('update manual_followup set current_version=? where followup_id=?',[v.version,v.followupId]);
}
export async function insertRequest(tx:Tx,ownerId:string,complaintId:string,operation:string,requestId:string,hash:string,followupId:string,version:number) {await tx.execute('insert into manual_followup_request(owner_id,complaint_id,operation,request_id,payload_hash,followup_id,result_version) values(?,?,?,?,?,?,?)',[ownerId,complaintId,operation,requestId,hash,followupId,version]);}
