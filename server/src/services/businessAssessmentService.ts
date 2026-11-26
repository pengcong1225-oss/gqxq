import {createHash} from 'node:crypto';
import type {Tx} from '../db/tx';
import {withTransaction} from '../db/tx';
import {AppError} from '../http/errors';
import {normalizeStatisticsQuery,shanghaiToday} from '../domain/statisticsQuery';
import {compareAdminGrids,topCategories,samePeriodYear,seasonRange} from '../domain/businessAssessment';
import {captureStatisticsIn} from './statisticsService';
import {readSeasonalStatisticsDetails,readSeasonalStatisticsRows} from '../repositories/statisticsRepo';
import {eventRows} from '../repositories/sourceBusinessRepo';
import {buildSpatialScopeSql} from '../auth/gridScope';
import {featurePermission} from './businessFeatureAuth';
import {publishedRules,type BusinessRule} from './businessRuleService';
import type {BusinessEventContext} from '../types/businessEvents';
import type {StatisticsComplaint,StatisticsQuery} from '../types/statistics';
export async function assessmentAdminGrids(tx:Pick<Tx,'query'>,ctx:BusinessEventContext){
  featurePermission(ctx,'grid.read');
  const scope=buildSpatialScopeSql(ctx.access,'audit_ag.district_code');
  return eventRows(tx,'select audit_ag.code,audit_ag.name,audit_ag.district_code,audit_ag.version,audit_ag.geometry,audit_ag.geometry_source from admin_grid audit_ag where audit_ag.code<>audit_ag.district_code and '+scope.sql+' order by audit_ag.code',scope.params);
}
const detail=(r:StatisticsComplaint)=>({complaintId:r.complaintId,complaintNo:r.complaintNo,adminGridCode:r.adminGridCode,businessAt:r.businessAt,majorCode:r.majorCode,dictionaryVersion:r.dictionaryVersion});
function metadata(rows:StatisticsComplaint[],q:StatisticsQuery,cutoff:string){return {snapshotId:createHash('sha256').update(JSON.stringify({q,rows:rows.map(r=>[r.complaintId,r.editVersion,r.adminGridCode,r.dictionaryVersion,r.businessAt])})).digest('hex'),query:q,timezone:'Asia/Shanghai',timeBasis:'宜接就办来源录入时间；缺失排除',dataCutoffAt:cutoff,categoryVersions:[...new Set(rows.map(r=>r.dictionaryVersion).filter(Boolean))],sourceTimeFallbackCount:rows.filter(r=>r.timeSource==='received_fallback').length,coverageStatus:'observed_records',coverageNote:'历史统计基于已接入记录；来源完整覆盖尚未认证，无记录不表示历史完整且为零'};}
export async function compareGrids(raw:Record<string,unknown>,ctx:BusinessEventContext){featurePermission(ctx,'assessment.read');const {adminGridCodes,categoryLevel,...query}=raw;const codes=typeof adminGridCodes==='string'?adminGridCodes.split(','):adminGridCodes;if(!Array.isArray(codes)||!codes.every(c=>typeof c==='string'))throw AppError.validation('行政网格选择无效');compareAdminGrids(codes,[]);
 // 标书 1.2.8「按照诉求类型进行诉求量对比」：默认按小类（g01…/w01…）；categoryLevel=major 兼容大类口径
 if(categoryLevel!==undefined&&categoryLevel!==null&&categoryLevel!==''&&categoryLevel!=='major'&&categoryLevel!=='minor')throw AppError.validation('分类层级无效（仅支持 major / minor）');
 const level=(categoryLevel==='major'?'major':'minor') as 'major'|'minor';
 const q=normalizeStatisticsQuery({...query,comparisonPolicyId:'procurement-source-completed-v2'},ctx.access);
 return withTransaction(async tx=>{
  const grids=await assessmentAdminGrids(tx,ctx);
  const directory=new Set(grids.map(g=>String(g.code)));
  if(codes.some(code=>!directory.has(code)))throw AppError.notFound('行政网格不存在或不在授权范围');
  const capture=await captureStatisticsIn(tx,q,ctx.access,ctx.permissionCodes);
  const rows=capture.periodFacts.find(p=>p.kind==='current')!.rows;
  const result=compareAdminGrids(codes,rows,level);
  return {...metadata(rows,q,capture.summary.dataCutoffAt),...result,
   unlocatedCount:rows.filter(r=>!r.adminGridCode||!directory.has(r.adminGridCode)).length,
   grids:grids.filter(g=>codes.includes(String(g.code))).map(g=>({code:g.code,name:g.name,version:g.version,hasGeometry:!!g.geometry})),
   partial:capture.summary.partial,
   details:ctx.permissionCodes.includes('complaint.read')?rows.filter(r=>r.adminGridCode&&codes.includes(r.adminGridCode)).map(detail):null,
  };
 });
}
export async function historicalAssessment(raw:Record<string,unknown>,ctx:BusinessEventContext){featurePermission(ctx,'assessment.read');const q=normalizeStatisticsQuery({...raw,comparisonPolicyId:'procurement-source-completed-v2'},ctx.access);const lastYear=Number(q.from.slice(0,4))-1;const earliest=samePeriodYear(q.from,lastYear-4),latest=samePeriodYear(q.to,Number(q.to.slice(0,4))-1);
 return withTransaction(async tx=>{const broad={...q,periodKind:'custom' as const,from:earliest,to:latest};const capture=await captureStatisticsIn(tx,broad,ctx.access,ctx.permissionCodes);
 const rows=capture.rows;const years=Array.from({length:5},(_,i)=>{const year=lastYear-i,from=samePeriodYear(q.from,year),to=samePeriodYear(q.to,Number(q.to.slice(0,4))-(i+1));const selected=rows.filter(r=>r.businessDay&&r.businessDay>=from&&r.businessDay<=to);return {year,from,to,count:selected.length||null,top3:topCategories(selected,3).map(b=>({...b,name:capture.categoryEvidence.find(e=>e.code===b.code&&e.dictionaryVersion===b.dictionaryVersion)?.name??b.code})),categoryUnknownCount:selected.filter(r=>!r.majorCode||!r.dictionaryVersion).length,status:selected.length?'observed':'insufficient',details:ctx.permissionCodes.includes('complaint.read')?selected.map(detail):null};});return {...metadata(rows,q,capture.summary.dataCutoffAt),calendarAlignment:'按同月同日对齐；闰日映射到2月28日，跨年保持原跨度',closureBasis:'宜接就办来源明确 completed 且有同步证据；按来源录入时间',years};});
}
function seasonalRequest(raw: Record<string, unknown>, allowedKeys: string[]) {
  if (Object.keys(raw).some(key => !allowedKeys.includes(key))) throw AppError.validation('保障季参数无效');
  const { scene, businessType } = raw;
  if (scene !== 'winter' && scene !== 'summer') throw AppError.validation('保障季类型无效');
  if (businessType !== 'water' && businessType !== 'gas') throw AppError.validation('业务类型无效');
  const year = Number(raw.year);
  const today = shanghaiToday();
  if (!Number.isInteger(year) || year < 1005 || year > Number(today.slice(0, 4))) {
    throw AppError.validation('年份无效');
  }
  return { scene, businessType, year, today };
}

