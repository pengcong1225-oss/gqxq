import type {SqlExecutor} from './userRepo';
import type {Tx} from '../db/tx';
import type {BusinessEventInput,BusinessEventView} from '../types/businessEvents';
import {businessEventQuality} from '../domain/businessEvents';
import {buildComplaintScopeSql,type AccessContext} from '../auth/accessScope';

type Row=Record<string,unknown>;
export async function eventRows(db:SqlExecutor,sql:string,params:unknown[]=[]):Promise<Row[]>{return (await db.query(sql,params) as [Row[],unknown])[0];}
export function eventView(row:Row):BusinessEventView {
 const input=(typeof row.content==='string'?JSON.parse(row.content):row.content) as BusinessEventInput;
 return {...input,id:String(row.event_id),payloadHash:String(row.payload_hash),receivedAt:new Date(row.received_at as string).toISOString(),qualityReasons:businessEventQuality(input)};
}
export async function readEvent(db:SqlExecutor,id:string,lock=false):Promise<BusinessEventView|null>{
 const rows=await eventRows(db,'select event_id,content,payload_hash,received_at from source_business_head where event_id=?'+(lock?' for update':''),[id]);return rows[0]?eventView(rows[0]):null;
}
// Followups are authorized through the current complaint, never through source-supplied ownership.
export function eventScope(access:AccessContext):{sql:string;params:unknown[]} {
 const ownParams:unknown[]=[];const rules=access.rules.map(r=>{
  if(r.kind==='all')return '1=1';const clauses:string[]=[];
  for(const [key,values] of [['enterprise_code',r.enterpriseCodes],['district_code',r.districtCodes]] as const)if(values.length){clauses.push('e.'+key+' in ('+values.map(()=>'?').join(',')+')');ownParams.push(...values);}
  return clauses.length?'('+clauses.join(' and ')+')':'0=1';
 });const complaint=buildComplaintScopeSql(access,'c');
 return {sql:"((e.kind<>'followup' and ("+(rules.join(' or ')||'0=1')+")) or (e.kind='followup' and exists(select 1 from complaint c where c.complaint_id=json_unquote(json_extract(e.content,'$.payload.complaintId')) and "+complaint.sql+')))',params:[...ownParams,...complaint.params]};
}
export function featureOwnershipScope(access:AccessContext,alias:'a'|'e'):{sql:string;params:unknown[]}{const params:unknown[]=[];const rules=access.rules.map(r=>{if(r.kind==='all')return '1=1';const terms:string[]=[];for(const [key,values] of [['enterprise_code',r.enterpriseCodes],['district_code',r.districtCodes]] as const)if(values.length){terms.push(alias+'.'+key+' in ('+values.map(()=>'?').join(',')+')');params.push(...values);}return terms.length?'('+terms.join(' and ')+')':'0=1';});return {sql:'('+(rules.join(' or ')||'0=1')+')',params};}
export async function writeEvent(tx:Tx,input:BusinessEventInput,id:string,hash:string,at:Date):Promise<void>{
 const content=JSON.stringify(input);
 await tx.execute('insert into source_business_revision(event_id,source_version,payload_hash,content,received_at) values(?,?,?,?,?)',[id,input.sourceVersion,hash,content,at]);
 await tx.execute('update source_business_head set source_version=?,enterprise_code=?,district_code=?,payload_hash=?,content=?,received_at=? where event_id=?',[input.sourceVersion,input.enterpriseCode,input.districtCode,hash,content,at,id]);
}
