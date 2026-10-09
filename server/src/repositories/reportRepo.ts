import {randomUUID} from 'node:crypto';
import type {SqlExecutor} from './userRepo';
import type {AccessContext} from '../auth/accessScope';
import {reportAuthorizationSql} from '../auth/reportScope';
import {rowsIn} from './serviceGridRepo';
import {storedSnapshot,checkReportPacket} from './statisticsSnapshotRepo';
import {digest,REPORT_LIMITS,type ReportSnapshot} from '../domain/reportSnapshot';
import type {ReportArtifact} from '../types/report';
import {AppError} from '../http/errors';
export const REPORT_MIMES={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as const;
const columns='j.report_id,j.snapshot_id,j.creator_id,j.request_id,j.request_hash,j.execution_actor,j.format,j.state,j.fence,j.owner_token,j.lease_until,j.failure_reason,j.created_at,s.snapshot_bytes,s.snapshot_hash,a.content_hash,a.byte_length';
const joins=' from report_job j join statistics_snapshot s on s.snapshot_id=j.snapshot_id join report_record r on r.d3_report_id=j.report_id left join report_artifact a on a.report_id=j.report_id';
export function reportView(r:Record<string,unknown>):ReportArtifact {const s=storedSnapshot(r);return {reportId:String(r.report_id),snapshotId:String(r.snapshot_id),templateCode:'statistics-draft',templateVersion:s.input.templateVersion,format:r.format as 'docx'|'xlsx',state:r.state as ReportArtifact['state'],contentHash:r.content_hash==null?null:String(r.content_hash),byteLength:r.byte_length==null?null:Number(r.byte_length),failureReason:r.failure_reason==null?null:String(r.failure_reason),createdAt:(r.created_at as Date).toISOString(),dataCutoffAt:s.statistics.summary.dataCutoffAt};}
export async function readReport(db:SqlExecutor,id:string):Promise<Record<string,unknown>|null>{return (await rowsIn(db,'select '+columns+joins+' where j.report_id=?',[id]))[0]??null;}
export async function findReportRequest(db:SqlExecutor,user:string,request:string){return (await rowsIn(db,'select '+columns+joins+' where j.creator_id=? and j.request_id=?',[user,request]))[0]??null;}
export async function authorizedReport(db:SqlExecutor,id:string,access:AccessContext,codes:readonly string[]):Promise<Record<string,unknown>|null>{const scope=reportAuthorizationSql(access,codes,'j.report_id');return (await rowsIn(db,'select '+columns+joins+' where j.report_id=? and '+scope.sql,[id,...scope.params]))[0]??null;}
export async function listReportRows(db:SqlExecutor,access:AccessContext,codes:readonly string[],size:number,before:string|null){const scope=reportAuthorizationSql(access,codes,'j.report_id');return rowsIn(db,'select '+columns+joins+' where '+scope.sql+(before?' and j.report_id<?':'')+' order by j.report_id desc limit ?',[...scope.params,...(before?[before]:[]),size]);}
export async function insertReportJob(db:SqlExecutor,id:string,snapshotId:string,user:string,hash:string,s:ReportSnapshot){
 await db.query('insert into report_record(report_title,preview_content,date_from,date_to,template_version,d3_report_id) values(?,?,?,?,?,?)',['诉求统计报告草稿','工程草稿，统计政策待业务确认',s.input.query.from,s.input.query.to,'v1',id]);
 await db.query("insert into report_job(report_id,snapshot_id,creator_id,request_id,request_hash,execution_actor,format,state,created_at) values(?,?,?,?,?,?,?,'pending',current_timestamp(3))",[id,snapshotId,user,s.input.requestId,hash,user,s.input.format]);
}
export interface ReportClaim {reportId:string;owner:string;fence:number;actor:string;snapshot:ReportSnapshot}
export async function claimReport(db:SqlExecutor,id?:string,leaseMs=60000):Promise<ReportClaim|null>{
 if(!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>3600000)throw Error('Invalid report lease');
 const r=(await rowsIn(db,"select report_id,fence,execution_actor from report_job where (state='pending' or (state='generating' and lease_until<current_timestamp(3)))"+(id?' and report_id=?':'')+' order by created_at,report_id limit 1 for update skip locked',id?[id]:[]))[0];if(!r)return null;
 const owner=randomUUID();const fence=Number(r.fence)+1;if(!Number.isSafeInteger(fence))throw Error('Report fence overflow');
 await db.query("update report_job set state='generating',owner_token=?,fence=?,lease_until=timestampadd(microsecond,?,current_timestamp(3)),failure_reason=null where report_id=?",[owner,fence,leaseMs*1000,r.report_id]);
 const row=await readReport(db,String(r.report_id));if(!row)throw Error('Report association missing');return {reportId:String(r.report_id),owner,fence,actor:String(r.execution_actor),snapshot:storedSnapshot(row)};
}
export async function fenceCurrent(db:SqlExecutor,c:ReportClaim):Promise<boolean>{return (await rowsIn(db,"select report_id from report_job where report_id=? and state='generating' and owner_token=? and fence=? and lease_until>=current_timestamp(3) for update",[c.reportId,c.owner,c.fence])).length===1;}
export async function saveReportArtifact(db:SqlExecutor,c:ReportClaim,bytes:Buffer){
 if(bytes.length>REPORT_LIMITS.artifact)throw AppError.validation('报告产物超过16MiB工程限额，请缩小选择');await checkReportPacket(db,bytes.length);
 await db.query('insert into report_artifact(report_id,format,content_bytes,content_hash,content_type,byte_length) values(?,?,?,?,?,?)',[c.reportId,c.snapshot.input.format,bytes,digest(bytes),REPORT_MIMES[c.snapshot.input.format],bytes.length]);
 await db.query("update report_job set state='succeeded',owner_token=null,lease_until=null,failure_reason=null where report_id=? and fence=? and owner_token=?",[c.reportId,c.fence,c.owner]);
}
export async function reportBinary(db:SqlExecutor,id:string){const r=(await rowsIn(db,'select format,content_bytes,content_hash,content_type,byte_length from report_artifact where report_id=?',[id]))[0];if(!r||!Buffer.isBuffer(r.content_bytes)||r.content_bytes.length!==Number(r.byte_length)||digest(r.content_bytes)!==String(r.content_hash)||r.content_type!==REPORT_MIMES[r.format as 'docx'|'xlsx'])throw AppError.notFound('报告产物不可核验');return {bytes:r.content_bytes,mime:String(r.content_type),hash:String(r.content_hash),format:r.format as 'docx'|'xlsx'};}