async function seasonalRule(tx: Tx, { scene, businessType }: ReturnType<typeof seasonalRequest>) {
  const rules = (await publishedRules(tx, 'seasonal')).filter(
    rule => rule.enabled && rule.scene === scene && rule.businessType === businessType,
  );
  return rules.length === 1 ? rules[0] : null;
}

const unconfiguredSeason = { status: 'unconfigured', reason: '该业务保障季及正式分类映射尚未发布' } as const;
const notStartedSeason = { status: 'not_started', reason: '所选保障季尚未开始' } as const;

function seasonWindow(year: number, rule: BusinessRule, today: string) {
  const range = seasonRange(year, rule.startMonth!, rule.endMonth!);
  const observedTo = range.to > today ? today : range.to;
  return { year, ...range, observedTo, truncated: observedTo < range.to };
}

function ruleCovers(rule: BusinessRule, from: string, to: string) {
  return from >= rule.effectiveFrom && to <= rule.effectiveTo;
}

export async function seasonalDetails(raw: Record<string, unknown>, ctx: BusinessEventContext) {
  featurePermission(ctx, 'assessment.read');
  featurePermission(ctx, 'complaint.read');
  const request = seasonalRequest(raw, ['scene', 'businessType', 'year', 'page', 'size']);
  const page = Number(raw.page ?? 1);
  const size = Number(raw.size ?? 20);
  if (!Number.isSafeInteger(page) || page < 1) throw AppError.validation('页码无效');
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw AppError.validation('每页条数无效（1~100）');

  return withTransaction(async tx => {
    const empty = { total: null, page, size, items: [] };
    const rule = await seasonalRule(tx, request);
    if (!rule) return { ...empty, ...unconfiguredSeason };

    const season = seasonWindow(request.year, rule, request.today);
    if (season.from > request.today) return { ...empty, ...notStartedSeason, season };
    if (!ruleCovers(rule, season.from, season.observedTo)) {
      return { ...empty, season, status: 'outside_rule_period', reason: '规则有效期未覆盖所选保障季' };
    }

    const { total, rows } = await readSeasonalStatisticsDetails(
      tx, ctx.access, rule, { from: season.from, to: season.observedTo }, page, size,
    );
    if (!total) return { ...empty, season, status: 'insufficient', reason: '本季暂无接入记录，资料不足' };
    return {
      status: 'available',
      season,
      total,
      page,
      size,
      items: rows.map(r => ({
        complaintId: String(r.complaintId ?? ''),
        complaintNo: String(r.complaintNo ?? ''),
        title: String(r.title ?? ''),
        categoryCode: String(r.categoryCode ?? ''),
        adminGridCode: r.adminGridCode ? String(r.adminGridCode) : null,
        enterpriseName: r.enterpriseName ? String(r.enterpriseName) : null,
        reportedAt: r.reportedAt instanceof Date
          ? r.reportedAt.toISOString()
          : r.reportedAt ? new Date(String(r.reportedAt)).toISOString() : null,
      })),
    };
  });
}

