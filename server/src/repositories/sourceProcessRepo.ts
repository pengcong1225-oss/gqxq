import {currentScopeSql,assertLockedComplaintAccess} from '../auth/accessScope';
import {pool,type Row} from '../db/pool';
import type {Tx} from '../db/tx';
import {toIso} from './complaintMapper';
import {AppError} from '../http/errors';
import type {SourceProcessNode,SourceProcessRevision,SourceProcessState} from '../domain/sourceProcess';

export interface SourceProcessIdentity {complaintId:string;sourceSystem:string;sourceId:string}
export interface ProcessStream {version:number;cutoffAt:string|null;state:SourceProcessState;errorCode:string|null}
const DEFAULT_STREAM:ProcessStream={version:0,cutoffAt:null,state:'unavailable',errorCode:'SOURCE_PROCESS_UNAVAILABLE'};
const nodeColumns='r.source_system,r.source_id,r.node_id,r.revision,r.source_sequence,r.source_version,r.occurred_at,r.stage,r.department,r.contact_name,r.opinion,r.observed_at';
function mapRevision(row:Record<string,unknown>):SourceProcessRevision {
 return {sourceSystem:String(row.source_system),sourceId:String(row.source_id),nodeId:String(row.node_id),revision:Number(row.revision),
  sourceSequence:row.source_sequence==null?null:Number(row.source_sequence),sourceVersion:row.source_version==null?null:String(row.source_version),
  occurredAt:toIso(row.occurred_at),stage:String(row.stage),department:row.department==null?null:String(row.department),
  contactName:row.contact_name==null?null:String(row.contact_name),opinion:row.opinion==null?null:String(row.opinion),observedAt:toIso(row.observed_at)};
}
export async function readSourceProcess(identity:SourceProcessIdentity):Promise<{stream:ProcessStream;revisions:SourceProcessRevision[]}> {
 const scope=currentScopeSql();const {complaintId,sourceSystem,sourceId}=identity;
 const params=[complaintId,sourceSystem,sourceId,...scope.params];
 // One statement snapshot keeps completion metadata and revision observations consistent.
 // The complaint is the preserved side so an authorized empty/unavailable stream still has a row.
 const [rows]=await pool.query<Row[]>('select '+nodeColumns+',s.version as stream_version,s.completed_cutoff_at,s.state as stream_state,s.error_code from complaint c left join source_process_stream s on c.complaint_id=s.complaint_id and c.source_system=s.source_system and c.source_id=s.source_id left join source_process_revision r on c.complaint_id=r.complaint_id and c.source_system=r.source_system and c.source_id=r.source_id where c.complaint_id=? and coalesce(c.source_system,\'\')=? and coalesce(c.source_id,\'\')=? and '+scope.sql+' order by r.id asc',params);
 const row=rows[0] as Record<string,unknown>|undefined;
 if(!row)throw AppError.notFound('诉求不存在或不在授权范围内');
 return {stream:row.stream_version!=null?{version:Number(row.stream_version),cutoffAt:toIso(row.completed_cutoff_at),state:row.stream_state as SourceProcessState,errorCode:row.error_code==null?null:String(row.error_code)}:{...DEFAULT_STREAM},revisions:(rows as unknown as Record<string,unknown>[]).filter(r=>r.node_id!==null).map(mapRevision)};
}
async function lockStream(tx:Tx,identity:SourceProcessIdentity,expectedVersion:number):Promise<ProcessStream> {
 await assertLockedComplaintAccess(tx,identity.complaintId);
 const [complaints]=await tx.query<Row[]>('select source_system,source_id from complaint where complaint_id=?',[identity.complaintId]);
 if(complaints[0]?.source_system!==identity.sourceSystem||complaints[0]?.source_id!==identity.sourceId)throw AppError.conflict('来源标识已变更，请重新读取');
 const [streams]=await tx.query<Row[]>('select version,source_system,source_id,completed_cutoff_at,state,error_code from source_process_stream where complaint_id=? for update',[identity.complaintId]);
 const row=streams[0] as Record<string,unknown>|undefined;
 if(Number(row?.version??0)!==expectedVersion)throw AppError.conflict('来源过程已被另一批次更新，请重新读取');
 if(row&&(row.source_system!==identity.sourceSystem||row.source_id!==identity.sourceId))throw AppError.conflict('来源标识与已有过程记录不一致');
 return row?{version:Number(row.version),cutoffAt:toIso(row.completed_cutoff_at),state:row.state as SourceProcessState,errorCode:row.error_code==null?null:String(row.error_code)}:{...DEFAULT_STREAM};
}
function sameNode(a:SourceProcessNode,b:SourceProcessNode):boolean {
 return (['sourceSystem','sourceId','nodeId','sourceSequence','sourceVersion','occurredAt','stage','department','contactName','opinion'] as const).every(key=>a[key]===b[key]);
}
export async function saveSourceProcessInTx(tx:Tx,identity:SourceProcessIdentity,expectedVersion:number,nodes:SourceProcessNode[],state:SourceProcessState,cutoffAt:string|null,errorCode:string|null):Promise<void> {
 const previous=await lockStream(tx,identity,expectedVersion);
 if(state==='complete'&&cutoffAt&&previous.cutoffAt&&cutoffAt<previous.cutoffAt)throw Error('SOURCE_PROCESS_CUTOFF_REGRESSION');
 const observedAt=new Date();
 for(const node of nodes){
  const [rows]=await tx.query<Row[]>('select '+nodeColumns+' from source_process_revision r where r.complaint_id=? and r.source_system=? and r.source_id=? and r.node_id=? order by r.revision asc',[identity.complaintId,identity.sourceSystem,identity.sourceId,node.nodeId]);
  const revisions=(rows as unknown as Record<string,unknown>[]).map(mapRevision);
  const sameVersion=revisions.find(r=>r.sourceVersion===node.sourceVersion);
  if(sameVersion){if(!sameNode(sameVersion,node))throw Error('SOURCE_PROCESS_VERSION_CONFLICT');continue;}
  if(revisions.length&&(node.sourceVersion===null||revisions.some(r=>r.sourceVersion===null)))throw Error('SOURCE_PROCESS_VERSION_REQUIRED');
  const revision=(revisions.at(-1)?.revision??0)+1;
  await tx.execute('insert into source_process_revision (complaint_id,source_system,source_id,node_id,revision,source_sequence,source_version,occurred_at,stage,department,contact_name,opinion,observed_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
   [identity.complaintId,node.sourceSystem,node.sourceId,node.nodeId,revision,node.sourceSequence,node.sourceVersion,node.occurredAt===null?null:new Date(node.occurredAt),node.stage,node.department,node.contactName,node.opinion,observedAt]);
 }
 const completedCutoff=state==='complete'&&cutoffAt!==null?new Date(cutoffAt):previous.cutoffAt===null?null:new Date(previous.cutoffAt);
 await tx.execute('insert into source_process_stream (complaint_id,source_system,source_id,version,completed_cutoff_at,state,error_code,attempted_at) values (?,?,?,?,?,?,?,?) on duplicate key update version=values(version),completed_cutoff_at=values(completed_cutoff_at),state=values(state),error_code=values(error_code),attempted_at=values(attempted_at)',
  [identity.complaintId,identity.sourceSystem,identity.sourceId,expectedVersion+1,completedCutoff,state,errorCode,observedAt]);
}
