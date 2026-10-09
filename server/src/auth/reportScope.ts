import type {AccessContext,ScopeRule} from './accessScope';
import {buildComplaintScopeSql} from './accessScope';
import {buildEnterpriseScopeSql} from './enterpriseScope';
import {buildGridScopeSql} from './gridScope';
import type {ReportSnapshot} from '../domain/reportSnapshot';
import {REPORT_LIMITS} from '../domain/reportSnapshot';
import {AppError} from '../http/errors';
export interface ReportProof {kind:'domain'|'complaint'|'capture_complaint'|'master'|'grid'|'grid_original';key:string;e:string|null;d:string|null;eAny:boolean;dAny:boolean}
function pairCovered(e:string|null,d:string|null,eAny:boolean,dAny:boolean,rules:ScopeRule[]):boolean {return rules.some(r=>r.kind==='all'||(r.enterpriseCodes.length+r.districtCodes.length>0&&(!r.enterpriseCodes.length||!eAny&&e!==null&&r.enterpriseCodes.includes(e))&&(!r.districtCodes.length||!dAny&&d!==null&&r.districtCodes.includes(d))));}
export function domainCovered(original:ScopeRule[],current:ScopeRule[]):boolean {if(!original.length)return false;return original.every(r=>r.kind==='all'?current.some(c=>c.kind==='all'):(r.enterpriseCodes.length+r.districtCodes.length>0&& (r.enterpriseCodes.length?r.enterpriseCodes:[null]).every(e=>(r.districtCodes.length?r.districtCodes:[null]).every(d=>pairCovered(e,d,!r.enterpriseCodes.length,!r.districtCodes.length,current)))));}
export function reportProofs(s:ReportSnapshot):ReportProof[] {
 const result:ReportProof[]=[];const put=(kind:ReportProof['kind'],key:string,e:string|null,d:string|null,eAny=false,dAny=false)=>{result.push({kind,key,e,d,eAny,dAny});if(result.length>REPORT_LIMITS.proofs)throw AppError.validation('报告授权证明超过工程限额');};
 // Current projection ownership filters can narrow the original domain. Entry
 // projection filters never prove present ownership; retain the broader domain.
 const q=s.input.query;
 for(const r of s.domain.rules){const er=r.kind==='all'?[]:r.enterpriseCodes,dr=r.kind==='all'?[]:r.districtCodes;
  const es=q.projection==='current'&&q.enterpriseCode?(er.length&&!er.includes(q.enterpriseCode)?[]:[q.enterpriseCode]):er.length?er:[null];
  const ds=q.projection==='current'&&q.districtCode?(dr.length&&!dr.includes(q.districtCode)?[]:[q.districtCode]):dr.length?dr:[null];
  for(const e of es)for(const d of ds)put('domain','',e,d,e===null,d===null);
 }
 if(!result.length)throw AppError.forbidden('原查询域不可完整证明');
 for(const f of s.statistics.scopeFacts){put('complaint',f.complaintId,f.original.enterpriseCode,f.original.districtCode);put('capture_complaint',f.complaintId,f.current.enterpriseCode,f.current.districtCode);}
 for(const f of s.statistics.masterScopeFacts)put('master',f.enterpriseCode,f.enterpriseCode,f.districtCode);
 for(const f of s.statistics.coverageEvidence){for(const d of f.current.districtCodes.length?f.current.districtCodes:[null])put('grid',f.coverage.code,f.current.enterpriseCode,d);for(const d of f.original.districtCodes.length?f.original.districtCodes:[null])put('grid_original',f.coverage.code,f.original.enterpriseCode,d);}
 return result;
}
/** ONE complete SQL predicate for report list/count/detail/download AND A6 audit.
 * Proof count and mandatory domain row prevent missing proofs/vacuous allows.
 * e_any/d_any means unbounded domain, never an unknown object ownership value. */
export function reportAuthorizationSql(access:AccessContext,permissions:readonly string[],reportIdSql:string):{sql:string;params:unknown[]} {
 if(!['j.report_id','a.biz_id','?'].includes(reportIdSql))throw Error('Uncontrolled report reference');
 const params:unknown[]=[];
 const pair=access.rules.map(r=>{if(r.kind==='all')return '1=1';if(!r.enterpriseCodes.length&&!r.districtCodes.length)return '0=1';const parts:string[]=[];
  if(r.enterpriseCodes.length){parts.push('(pf.enterprise_any=0 and pf.enterprise_code in ('+r.enterpriseCodes.map(()=>'?').join(',')+'))');params.push(...r.enterpriseCodes);}
  if(r.districtCodes.length){parts.push('(pf.district_any=0 and pf.district_code in ('+r.districtCodes.map(()=>'?').join(',')+'))');params.push(...r.districtCodes);}return '('+parts.join(' and ')+')';
 }).join(' or ')||'0=1';
 const c=buildComplaintScopeSql(access,'c'),e=buildEnterpriseScopeSql(access,'audit_e'),g=buildGridScopeSql(access,'audit_g');
 const codes=[...new Set(permissions)];const gates=codes.length?codes.map(()=>'?').join(','):"''";
 const sql='exists (select 1 from report_job rj join statistics_snapshot ss on ss.snapshot_id=rj.snapshot_id join report_record rr on rr.d3_report_id=rj.report_id where rj.report_id='+reportIdSql+
 ' and ss.proof_count>0 and ss.proof_count=(select count(*) from report_scope_proof pc where pc.snapshot_id=ss.snapshot_id) and exists(select 1 from report_scope_proof pd where pd.snapshot_id=ss.snapshot_id and pd.kind=\'domain\')'+
 ' and not exists(select 1 from json_table(ss.required_permissions,\'$[*]\' columns(code varchar(64) path \'$\')) rc where rc.code not in ('+gates+'))'+
 ' and not exists(select 1 from report_scope_proof pf where pf.snapshot_id=ss.snapshot_id and (coalesce(('+pair+'),0)=0'+
 " or (pf.kind='complaint' and not exists(select 1 from complaint c where c.complaint_id=pf.object_key and "+c.sql+'))'+
 " or (pf.kind='master' and not exists(select 1 from enterprise audit_e where audit_e.enterprise_code=pf.object_key and "+e.sql+'))'+
 " or (pf.kind='grid' and not exists(select 1 from service_grid audit_g where audit_g.grid_code=pf.object_key and "+g.sql+'))'+')) )';
 // Placeholder order: permissions precede frozen-pair predicates and current checks.
 return {sql,params:[...codes,...params,...c.params,...e.params,...g.params]};
}
