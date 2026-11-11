import type {AccessContext} from './accessScope';
export function canAccessGridCoverage(ctx:AccessContext,enterpriseCode:string,districts:(string|null)[]):boolean {
 const pair=(district:string|null)=>ctx.rules.some(r=>r.kind==='all'||((r.enterpriseCodes.length>0||r.districtCodes.length>0)&&(!r.enterpriseCodes.length||r.enterpriseCodes.includes(enterpriseCode))&&(!r.districtCodes.length||district!==null&&r.districtCodes.includes(district))));
 return districts.length?districts.every(pair):pair(null);
}
export function canAccessSpatialMaster(ctx:AccessContext,district:string|null):boolean{return ctx.rules.some(r=>r.kind==='all'||r.districtCodes.length>0&&district!==null&&r.districtCodes.includes(district));}
/** Whole current coverage: NOT EXISTS a denied member; a permitted member is insufficient. */
export function buildGridScopeSql(ctx:AccessContext,alias='g'):{sql:string;params:unknown[]} {
 if(!['g','audit_g'].includes(alias))throw Error('Uncontrolled grid SQL alias');
 const pairParams:unknown[]=[];const pairs=ctx.rules.map(r=>{if(r.kind==='all')return '1=1';const terms:string[]=[];if(r.enterpriseCodes.length){terms.push('scope_ge.enterprise_code in ('+r.enterpriseCodes.map(()=>'?').join(',')+')');pairParams.push(...r.enterpriseCodes);}if(r.districtCodes.length){terms.push('scope_ag.district_code in ('+r.districtCodes.map(()=>'?').join(',')+')');pairParams.push(...r.districtCodes);}return terms.length?'('+terms.join(' and ')+')':'0=1';});
 const pair='('+ (pairs.join(' or ')||'0=1') +')';
 // LEFT JOIN yields a NULL geographic pair for unmapped legacy grids. COALESCE
 // prevents SQL UNKNOWN from allowing missing district ownership.
 const sql='exists (select 1 from grid_enterprise scope_ge where scope_ge.grid_code='+alias+'.grid_code and not exists (select 1 from grid_enterprise other_ge where other_ge.grid_code='+alias+'.grid_code and other_ge.enterprise_code<>scope_ge.enterprise_code) and not exists (select 1 from (select 1 as seed) scope_seed left join service_grid_admin scope_ga on scope_ga.grid_code='+alias+'.grid_code and scope_ga.version='+alias+'.version left join admin_grid scope_ag on scope_ag.code=scope_ga.admin_grid_code where coalesce('+pair+',0)=0))';
 const unmapped=ctx.rules.some(r=>r.kind==='all')?' or not exists (select 1 from grid_enterprise unmapped_ge where unmapped_ge.grid_code='+alias+'.grid_code)':'';
 return {sql:"("+alias+".import_state<>'draft' or "+(ctx.rules.some(r=>r.kind==='all')?'1=1':'0=1')+') and ('+sql+unmapped+')',params:pairParams};
}
export function buildSpatialScopeSql(ctx:AccessContext,column:string){if(!['audit_ag.district_code','audit_cag.district_code'].includes(column))throw Error('Uncontrolled spatial scope column');const params:unknown[]=[];const terms=ctx.rules.map(r=>{if(r.kind==='all')return '1=1';if(!r.districtCodes.length)return '0=1';params.push(...r.districtCodes);return column+' in ('+r.districtCodes.map(()=>'?').join(',')+')';});return {sql:'('+(terms.join(' or ')||'0=1')+')',params};}
