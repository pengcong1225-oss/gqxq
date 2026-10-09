import {buildComplaintScopeSql,type AccessContext} from '../auth/accessScope';
import {buildGridScopeSql,canAccessGridCoverage} from '../auth/gridScope';
import {rowsIn} from './serviceGridRepo';
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
export interface CoverageDemand {enterpriseCode:string;businessType:string;dates:string[]}
export const STATISTICS_COVERAGE_LIMITS=Object.freeze({populationGroups:200,versions:1000,snapshotBytes:4*1024*1024,adminReferences:4000,geometryVertices:100000});
/** Count the bounded data work conservatively; malformed geometry still remains C2 unknown evidence. */
export function coverageVertexCount(coverage: GridCoverage): number {
    let total = 0;
    if (!Array.isArray(coverage.geometry?.features))
        return total;
    for (const feature of coverage.geometry.features) {
        const geometry = feature?.geometry;
        if (!geometry || !Array.isArray(geometry.coordinates))
            continue;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        for (const polygon of polygons) {
            if (!Array.isArray(polygon))
                continue;
            for (const ring of polygon)
                if (Array.isArray(ring))
                    total += ring.length;
        }
    }
    return total;
}

const date=(v:unknown)=>v instanceof Date?v.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):String(v).slice(0,10);
/** Sorted business days let each actual interval test relevance without scanning every day. */
function hasDayInInterval(days:string[],from:string,to:string|null):boolean {
 let low=0,high=days.length;
 while(low<high){const mid=(low+high)>>>1;if(days[mid]<from)low=mid+1;else high=mid;}
 return low<days.length&&(to===null||days[low]<to);
}
export async function readStatisticsCoverage(db: SqlExecutor, access: AccessContext, demands: CoverageDemand[], ranges: {
    from: string;
    to: string;
}[]): Promise<CoverageEvidence[]> {
    if (!demands.length)
        return [];
    if (demands.length > STATISTICS_COVERAGE_LIMITS.populationGroups)
        throw AppError.validation('统计覆盖企业与业务组合超过200，拒绝返回截断证据');
    const scope = buildGridScopeSql(access);
    const demanded = new Map(demands.map(d => [JSON.stringify([d.enterpriseCode, d.businessType]), d.dates]));
    const pairs = demands.map(() => '(?,?)').join(',');
    const intervals = ranges.map(() => '(r.valid_from<=? and (r.valid_to is null or r.valid_to>?))').join(' or ');
    const params = [...scope.params, ...ranges.flatMap(r => [r.to, r.from]), ...demands.flatMap(d => [d.enterpriseCode, d.businessType])];
    // First read only bounded metadata; reject oversized evidence before fetching its JSON.
    const metadata = await rowsIn(db, 'select g.grid_code,g.version as current_version,ge.enterprise_code as current_enterprise_code,r.version,r.valid_from,r.valid_to,octet_length(cast(r.snapshot as char)) as snapshot_bytes ' +
        'from service_grid g left join grid_enterprise ge on ge.grid_code=g.grid_code join service_grid_revision r on r.grid_code=g.grid_code ' +
        'where ' + scope.sql + " and g.import_state<>'draft' and (" + intervals + ') ' +
        "and (json_unquote(json_extract(r.snapshot,'$.enterpriseCode')),json_unquote(json_extract(r.snapshot,'$.businessType'))) in (" + pairs + ') ' +
        'order by g.grid_code,r.version desc limit ' + (STATISTICS_COVERAGE_LIMITS.versions + 1), params);
    if (metadata.length > STATISTICS_COVERAGE_LIMITS.versions)
        throw AppError.validation('统计有效覆盖版本超过1000，拒绝返回截断证据');
    if (metadata.reduce((n, r) => n + Number(r.snapshot_bytes), 0) > STATISTICS_COVERAGE_LIMITS.snapshotBytes)
        throw AppError.validation('统计覆盖快照超过4MiB，拒绝返回截断证据');
    if (!metadata.length)
        return [];
    const keys = metadata.map(() => '(?,?)').join(',');
    const revisions = await rowsIn(db, 'select grid_code,version,valid_from,valid_to,snapshot from service_grid_revision where (grid_code,version) in (' + keys + ')', metadata.flatMap(r => [r.grid_code, r.version]));
    const byKey = new Map(metadata.map(r => [JSON.stringify([String(r.grid_code), String(r.version)]), r]));
    const candidates: {
        coverage: GridCoverage;
        currentEnterprise: string;
    }[] = [];
    let vertices = 0;
    for (const r of revisions) {
        const coverage = { ...(typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot) as GridCoverage, version: String(r.version), validFrom: date(r.valid_from), validTo: r.valid_to == null ? null : date(r.valid_to) };
        const days = demanded.get(JSON.stringify([coverage.enterpriseCode, coverage.businessType]));
        if (coverage.coverageState !== 'maintained' || !days || !hasDayInInterval(days, coverage.validFrom, coverage.validTo))
            continue;
        vertices += coverageVertexCount(coverage);
        if (vertices > STATISTICS_COVERAGE_LIMITS.geometryVertices)
            throw AppError.validation('统计覆盖几何顶点超过100000，拒绝返回截断证据');
        const m = byKey.get(JSON.stringify([String(r.grid_code), String(r.version)]))!;
        candidates.push({ coverage, currentEnterprise: m.current_enterprise_code == null ? '' : String(m.current_enterprise_code) });
    }
    const currentKeys = [...new Map(metadata.map(r => [String(r.grid_code), r])).values()];
    const currentRelations = await rowsIn(db, 'select grid_code,admin_grid_code from service_grid_admin where (grid_code,version) in (' + currentKeys.map(() => '(?,?)').join(',') + ') limit ' + (STATISTICS_COVERAGE_LIMITS.adminReferences + 1), currentKeys.flatMap(r => [r.grid_code, r.current_version]));
    const adminCodes = [...new Set([...currentRelations.map(r => String(r.admin_grid_code)), ...candidates.flatMap(r => r.coverage.adminGridCodes)])];
    const historicalReferences = candidates.reduce((n, c) => n + c.coverage.adminGridCodes.length, 0);
    if (currentRelations.length + historicalReferences > STATISTICS_COVERAGE_LIMITS.adminReferences || adminCodes.length > STATISTICS_COVERAGE_LIMITS.adminReferences)
        throw AppError.validation('统计覆盖行政关联超过4000，拒绝返回截断证据');
    const admins = adminCodes.length ? await rowsIn(db, 'select code,district_code from admin_grid where code in (' + adminCodes.map(() => '?').join(',') + ')', adminCodes) : [];
    const districts = new Map(admins.map(r => [String(r.code), r.district_code == null ? null : String(r.district_code)]));
    const currentByGrid = new Map<string, (string | null)[]>();
    for (const r of currentRelations) {
        const list = currentByGrid.get(String(r.grid_code)) ?? [];
        list.push(districts.get(String(r.admin_grid_code)) ?? null);
        currentByGrid.set(String(r.grid_code), list);
    }
    const result: CoverageEvidence[] = [];
    for (const { coverage, currentEnterprise } of candidates) {
        const currentDistricts = currentByGrid.get(coverage.code) ?? [];
        const originalDistricts = coverage.adminGridCodes.map(code => districts.get(code) ?? null);
        if (!canAccessGridCoverage(access, currentEnterprise, currentDistricts) || !canAccessGridCoverage(access, coverage.enterpriseCode, originalDistricts))
            continue;
        result.push({ coverage, current: { enterpriseCode: currentEnterprise, districtCodes: currentDistricts }, original: { enterpriseCode: coverage.enterpriseCode, districtCodes: originalDistricts } });
    }
    return result;
}
