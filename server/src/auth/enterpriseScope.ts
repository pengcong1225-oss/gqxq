// Explicit master ownership; never infer district from service_area or complaints.
import type { AccessContext } from './accessScope';
export function canAccessEnterprise(ctx:AccessContext,row:{enterpriseCode:string;districtCode:string|null}):boolean {
 return ctx.rules.some(r=>r.kind==='all'||((r.enterpriseCodes.length>0||r.districtCodes.length>0)&&(!r.enterpriseCodes.length||r.enterpriseCodes.includes(row.enterpriseCode))&&(!r.districtCodes.length||row.districtCode!==null&&r.districtCodes.includes(row.districtCode))));
}
export function buildEnterpriseScopeSql(ctx:AccessContext,alias='e'):{sql:string;params:unknown[]} {
 if(alias!=='e'&&alias!=='audit_e')throw Error('Uncontrolled enterprise SQL alias');
 const params:unknown[]=[];const rules=ctx.rules.map(r=>{if(r.kind==='all')return '1 = 1';const terms:string[]=[];
 for(const [column,values] of [['enterprise_code',r.enterpriseCodes],['district_code',r.districtCodes]] as const)if(values.length){terms.push(alias+'.'+column+' in ('+values.map(()=>'?').join(',')+')');params.push(...values);}
 return terms.length?'('+terms.join(' and ')+')':'0 = 1';});return {sql:'('+(rules.join(' or ')||'0 = 1')+')',params};
}
