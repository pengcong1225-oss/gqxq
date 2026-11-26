import {buildComplaintScopeSql,type AccessContext} from '../auth/accessScope';
import {buildGridScopeSql,canAccessGridCoverage} from '../auth/gridScope';
import {rowsIn} from './serviceGridRepo';
import type {SqlExecutor} from './userRepo';
import type {GridCoverage} from '../types/serviceGrid';
import type {StatisticsQuery} from '../types/statistics';
import {AppError} from '../http/errors';
import {excludeIntegrationTestsSql} from '../domain/integrationTestPolicy';
import {resolveComparisonPeriods,toShanghaiHalfOpenRange} from '../domain/statisticsQuery';
// Explicit scalars only. Original source/callback JSON never enters this relation.
const columns=['id','complaint_id','complaint_no','title','business_type','complaint_type','major_category_code','minor_category_code','category_dictionary_version','district_code','district_name','enterprise_code','enterprise_name','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source','source_reported_at','received_at','edit_version','source_system','source_id','source_channel','urgency_level','correction_status','correction_confidence','source_event_status','source_synced_at','overtime_flag','supervision_status','reporting_status','closed_in_system','is_sensitive','sensitive_keywords','status','created_at'];
/**
 * 大屏专用窄列读取：只取 screen 域真正用到的 16 列。
 * 完整 38 列 × 2 万行 × 3 个行业请求 = 首屏 4s+；窄列后行解析成本降一个量级。
 */
const screenColumns = ['complaint_id','complaint_no','source_system','source_id','business_type','complaint_type','major_category_code','minor_category_code','district_code','enterprise_code','enterprise_name','admin_grid_code','community_code','location_lng','location_lat','source_reported_at','received_at','source_event_status','satisfaction_code','source_synced_at','source_completed_at','source_deadline_at','status'];
/**
 * 计算统计所需的最早日期（SQL 下界），把「全表扫描」改成「索引范围扫描」。
 *
 * 为什么需要下界：`buildScreen` 会用到
 *   · 期间统计：yesterday / month / quarter / year —— 最早到「今年 1 月 1 日」
 *   · 明细筛选：用户可能选到很早的日期
 * 常规统计从所选起始日所在年的 1 月 1 日开始，去年同期单独读取。
 *
 * 性能背景（实测 2026-11-20）：原查询无时间条件，对 53,339 行 / 1.1GB 的表做全表扫描
 * + `order by received_at`，单次 3.1 秒；大屏首屏要发 6 次 bootstrap → 约 30 秒。
 * 加下界后命中 idx_complaint_reported_at，近 30 天窗口 3154ms → 10ms。
 */
export function screenStatisticsLowerBound(q: {from:string}): string {
  const from = q.from.slice(0, 10);
  const y = Number(from.slice(0, 4));
  if (!Number.isFinite(y)) return from;
  const yearStart = `${y}-01-01`;
  return yearStart < from ? yearStart : from;
}

export async function readScreenStatisticsRows(db:SqlExecutor,q:StatisticsQuery,access:AccessContext){
 const scope=buildComplaintScopeSql(access,'c');
 /**
  * 时间条件写成可走索引的形式：
  *   (source_reported_at >= 下界) or (source_reported_at is null and received_at >= 下界)
  *
  * 不用 `coalesce(source_reported_at, received_at) >= ?` —— 函数包裹列会让
  * idx_complaint_reported_at 完全失效（EXPLAIN type=ALL，全表扫描）。
  * 实测分布：source_reported_at 非空 53339/53339，null 分支实际不会命中，
  * 保留它是为了语义完整（真有 null 时仍按 received_at 兜底）。
  */
 const lower=screenStatisticsLowerBound(q);
 const timeSql='(c.source_reported_at >= ? or (c.source_reported_at is null and c.received_at >= ?))';
 const rows=await rowsIn(db,'select '+screenColumns.map(c=>'c.'+c).join(',')+' from complaint c where '+scope.sql+' and '+excludeIntegrationTestsSql('c')+' and '+timeSql+' order by c.received_at desc,c.id desc limit 100001',[...scope.params,lower,lower]);
 if(rows.length>100000)throw AppError.validation('授权数据集超过10万条，请联系管理员规划统计容量；未返回截断统计');
 return rows;
}

