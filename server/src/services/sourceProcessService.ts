import {AppError} from '../http/errors';
import {findByIdOrNo} from '../repositories/complaintRepo';
import {withTransaction} from '../db/tx';
import {readSourceProcess,saveSourceProcessInTx,type SourceProcessIdentity} from '../repositories/sourceProcessRepo';
import {normalizeSourceProcessNode,orderSourceProcessNodes,SourceProcessUnavailableError,type SourceProcessAdapter,type SourceProcessNode,type SourceProcessResult} from '../domain/sourceProcess';
async function resolveIdentity(idOrNo:string):Promise<SourceProcessIdentity>{
 const complaint=await findByIdOrNo(idOrNo);if(!complaint)throw AppError.notFound('诉求不存在');
 return {complaintId:String(complaint.complaint_id),sourceSystem:typeof complaint.source_system==='string'?complaint.source_system:'',sourceId:typeof complaint.source_id==='string'?complaint.source_id:''};
}
const SAFE_ERRORS:Record<string,string>={SOURCE_PROCESS_UNAVAILABLE:'来源全过程契约未就绪，尚未接入',SOURCE_PROCESS_VERSION_CONFLICT:'同一来源版号出现不同内容，批次未保存',SOURCE_PROCESS_VERSION_REQUIRED:'节点修订缺少可信来源版号，批次未保存',SOURCE_PROCESS_CUTOFF_REGRESSION:'来源截止时间倒退，批次未保存',SOURCE_PROCESS_INVALID_BATCH:'来源批次结构或分页契约无效，批次未保存',SOURCE_PROCESS_IDENTITY_MISSING:'诉求缺少来源标识'};
export async function getSourceProcesses(idOrNo:string):Promise<SourceProcessResult>{
 const identity=await resolveIdentity(idOrNo);const {stream,revisions}=await readSourceProcess(identity);
 const heads=new Map<string,typeof revisions[number]>();for(const revision of revisions)heads.set(revision.nodeId,revision);
 const nodes=orderSourceProcessNodes([...heads.values()]);
 return {complaintId:identity.complaintId,nodes,revisions,complete:stream.state==='complete',cutoffAt:stream.cutoffAt,state:stream.state,
  syncError:stream.errorCode===null?null:SAFE_ERRORS[stream.errorCode]??'来源过程同步异常，完整水位未推进',missingTimeNodeIds:nodes.filter(n=>n.occurredAt===null).map(n=>n.nodeId)};
}
/** Internal injected contract path only. No production worker, user refresh endpoint or guessed live client. */
export async function syncSourceProcesses(idOrNo:string,adapter:SourceProcessAdapter):Promise<SourceProcessResult>{
 const identity=await resolveIdentity(idOrNo);const {stream}=await readSourceProcess(identity);
 try{
  if(!identity.sourceSystem||!identity.sourceId)throw Error('SOURCE_PROCESS_IDENTITY_MISSING');
  const nodes:SourceProcessNode[]=[];const seen=new Set<string>();let cursor:string|undefined;let cutoffAt:string|null=null;let complete=false;
  for(let page=0;page<100;page++){
   const batch=await adapter.fetch(identity.sourceId,cursor);
   if(!batch||!Array.isArray(batch.nodes)||typeof batch.complete!=='boolean'||(batch.nextCursor!==null&&(typeof batch.nextCursor!=='string'||!batch.nextCursor||batch.nextCursor.length>2048))||(batch.cutoffAt!==null&&(typeof batch.cutoffAt!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(batch.cutoffAt)||!Number.isFinite(new Date(batch.cutoffAt).getTime()))))throw Error('SOURCE_PROCESS_INVALID_BATCH');
   const batchCutoff=batch.cutoffAt===null?null:new Date(batch.cutoffAt).toISOString();
   if(page>0&&cutoffAt!==batchCutoff)throw Error('SOURCE_PROCESS_INVALID_BATCH');cutoffAt=batchCutoff;
   nodes.push(...batch.nodes.map(n=>normalizeSourceProcessNode(n,identity.sourceSystem,identity.sourceId)));
   if(nodes.length>10000||batch.complete&&batch.nextCursor!==null)throw Error('SOURCE_PROCESS_INVALID_BATCH');
   if(batch.nextCursor===null){complete=batch.complete;break;}
   if(seen.has(batch.nextCursor)||page===99)throw Error('SOURCE_PROCESS_INVALID_BATCH');seen.add(batch.nextCursor);cursor=batch.nextCursor;
  }
  await withTransaction(tx=>saveSourceProcessInTx(tx,identity,stream.version,nodes,complete?'complete':'partial',cutoffAt,null));
 }catch(error){
  if(error instanceof AppError)throw error;
  const code=error instanceof SourceProcessUnavailableError?'SOURCE_PROCESS_UNAVAILABLE':error instanceof Error&&SAFE_ERRORS[error.message]?error.message:'SOURCE_PROCESS_FAILED';
  await withTransaction(tx=>saveSourceProcessInTx(tx,identity,stream.version,[],code==='SOURCE_PROCESS_UNAVAILABLE'?'unavailable':'error',null,code));
 }
 return getSourceProcesses(idOrNo);
}
