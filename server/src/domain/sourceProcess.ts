/** Normalized source contract only. Real endpoints, source keys and version semantics await agreement. */
export interface SourceProcessNode {
 sourceSystem:string;sourceId:string;nodeId:string;sourceSequence:number|null;sourceVersion:string|null;
 occurredAt:string|null;stage:string;department:string|null;contactName:string|null;opinion:string|null;
}
export interface SourceProcessBatch {nodes:SourceProcessNode[];nextCursor:string|null;complete:boolean;cutoffAt:string|null}
export interface SourceProcessAdapter {fetch(sourceId:string,cursor?:string):Promise<SourceProcessBatch>}
export class SourceProcessUnavailableError extends Error {
 readonly code='SOURCE_PROCESS_UNAVAILABLE';
 constructor(){super('来源全过程契约未就绪，尚未接入');}
}
export class UnavailableSourceProcessAdapter implements SourceProcessAdapter {
 async fetch(_sourceId:string,_cursor?:string):Promise<SourceProcessBatch>{throw new SourceProcessUnavailableError();}
}
export type SourceProcessState='unavailable'|'partial'|'complete'|'error';
export interface SourceProcessRevision extends SourceProcessNode {revision:number;observedAt:string|null}
export interface SourceProcessResult {
 complaintId:string;nodes:SourceProcessRevision[];revisions:SourceProcessRevision[];complete:boolean;
 cutoffAt:string|null;state:SourceProcessState;syncError:string|null;missingTimeNodeIds:string[];
}
function text(value:unknown,max:number,required=false):string|null {
 if(value===null&&!required)return null;
 if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new Error('SOURCE_PROCESS_INVALID_FIELD');
 return value;
}
export function normalizeSourceProcessNode(input:SourceProcessNode,system:string,sourceId:string):SourceProcessNode {
 if(!input||typeof input!=='object'||input.sourceSystem!==system||input.sourceId!==sourceId)throw new Error('SOURCE_PROCESS_IDENTITY_MISMATCH');
 const sourceSequence=input.sourceSequence;
 if(sourceSequence!==null&&(!Number.isSafeInteger(sourceSequence)||sourceSequence<0))throw new Error('SOURCE_PROCESS_INVALID_SEQUENCE');
 let occurredAt=text(input.occurredAt,64);
 if(occurredAt!==null){if(!/(Z|[+-]\d\d:\d\d)$/.test(occurredAt)||!Number.isFinite(new Date(occurredAt).getTime()))throw new Error('SOURCE_PROCESS_INVALID_TIME');occurredAt=new Date(occurredAt).toISOString();}
 return {sourceSystem:text(input.sourceSystem,64,true)!,sourceId:text(input.sourceId,128,true)!,nodeId:text(input.nodeId,128,true)!,sourceSequence,
  sourceVersion:input.sourceVersion===null?null:text(input.sourceVersion,128,true),occurredAt,stage:text(input.stage,128,true)!,department:text(input.department,256),contactName:text(input.contactName,128),opinion:text(input.opinion,65535)};
}
/** Ties without a source sequence remain ambiguous; identity tie-break only stabilizes rendering. */
export function orderSourceProcessNodes<T extends SourceProcessNode>(nodes:T[]):T[] {
 return [...nodes].sort((a,b)=>{
  if(a.occurredAt!==b.occurredAt)return a.occurredAt===null?1:b.occurredAt===null?-1:a.occurredAt.localeCompare(b.occurredAt);
  if(a.sourceSequence!==b.sourceSequence)return a.sourceSequence===null?1:b.sourceSequence===null?-1:a.sourceSequence-b.sourceSequence;
  return a.nodeId.localeCompare(b.nodeId);
 });
}