export async function readScreenPriorRows(
  db: SqlExecutor, range: { from: string; to: string }, access: AccessContext, businessType?: string,
) {
  const scope = buildComplaintScopeSql(access, 'c');
  const window = toShanghaiHalfOpenRange(range);
  const from = new Date(window.start), to = new Date(window.end);
  const rows = await rowsIn(db,
    `select ${screenColumns.map(c => 'c.' + c).join(',')} from complaint c
      where ${scope.sql} and ${excludeIntegrationTestsSql('c')}
        and c.source_system = '宜接就办' and c.source_id <> ''${businessType ? ' and c.business_type = ?' : ''}
        and ((c.source_reported_at >= ? and c.source_reported_at < ?)
          or (c.source_reported_at is null and c.received_at >= ? and c.received_at < ?))
      order by c.received_at desc,c.id desc limit 100001`,
    [...scope.params, ...(businessType ? [businessType] : []), from, to, from, to]);
  if (rows.length > 100000) throw AppError.validation('授权同期数据集超过10万条，未返回截断统计');
  return rows;
}
type SeasonalSelection = {
  businessType: string;
  majorCodes: readonly string[];
  minorCodes: readonly string[];
  effectiveFrom: string;
  effectiveTo: string;
};

function buildSeasonalStatisticsWhere(
  access: AccessContext,
  rule: SeasonalSelection,
  range: { from: string; to: string },
) {
  const from = range.from < rule.effectiveFrom ? rule.effectiveFrom : range.from;
  const to = range.to > rule.effectiveTo ? rule.effectiveTo : range.to;
  if (from > to) return { sql: '0 = 1', params: [] };

  const categories: string[] = [];
  const categoryParams: string[] = [];
  for (const [column, codes] of [
    ['major_category_code', rule.majorCodes],
    ['minor_category_code', rule.minorCodes],
  ] as const) {
    if (!codes.length) continue;
    // Preserve the original summary's exact code matching under case-insensitive MySQL collations.
    categories.push(`cast(c.${column} as binary) in (${codes.map(() => '?').join(',')})`);
    categoryParams.push(...codes);
  }
  if (!categories.length) return { sql: '0 = 1', params: [] };

  const scope = buildComplaintScopeSql(access, 'c');
  const { start, end } = toShanghaiHalfOpenRange({ from, to });
  return {
    sql: [
      scope.sql,
      excludeIntegrationTestsSql('c'),
      'c.source_reported_at >= ? and c.source_reported_at < ?',
      'cast(c.business_type as binary) = ?',
      '(' + categories.join(' or ') + ')',
    ].join(' and '),
    params: [...scope.params, new Date(start), new Date(end), rule.businessType, ...categoryParams],
  };
}

export async function readSeasonalStatisticsRows(
  db: SqlExecutor,
  access: AccessContext,
  rule: SeasonalSelection,
  range: { from: string; to: string },
) {
  const { sql, params } = buildSeasonalStatisticsWhere(access, rule, range);
  // Summary queries stay on the covering index. Display fields are fetched by the detail query.
  return rowsIn(db, 'select c.source_reported_at, c.admin_grid_code from complaint c where ' + sql, params);
}

export async function readSeasonalStatisticsDetails(
  db: SqlExecutor,
  access: AccessContext,
  rule: SeasonalSelection,
  range: { from: string; to: string },
  page: number,
  size: number,
) {
  const { sql, params } = buildSeasonalStatisticsWhere(access, rule, range);
  const [count] = await rowsIn(db, 'select count(*) n from complaint c where ' + sql, params);
  const total = Number(count?.n ?? 0);
  const offset = (page - 1) * size;
  const rows = offset < total ? await rowsIn(db,
    'select c.complaint_id complaintId, c.complaint_no complaintNo, c.title, ' +
      'coalesce(c.minor_category_code,c.major_category_code) categoryCode, ' +
      'c.admin_grid_code adminGridCode, c.enterprise_name enterpriseName, c.source_reported_at reportedAt ' +
      'from complaint c where ' + sql + ' order by c.source_reported_at desc, c.id desc limit ? offset ?',
    [...params, size, offset],
  ) : [];
  return { total, rows };
}

