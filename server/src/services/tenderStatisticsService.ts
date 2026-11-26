import {pool} from '../db/pool';
import type {AccessContext} from '../auth/accessScope';
import type {StatisticsQuery} from '../types/statistics';
import type {SqlExecutor} from '../repositories/userRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import {captureStatisticsIn,assertStatisticsPermission,statisticsPage,type StatisticsCapture} from './statisticsService';
import {aggregateTenderStatistics,tenderCaptureRange} from '../domain/tenderStatistics';
/** One consistent snapshot for selected chart counts and calendar/comparison cards. */
export async function captureTenderStatisticsIn(db:SqlExecutor,q:StatisticsQuery,access:AccessContext,permissions:readonly string[],clock:()=>Date=()=>new Date()){
 assertStatisticsPermission(q,permissions);
 // Calendar comparisons are built from the extended current window by aggregateTenderStatistics.
 const selected=await captureStatisticsIn(db,q,access,permissions,clock,{currentOnly:true});
 const extended=await captureStatisticsIn(db,{...q,...tenderCaptureRange(q),periodKind:'custom'},access,permissions,clock,{currentOnly:true});
 const names=new Map<string,string>();
 // Only names referenced by authorized selected complaints, and only with master-data read capability.
 if(permissions.includes('grid.read')){
  const codes=[...new Set(selected.rows.map(r=>r.communityCode).filter((v):v is string=>v!==null))];
  for(let offset=0;offset<codes.length;offset+=500){const batch=codes.slice(offset,offset+500);for(const r of await rowsIn(db,'select code,name from community where code in ('+batch.map(()=>'?').join(',')+')',batch))names.set(String(r.code),String(r.name));}
 }
 return aggregateTenderStatistics(selected,extended,q.to,names);
}
export async function captureTenderStatistics(q:StatisticsQuery,access:AccessContext,permissions:readonly string[],clock:()=>Date=()=>new Date()){
 assertStatisticsPermission(q,permissions);const conn=await pool.getConnection();
 try{await conn.query('set transaction isolation level repeatable read');await conn.query('start transaction with consistent snapshot, read only');return await captureTenderStatisticsIn(conn,q,access,permissions,clock);}
 finally{try{await conn.rollback();}finally{conn.release();}}
}
/** Page only exact, normalized community membership from an already scoped capture. */
export function tenderCommunityPage(capture:StatisticsCapture,communityCode:string,page:number,size:number){
 const rows=capture.rows.filter(r=>r.communityCode===communityCode);
 return statisticsPage({...capture,rows,summary:{...capture.summary,total:rows.length}},page,size);
}
