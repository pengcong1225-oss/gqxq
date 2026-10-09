import type { AccessContext } from '../auth/accessScope';
import { rowToDetail, toIso, type ComplaintRow } from '../repositories/complaintMapper';
import type { ComplaintDetail } from '../types/api';
import { EFFECTIVE_COLUMNS } from '../domain/effectiveFieldPolicy';
/** Explicit mapper whitelist; documents are exclusively served by source-document. */
export function projectComplaintDetail(row:ComplaintRow,_ctx:AccessContext):ComplaintDetail {
 const {sourcePayload:_payload,sourceFields:_fields,sourcePayloadHash:_hash,...detail}=rowToDetail(row);
 const fields=_fields ?? _payload;
 const effectiveFieldState=detail.effectiveFieldState===null?null:Object.fromEntries(
  Object.entries(detail.effectiveFieldState).filter(([field])=>[...EFFECTIVE_COLUMNS,'enterprise_code','enterprise_name','major_category_code','minor_category_code','category_dictionary_version'].includes(field as typeof EFFECTIVE_COLUMNS[number])).map(([field,state])=>[field,pick(state,['resolution','value','version','reason','correctionId'])]));
 const sourceAddress=typeof fields?.address==='string'?fields.address:null;
 const sourceSnapshotAt=typeof _fields?._receivedAt==='string'?toIso(_fields._receivedAt):null;
 return {...detail,effectiveFieldState,sourceAddress,effectiveAddress:detail.address,
  sourceDeadlineAt:null,sourceCompletedAt:null,sourceSnapshotAt,
  businessTimeSource:detail.sourceReportedAt?'source_reported_at':detail.receivedAt?'platform_received_at':'unavailable',
  sourceFieldReasons:{sourceAddress:sourceAddress===null?'未留存可核实的结构化来源原地址':null,
   sourceDeadlineAt:'来源期限字段契约未就绪',sourceCompletedAt:'来源办结日期字段契约未就绪',
   sourceSnapshotAt:sourceSnapshotAt===null?'未留存可核实的快照接收时间':null},
  addressCandidate:null,locationClues:[],locationConflict:false};
}
function pick(value:unknown,keys:string[]):Record<string,unknown>{
 let v=value;if(typeof v==='string'){try{v=JSON.parse(v);}catch{v={};}}
 if(!v||typeof v!=='object'||Array.isArray(v))return {};
 const r=v as Record<string,unknown>;
 return Object.fromEntries(keys.filter(k=>r[k]===null||typeof r[k]==='string'||typeof r[k]==='boolean'||typeof r[k]==='number'&&Number.isFinite(r[k])).map(k=>[k,r[k]]));
}
const DISPOSAL_FIELDS=['result','summary','disposalResult','disposalContent','remark','reason'];
export function projectDisposalResult(value:unknown) {
 const data=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const fields=pick(data,DISPOSAL_FIELDS);
 return {fields,withheldFieldCount:Object.keys(data).length-Object.keys(fields).length};
}
/** Stored analysis/correction values may contain a historical callback object. */
export function projectDisposalValue(value:string|null):string|null {
 if(value===null)return null;
 try{const parsed:unknown=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(projectDisposalResult(parsed).fields);}catch{}
 return value;
}
export function projectTransportMessage(result:string,message:string|null):string|null {
 if(message===null)return null;
 return ({timeout:'外部请求超时',network_error:'外部连接失败',auth_failed:'外部身份校验失败',conflict:'外部请求发生冲突',validation_failed:'外部校验未通过',payload_too_large:'外部请求超过大小限制'} as Record<string,string>)[result]??'外部响应未成功';
}
export function projectReportingEvent(row:{eventId:string;state?:string;message?:string;payload:unknown}) {
 let value=row.payload;if(typeof value==='string'){try{value=JSON.parse(value);}catch{value={};}}
 const raw=value && typeof value==='object'?value as Record<string,unknown>:{};
 const disposal=projectDisposalResult(raw.enterpriseDisposalResult);
 const payload={...pick(raw,['eventType','eventSequence','submissionVersion','occurredAt','approvedAt','approvalConclusion','actorName','summary']),
  enterpriseDisposalResult:disposal.fields,withheldFieldCount:disposal.withheldFieldCount,
  attachments:Array.isArray(raw.attachments)?raw.attachments.map(a=>pick(a,['attachmentId','fileName','size','sha256','contentType'])):[]};
 return {eventId:row.eventId,state:row.state,payload};
}
export function projectAuditDetail(value:unknown) {
 const detail=pick(value,['basis','fieldName','oldValue','newValue','statusBefore','statusAfter','reportingStatus','supervisionStatus','changedCount']);
 if(detail.fieldName==='disposal_result'){
  for(const key of ['oldValue','newValue'])if(typeof detail[key]==='string')detail[key]=projectDisposalValue(detail[key] as string);
 }
 return detail;
}
