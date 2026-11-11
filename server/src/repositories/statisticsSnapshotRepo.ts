import type {SqlExecutor} from './userRepo';
import {rowsIn} from './serviceGridRepo';
import {canonical,digest,parseStoredSnapshot,type ReportSnapshot} from '../domain/reportSnapshot';
import {reportProofs} from '../auth/reportScope';
import {AppError} from '../http/errors';
export async function checkReportPacket(db:SqlExecutor,size:number):Promise<void> {
 const row=(await rowsIn(db,'select @@max_allowed_packet as maxPacket'))[0];const max=Number(row?.maxPacket);
 if(!Number.isSafeInteger(max)||size+65536>max)throw AppError.validation('报告超过数据库实际包容量，请缩小选择');
}
export async function insertStatisticsSnapshot(db:SqlExecutor,id:string,s:ReportSnapshot):Promise<void> {
 const text=canonical(s);await checkReportPacket(db,Buffer.byteLength(text));const proofs=reportProofs(s);
 await db.query('insert into statistics_snapshot(snapshot_id,snapshot_bytes,snapshot_hash,required_permissions,proof_count,created_at) values(?,?,?,?,?,current_timestamp(3))',[id,Buffer.from(text),digest(text),JSON.stringify(s.requiredPermissions),proofs.length]);
 for(let start=0;start<proofs.length;start+=200){const chunk=proofs.slice(start,start+200);await db.query('insert into report_scope_proof(snapshot_id,ordinal,kind,object_key,enterprise_code,district_code,enterprise_any,district_any) values '+chunk.map(()=>'(?,?,?,?,?,?,?,?)').join(','),chunk.flatMap((p,i)=>[id,start+i,p.kind,p.key,p.e,p.d,p.eAny?1:0,p.dAny?1:0]));}
}
export function storedSnapshot(row:Record<string,unknown>):ReportSnapshot {return parseStoredSnapshot(Buffer.isBuffer(row.snapshot_bytes)?row.snapshot_bytes.toString('utf8'):String(row.snapshot_bytes),String(row.snapshot_hash));}
