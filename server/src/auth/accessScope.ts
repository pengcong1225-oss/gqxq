import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { resolveAuthorization } from '../services/roleService';
import { readUserScope } from '../repositories/userScopeRepo';
import type { EffectiveAuthorization } from './permissionCatalog';
import type { SqlExecutor } from '../repositories/userRepo';

export type ScopeRule = {kind:'all'} | {kind:'restricted';enterpriseCodes:string[];districtCodes:string[]};
export interface AccessContext {userId:string;roles:string[];scopeVersion:number;rules:ScopeRule[];canReadSource:boolean}
const contexts = new AsyncLocalStorage<AccessContext>();
const denied: AccessContext = {userId:'',roles:[],scopeVersion:0,rules:[],canReadSource:false};
export function currentAccessContext(): AccessContext { return contexts.getStore() ?? {...denied,roles:[],rules:[]}; }
export function runWithAccessContext<T>(ctx:AccessContext,fn:()=>T):T {return contexts.run(ctx,fn);}
/** Only trusted ingress/callback/scheduler code may establish this context. */
export function runAsTrustedSystem<T>(fn:()=>T):T {return runWithAccessContext({userId:'trusted-system',roles:[],scopeVersion:0,rules:[{kind:'all'}],canReadSource:false},fn);}
export async function resolveAccessContext(userId:string, authorization?:EffectiveAuthorization):Promise<AccessContext> {
 const grants=authorization ?? await resolveAuthorization(userId);
 const scope=await readUserScope(pool,userId);
 return {userId,roles:grants.roleCodes,scopeVersion:scope.scopeVersion,rules:grants.roleCodes.length ? scope.rules : [],canReadSource:grants.permissionCodes.includes('source_document.read')};
}
export function canAccessComplaint(ctx:AccessContext,row:Record<string,unknown>):boolean {
 if(Number(row.deleted ?? 0)!==0)return false;
 return ctx.rules.some(r=>r.kind==='all'||((r.enterpriseCodes.length>0||r.districtCodes.length>0)&&
  (!r.enterpriseCodes.length||r.enterpriseCodes.includes(String(row.enterprise_code??'')))&&
  (!r.districtCodes.length||r.districtCodes.includes(String(row.district_code??'')))));
}
export function assertComplaintAccess(row:Record<string,unknown>,ctx=currentAccessContext()):void {
 if(!canAccessComplaint(ctx,row))throw AppError.notFound('诉求不存在或不在授权范围内');
}
export function assertAllScope(ctx=currentAccessContext()):void {
 if(!ctx.rules.some(r=>r.kind==='all'))throw AppError.forbidden('此维护操作需要显式全域范围');
}
export function buildComplaintScopeSql(ctx:AccessContext,alias:string):{sql:string;params:unknown[]} {
 if(!['c','scope_c','complaint'].includes(alias))throw new Error('Uncontrolled complaint SQL alias');
 const params:unknown[]=[];
 const rules=ctx.rules.map(r=>{
  if(r.kind==='all')return '1 = 1';
  const parts:string[]=[];
  for(const [column,values] of [['enterprise_code',r.enterpriseCodes],['district_code',r.districtCodes]] as const){
   if(values.length){parts.push(alias+'.'+column+' in ('+values.map(()=>'?').join(', ')+')');params.push(...values);}
  }
  return parts.length?'('+parts.join(' and ')+')':'0 = 1';
 });
 return {sql:'(coalesce('+alias+'.deleted, 0) = 0 and ('+(rules.join(' or ')||'0 = 1')+'))',params};
}
export function currentScopeSql(alias='c') {return buildComplaintScopeSql(currentAccessContext(),alias);}
/** Scope related records by the CURRENT complaint, never by historical snapshots. */
export function relatedScopeSql(complaintIdColumn:string) {
 if(!/^(correction_item|analysis_record|report_todo|d)\.complaint_id$/.test(complaintIdColumn))throw new Error('Uncontrolled related SQL column');
 const scope=currentScopeSql('scope_c');
 return {sql:'exists (select 1 from complaint scope_c where scope_c.complaint_id = '+complaintIdColumn+' and '+scope.sql+')',params:scope.params};
}
/** Transactional writers re-read the current row under its lock. */
export async function assertLockedComplaintAccess(db:SqlExecutor,complaintId:string):Promise<void> {
 const [rows]=await db.query('select enterprise_code, district_code, deleted from complaint where complaint_id = ? for update',[complaintId]) as [Array<Record<string,unknown>>,unknown];
 if(!rows[0])throw AppError.notFound('诉求不存在');
 assertComplaintAccess(rows[0]);
}