export async function seasonalAssessment(raw: Record<string, unknown>, ctx: BusinessEventContext) {
  featurePermission(ctx, 'assessment.read');
  const request = seasonalRequest(raw, ['scene', 'businessType', 'year']);

  return withTransaction(async tx => {
    const rule = await seasonalRule(tx, request);
    if (!rule) return unconfiguredSeason;
    const { year, today } = request;
    const ranges = Array.from({ length: 5 }, (_, i) => seasonWindow(year - i, rule, today));
    const [currentRange, previousRange] = ranges;
    if (currentRange.from > today) return notStartedSeason;
    const q = normalizeStatisticsQuery({
      dataset: 'ledger', projection: 'current', periodKind: 'custom',
      from: ranges[4].from, to: currentRange.observedTo,
      comparisonPolicyId: 'procurement-source-completed-v2', businessType: rule.businessType,
    }, ctx.access);
    const narrow = await readSeasonalStatisticsRows(tx, ctx.access, rule, q);
    const all = narrow.map(r => ({
      // mysql2 returns a Date for the Shanghai wall clock stored in DATETIME.
      businessDay: r.source_reported_at instanceof Date
        ? new Date(r.source_reported_at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
        : String(r.source_reported_at ?? '').slice(0, 10),
      adminGridCode: (r.admin_grid_code ?? null) as string | null,
    }));
    const selected = (from: string, to: string) => all.filter(r => r.businessDay >= from && r.businessDay <= to);
    const seasonCount = (from: string, to: string) => {
      if (!ruleCovers(rule, from, to)) return { count: null, status: 'outside_rule_period' };
      const count = selected(from, to).length;
      return { count: count || null, status: count ? 'observed' : 'insufficient' };
    };
    const seasons = ranges.map(range => ({ ...range, ...seasonCount(range.from, range.observedTo) }));
    const currentCovered = ruleCovers(rule, currentRange.from, currentRange.observedTo);
    const current = currentCovered ? selected(currentRange.from, currentRange.observedTo) : [];
    const previous = ruleCovers(rule, previousRange.from, previousRange.observedTo)
      ? selected(previousRange.from, previousRange.observedTo) : [];
    const grids = await assessmentAdminGrids(tx, ctx);
    const codes = new Set(grids.map(g => String(g.code)));
    const counts = [...new Set(current.filter(r => r.adminGridCode && codes.has(r.adminGridCode)).map(r => r.adminGridCode!))]
      .map(code => ({ code, count: current.filter(r => r.adminGridCode === code).length }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    const top6 = counts.slice(0, 6).map(r => ({
      ...r,
      name: grids.find(g => g.code === r.code)?.name,
      previousCount: previous.filter(x => x.adminGridCode === r.code).length || null,
    }));

    const previousMonths = [];
    let cursor = previousRange.from;
    while (cursor <= previousRange.to) {
      const year = Number(cursor.slice(0, 4));
      const month = Number(cursor.slice(5, 7));
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      previousMonths.push({ month: cursor.slice(0, 7), ...seasonCount(cursor, end) });
      cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    }
    return {
      ...metadata(all as unknown as StatisticsComplaint[], q, today),
      status: 'available',
      rule: { ruleId: rule.ruleId, version: rule.version, name: rule.name, definitionBasis: rule.definitionBasis },
      seasons,
      previousMonths,
      top6,
      unlocatedCount: currentCovered ? current.filter(r => !r.adminGridCode || !codes.has(r.adminGridCode)).length : null,
      details: null,
    };
  });
}