export async function readStatisticsRows(db:SqlExecutor,q:StatisticsQuery,access:AccessContext){
 const scope=buildComplaintScopeSql(access,'c');
 const analysis=q.dataset==='analysis';const ar=analysis?',ar.analysis_id,ar.business_type as entry_business_type,ar.complaint_type as entry_complaint_type,ar.district_code as entry_district_code,ar.district_name as entry_district_name,ar.enterprise_code as entry_enterprise_code,ar.enterprise_name as entry_enterprise_name,ar.summary as entry_title,ar.confirmed_at,ar.statistics_snapshot_version,ar.statistics_snapshot':',null as analysis_id';
 const whereParts: string[] = [scope.sql, excludeIntegrationTestsSql('c')];
 const whereParams: unknown[] = [...scope.params];
 // 入库快照的日期、业务和分类取自冻结数据。当前诉求仍是授权依据。
 if (q.projection === 'current') {
   if (q.from && q.to) {
     // 保留缺来源日期的记录，以便按口径标记排除原因或回落接收时间。
     const datePredicates = ['c.source_reported_at is null'];
     for (const {from,to} of [q, ...resolveComparisonPeriods(q)]) {
       if (!from || !to) continue;
       const {start,end} = toShanghaiHalfOpenRange({from,to});
       datePredicates.push('(c.source_reported_at >= ? and c.source_reported_at < ?)');
       whereParams.push(new Date(start), new Date(end));
     }
     whereParts.push('(' + datePredicates.join(' or ') + ')');
   }
   if (q.businessType) {
     whereParts.push('c.business_type = ?');
     whereParams.push(q.businessType);
   }
 }
 const rows=await rowsIn(db,'select '+columns.map(c=>'c.'+c).join(',')+ar+' from complaint c'+(analysis?' join analysis_record ar on ar.complaint_id=c.complaint_id':'')+' where '+whereParts.join(' and ')+' order by c.received_at desc,c.id desc limit 100001',whereParams);
 if(rows.length>100000)throw AppError.validation('授权数据集超过10万条，请联系管理员规划统计容量；未返回截断统计');return rows;
}
/** Explicit legacy-membership/no-date browser branch, no statistics/comparison formula. */
export function buildLegacyAnalysisWhere(filter:{districtCode?:string;businessType?:string;enterpriseCode?:string},access:AccessContext,mode:'legacy-membership/no-date'){
 if(mode!=='legacy-membership/no-date')throw Error('Explicit legacy membership mode required');const scope=buildComplaintScopeSql(access,'scope_c');
 const parts=['exists (select 1 from complaint scope_c where scope_c.complaint_id=analysis_record.complaint_id and '+scope.sql+' and '+excludeIntegrationTestsSql('scope_c')+')'];const params:unknown[]=[...scope.params];
 for(const [name,column] of [['districtCode','district_code'],['businessType','business_type'],['enterpriseCode','enterprise_code']] as const)if(filter[name]!==undefined){parts.push(column+'=?');params.push(filter[name]);}
 return {text:parts.join(' and '),params};
}
export interface CoverageEvidence {coverage:GridCoverage;selectedBusinessDays:string[];current:{enterpriseCode:string;districtCodes:(string|null)[]};original:{enterpriseCode:string;districtCodes:(string|null)[]}}
export interface CoverageDemand {enterpriseCode:string;businessType:string;dates:string[]}
export const STATISTICS_COVERAGE_LIMITS=Object.freeze({populationGroups:200,versions:1000,snapshotBytes:4*1024*1024,adminReferences:4000,geometryVertices:100000,winnerDayChecks:2000000});
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
    const demandedDaySets = new Map(demands.map(d => [JSON.stringify([d.enterpriseCode, d.businessType]), new Set(d.dates)]));
    const pairs = demands.map(() => '(?,?)').join(',');
    const intervals = ranges.map(() => '(r.valid_from<=? and (r.valid_to is null or r.valid_to>?))').join(' or ');
    const candidateIntervals = intervals.replaceAll('r.', 'candidate_r.');
    const params = [...scope.params, ...ranges.flatMap(r => [r.to, r.from]), ...ranges.flatMap(r => [r.to, r.from]), ...demands.flatMap(d => [d.enterpriseCode, d.businessType])];
    // First read only bounded metadata; reject oversized evidence before fetching its JSON.
    // Candidate population limits grids, never sibling versions: the actual highest version must shadow older geometry even when unusable.
    const metadata = await rowsIn(db, "select g.grid_code,g.version as current_version,ge.enterprise_code as current_enterprise_code,r.version,r.valid_from,r.valid_to,json_unquote(json_extract(r.snapshot,'$.enterpriseCode')) as population_enterprise,json_unquote(json_extract(r.snapshot,'$.businessType')) as population_business,octet_length(cast(r.snapshot as char)) as snapshot_bytes " +
        'from service_grid g left join grid_enterprise ge on ge.grid_code=g.grid_code join service_grid_revision r on r.grid_code=g.grid_code ' +
        'where ' + scope.sql + " and g.import_state<>'draft' and (" + intervals + ') ' +
        'and exists (select 1 from service_grid_revision candidate_r where candidate_r.grid_code=g.grid_code and (' + candidateIntervals + ') ' +
        "and (json_unquote(json_extract(candidate_r.snapshot,'$.enterpriseCode')),json_unquote(json_extract(candidate_r.snapshot,'$.businessType'))) in (" + pairs + ')) ' +
        'order by g.grid_code,r.version desc limit ' + (STATISTICS_COVERAGE_LIMITS.versions + 1), params);
    if (metadata.length > STATISTICS_COVERAGE_LIMITS.versions)
        throw AppError.validation('统计有效覆盖版本超过1000，拒绝返回截断证据');
    if (metadata.reduce((n, r) => n + Number(r.snapshot_bytes), 0) > STATISTICS_COVERAGE_LIMITS.snapshotBytes)
        throw AppError.validation('统计覆盖快照超过4MiB，拒绝返回截断证据');
    if (!metadata.length)
        return [];
    for (const r of metadata) {
        r.from_day = date(r.valid_from);
        r.to_day = r.valid_to == null ? null : date(r.valid_to);
    }
    const byGrid = new Map<string, typeof metadata>();
    for (const r of metadata) {
        const group = byGrid.get(String(r.grid_code)) ?? [];
        group.push(r);
        byGrid.set(String(r.grid_code), group);
    }
    const selectedDays = new Map<string, string[]>();
    let winnerDayChecks = 0;
    for (const versions of byGrid.values()) {
        const distinctPopulations = new Set<string>();
        const daySet = new Set<string>();
        for (const r of versions) {
            const population = JSON.stringify([r.population_enterprise, r.population_business]);
            if (distinctPopulations.has(population)) continue;
            distinctPopulations.add(population);
            for (const day of demanded.get(population) ?? []) daySet.add(day);
        }
        const days = [...daySet].sort();
        winnerDayChecks += days.length * versions.length;
        if (winnerDayChecks > STATISTICS_COVERAGE_LIMITS.winnerDayChecks)
            throw AppError.validation('统计最高覆盖版本日期选择超过2000000次，拒绝返回截断证据');
        versions.sort((a, b) => BigInt(a.version as string) > BigInt(b.version as string) ? -1 : BigInt(a.version as string) < BigInt(b.version as string) ? 1 : 0);
        for (const day of days) {
            const winner = versions.find(r => (r.from_day as string) <= day && (r.to_day === null || (r.to_day as string) > day));
            if (!winner)
                continue;
            const populationDays = demandedDaySets.get(JSON.stringify([winner.population_enterprise, winner.population_business]));
            if (!populationDays?.has(day))
                continue;
            const key = JSON.stringify([String(winner.grid_code), String(winner.version)]);
            const selected = selectedDays.get(key) ?? [];
            selected.push(day);
            selectedDays.set(key, selected);
        }
    }
    const selectedMetadata = metadata.filter(r => selectedDays.has(JSON.stringify([String(r.grid_code), String(r.version)])));
    if (!selectedMetadata.length)
        return [];
    const keys = selectedMetadata.map(() => '(?,?)').join(',');
    const revisions = await rowsIn(db, 'select grid_code,version,valid_from,valid_to,snapshot from service_grid_revision where (grid_code,version) in (' + keys + ')', selectedMetadata.flatMap(r => [r.grid_code, r.version]));
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
        result.push({ coverage, selectedBusinessDays: selectedDays.get(JSON.stringify([coverage.code, coverage.version]))!, current: { enterpriseCode: currentEnterprise, districtCodes: currentDistricts }, original: { enterpriseCode: coverage.enterpriseCode, districtCodes: originalDistricts } });
    }
    return result;
}




