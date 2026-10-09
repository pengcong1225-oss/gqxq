import {buildComplaintScopeSql,type AccessContext} from '../auth/accessScope';
import {buildGridScopeSql,canAccessGridCoverage} from '../auth/gridScope';
import {readGridIn,readCoverageIn,currentDistrictsIn,readAdminIn,rowsIn} from './serviceGridRepo';
import type {SqlExecutor} from './userRepo';
import type {GridCoverage} from '../types/serviceGrid';
import type {StatisticsQuery} from '../types/statistics';
import {AppError} from '../http/errors';
// Explicit scalars only. Original source/callback JSON never enters this relation.
const columns=['id','complaint_id','complaint_no','title','business_type','complaint_type','major_category_code','minor_category_code','category_dictionary_version','district_code','district_name','enterprise_code','enterprise_name','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source','source_reported_at','received_at','edit_version','source_system','source_id','source_channel','urgency_level','correction_status','correction_confidence','source_event_status','overtime_flag','supervision_status','reporting_status','closed_in_system','is_sensitive','sensitive_keywords','status','created_at'];
export async function readStatisticsRows(db:SqlExecutor,q:StatisticsQuery,access:AccessContext){
 const scope=buildComplaintScopeSql(access,'c');
 const analysis=q.dataset==='analysis';const ar=analysis?',ar.analysis_id,ar.business_type as entry_business_type,ar.complaint_type as entry_complaint_type,ar.district_code as entry_district_code,ar.district_name as entry_district_name,ar.enterprise_code as entry_enterprise_code,ar.enterprise_name as entry_enterprise_name,ar.summary as entry_title,ar.confirmed_at,ar.statistics_snapshot_version,ar.statistics_snapshot':',null as analysis_id';
 const rows=await rowsIn(db,'select '+columns.map(c=>'c.'+c).join(',')+ar+' from complaint c'+(analysis?' join analysis_record ar on ar.complaint_id=c.complaint_id':'')+' where '+scope.sql+' order by c.received_at desc,c.id desc limit 100001',scope.params);
 if(rows.length>100000)throw AppError.validation('授权数据集超过10万条，请联系管理员规划统计容量；未返回截断统计');return rows;
}
/** Explicit legacy-membership/no-date browser branch, no statistics/comparison formula. */
export function buildLegacyAnalysisWhere(filter:{districtCode?:string;businessType?:string;enterpriseCode?:string},access:AccessContext,mode:'legacy-membership/no-date'){
 if(mode!=='legacy-membership/no-date')throw Error('Explicit legacy membership mode required');const scope=buildComplaintScopeSql(access,'scope_c');
 const parts=['exists (select 1 from complaint scope_c where scope_c.complaint_id=analysis_record.complaint_id and '+scope.sql+')'];const params:unknown[]=[...scope.params];
 for(const [name,column] of [['districtCode','district_code'],['businessType','business_type'],['enterpriseCode','enterprise_code']] as const)if(filter[name]!==undefined){parts.push(column+'=?');params.push(filter[name]);}
 return {text:parts.join(' and '),params};
}
export interface CoverageEvidence {coverage:GridCoverage;current:{enterpriseCode:string;districtCodes:(string|null)[]};original:{enterpriseCode:string;districtCodes:(string|null)[]}}
export async function readStatisticsCoverage(db:SqlExecutor,access:AccessContext,dates:string[]):Promise<CoverageEvidence[]>{
 const scope=buildGridScopeSql(access);const grids=await rowsIn(db,'select g.grid_code from service_grid g where '+scope.sql+" and g.import_state<>'draft'",scope.params);const result=new Map<string,CoverageEvidence>();
 for(const g of grids){const row=await readGridIn(db,String(g.grid_code));if(!row)continue;const currentDistricts=await currentDistrictsIn(db,row);
  for(const date of dates){const coverage=await readCoverageIn(db,row,date);if(!coverage||coverage.coverageState!=='maintained')continue;const historicDistricts=[];for(const a of coverage.adminGridCodes)historicDistricts.push((await readAdminIn(db,a))?.districtCode??null);
   if(!canAccessGridCoverage(access,row.enterprise_code,currentDistricts)||!canAccessGridCoverage(access,coverage.enterpriseCode,historicDistricts))continue;
   result.set(coverage.code+':'+coverage.version,{coverage,current:{enterpriseCode:row.enterprise_code,districtCodes:currentDistricts},original:{enterpriseCode:coverage.enterpriseCode,districtCodes:historicDistricts}});
  }
 }return [...result.values()];
}
