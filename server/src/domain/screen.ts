import { canAccessComplaint, type AccessContext } from '../auth/accessScope';
import type { TenderDataset } from '../types/tenderSupport';
import { buildSupportStatistics } from './supportStatisticsModel';
import { buildSupportResearch } from './supportResearchModel';
import { defaultSupportWarnings } from './tenderSupportData';
import type { ScreenDurationChart } from '../types/screen';
export type ScreenQuery = { mode: 'real' | 'simulation'; from: string; to: string; districtCode?: string; businessType?: string; enterpriseCode?: string; adminGridCode?: string; communityCode?: string; categoryCode?: string };
/** 指标值：要么有数、要么带"为什么没有"的说明——两者互斥，所以显式声明。 */
type Metric = { value: number | null; reason: string | null };

/**
 * 取第一个可解析的时间。
 * 来源系统的 source_reported_at 可能是空串、"invalid"、格式错乱的脏值；
 * 这种时候必须回退到 received_at，否则该条记录会被静默丢弃（总数与分桶对不上）。
 */
function firstValidTime(...values: Array<string | number | Date | null | undefined>): Date | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = value instanceof Date ? value : new Date(value as string | number);
    if (Number.isFinite(parsed.valueOf())) return parsed;
  }
  return null;
}
const missing = (reason: string): Metric => ({ value: null, reason });
const day = (v: unknown): string | null => { if (v == null) return null; const d = new Date(v as string); return Number.isFinite(d.valueOf()) ? new Date(d.valueOf() + 28800000).toISOString().slice(0, 10) : null; };
export function buildScreen(q: ScreenQuery, access: AccessContext, raw: Record<string, any>[], events: any[], simulation: TenderDataset | null) {
  const seen = new Set<string>(); let duplicates = 0, missingSourceKey = 0, missingDate = 0, fallback = 0;
  const initial: Record<string, any>[] = q.mode === 'simulation' ? (simulation?.complaints ?? []).map(c => ({ source_system: 'simulation', source_id: c.id, complaint_id: c.id, enterprise_code: c.enterpriseId, district_code: c.districtCode, business_type: c.businessType, source_reported_at: c.occurredAt, received_at: null, admin_grid_code: c.gridId, community_code: c.communityId, major_category_code: c.type, completedAt: c.completedAt, evaluation: c.evaluation, scenario: c.scenario })) : raw;
  const population = initial.filter(r => {
    if (q.mode === 'real' && r.source_system !== '宜接就办') return false;
    if (!canAccessComplaint(access, r)) return false;
    if (!r.source_id) { missingSourceKey++; return false; }
    const key = JSON.stringify([r.source_system, r.source_id]); if (seen.has(key)) { duplicates++; return false; } seen.add(key);
    const at = day(r.source_reported_at) ?? day(r.received_at); if (!at) { missingDate++; return false; } if (!day(r.source_reported_at)) fallback++;
    return at <= q.to && (!q.districtCode || (r.district_code || '__missing__') === q.districtCode) && (!q.enterpriseCode || (r.enterprise_code || '__missing__') === q.enterpriseCode) && (!q.businessType || r.business_type === q.businessType) && (!q.adminGridCode || (r.admin_grid_code || '__missing__') === q.adminGridCode) && (!q.communityCode || (r.community_code || '__missing__') === q.communityCode) && (!q.categoryCode || (r.minor_category_code || r.major_category_code || '__missing__') === q.categoryCode);
  });
  const rows = population.filter(r => { const at = day(r.source_reported_at) ?? day(r.received_at)!; return at >= q.from && at <= q.to; });
  const count = (key: string) => Object.entries(rows.reduce((m: Record<string, number>, r) => { const k = String(r[key] || '__missing__'); m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const countMinor = () => Object.entries(rows.reduce((m: Record<string, number>, r) => { const k = String(r.minor_category_code || r.major_category_code || '__missing__'); m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const visibleEvents = events.filter(e => canAccessComplaint(access, { enterprise_code: e.enterpriseId, district_code: e.districtCode }) && e.mode === q.mode && (!q.districtCode || e.districtCode === q.districtCode) && (!q.enterpriseCode || e.enterpriseId === q.enterpriseCode) && (!q.businessType || e.businessType === q.businessType) && day(e.startsAt) !== null && day(e.endsAt) !== null && day(e.startsAt)! <= q.to && day(e.endsAt)! >= q.from).map(e => ({ id: e.id, kind: e.kind, eventType: e.eventType ?? null, gridIds: q.mode === 'simulation' ? e.gridIds : [], title: e.title, businessType: e.businessType, enterpriseId: e.enterpriseId, districtCode: e.districtCode, startsAt: e.startsAt, endsAt: e.endsAt, approvalStatus: e.approvalStatus, reason: e.reason ?? null, area: e.area ?? null, plan: e.plan ?? null, housing: e.housing ?? null, households: e.households ?? null, workers: e.workers ?? null, revision: e.revision, updatedAt: e.updatedAt, sourceRevision: e.sourceRevision ?? null, hasGrid: !!e.gridIds?.length, hasCategories: !!e.relatedTypes?.length, spatialState: e.gridIds?.length ? '待核验正式空间映射' : '未关联网格' }));
  const dayCounts = Object.entries(rows.reduce((m: Record<string, number>, r) => { const d = day(r.source_reported_at) ?? day(r.received_at)!; m[d] = (m[d] ?? 0) + 1; return m; }, {})).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
  const prev = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const month = q.to.slice(0, 7) + '-01', year = q.to.slice(0, 4) + '-01-01', quarter = q.to.slice(0, 4) + '-' + String(Math.floor((Number(q.to.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0') + '-01';
  const countRange = (from: string, to: string) => population.filter(r => { const x = day(r.source_reported_at) ?? day(r.received_at)!; return x >= from && x <= to; }).length;
  const periods = { yesterday: { from: prev(q.to, 1), to: prev(q.to, 1), count: countRange(prev(q.to, 1), prev(q.to, 1)) }, month: { from: month, to: q.to, count: countRange(month, q.to) }, quarter: { from: quarter, to: q.to, count: countRange(quarter, q.to) }, year: { from: year, to: q.to, count: countRange(year, q.to) }, coverage: '仅已接入并可识别的来源，历史完整性未经确认' };
  const groupTime = (kind: 'month' | 'week', source=dayCounts) => { const map: Record<string, number> = {}; for (const x of source) { let key = x.date.slice(0, 7); if (kind === 'week') { const n = new Date(x.date + 'T00:00:00Z').getUTCDay(); key = prev(x.date, (n + 6) % 7); } map[key] = (map[key] ?? 0) + x.count; } return Object.entries(map).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)); };
  const summary: { total: number; unlocated: number; householdRate: Metric; satisfaction: Metric; duration: Metric } = {
    total: rows.length,
    unlocated: rows.filter(r => !r.admin_grid_code).length,
    householdRate: missing('缺少已确认的跨期有效户数及分母口径'),
    satisfaction: missing('正式有效评价和来源优先规则尚未确认'),
    duration: missing('来源实际完成时间尚未建立可核验的统计映射'),
  };
  let demonstration: any = null;
  let researchEvidence:ReturnType<typeof buildSupportResearch>|null=null;
  if (q.mode === 'simulation' && simulation) {
    const allowed = new Set(rows.map(r => r.complaint_id)); const scoped = { ...simulation, complaints: simulation.complaints.filter(c => canAccessComplaint(access, { enterprise_code: c.enterpriseId, district_code: c.districtCode }) && (!q.districtCode || c.districtCode === q.districtCode) && (!q.enterpriseCode || c.enterpriseId === q.enterpriseCode) && (!q.businessType || c.businessType === q.businessType) && (!q.adminGridCode || c.gridId === q.adminGridCode) && (!q.communityCode || c.communityId === q.communityCode) && (!q.categoryCode || c.type === q.categoryCode)) };
    const selected = { ...scoped, enterprises: scoped.enterprises.filter(e=>!q.enterpriseCode||e.id===q.enterpriseCode), complaints: scoped.complaints.filter(c => allowed.has(c.id)) }; const business=q.businessType==='water'||q.businessType==='gas'?q.businessType:'all'; const stats = buildSupportStatistics(selected, q.from, q.to,business); const research = buildSupportResearch(scoped, q.from, q.to, defaultSupportWarnings.rules); researchEvidence=research;
    demonstration = { evaluation: { evaluatedCount: stats.evaluation.evaluatedCount, satisfiedCount: stats.evaluation.satisfiedCount, unsatisfiedCount: stats.evaluation.unsatisfiedCount, unevaluatedCount: stats.evaluation.missingCount, percent: stats.evaluation.satisfiedPercent }, unsatisfiedBusiness: stats.unsatisfiedBusiness.map(x => ({ businessType: x.businessType, count: x.count, percent: x.percent })), duration: stats.duration.map(x => ({ key: x.key, count: x.count, evaluation: { evaluatedCount: x.evaluation.evaluatedCount, satisfiedCount: x.evaluation.satisfiedCount, unsatisfiedCount: x.evaluation.unsatisfiedCount, unevaluatedCount: x.evaluation.missingCount, percent: x.evaluation.satisfiedPercent } })), communities: stats.communities.map(x => ({ id: x.id, name: x.name, count: x.count, rank: x.rank })), enterpriseRates: stats.enterpriseRates.map(x => ({ id: x.id, name: x.name, count: x.count, households: x.households, per10k: x.per10k })), warnings: research.warnings.map(x => ({ scenario: x.rule.scenario, from: x.from, to: x.to, count: x.rows.length, triggered: x.triggered, threshold:x.rule.threshold, days:x.rule.days, enabled:x.rule.enabled, ruleVersion:'simulation-warning-v1' })), priorTop3: research.priorTop3.map(x => ({ name: x.name, count: x.rows.length })), seasons: [research.winter, research.summer].map(s => ({ kind: s.kind, years: s.years.map(y => ({ year: y.year, from: y.from, to: y.to, count: y.rows.length })), months: s.months.map(m => ({ month: m.month, currentRange: m.currentRange, previousRange: m.previousRange, currentCount: m.currentRows.length, previousCount: m.previousRows.length })), topGrids: s.topGrids.map(g => ({ id: g.id, name: g.name, count: g.rows.length, previousCount: g.previousRows.length })) })), grids: simulation.grids.filter(g => selected.complaints.some(c => c.gridId === g.id)), pipelines: (simulation.pipelines ?? []).filter(p => selected.complaints.some(c => c.enterpriseId === p.enterpriseId && p.gridIds.includes(c.gridId))) };
  }
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })); for (const r of rows) { const instant = new Date(day(r.source_reported_at) ? r.source_reported_at : r.received_at); if (Number.isFinite(instant.valueOf())) hourCounts[new Date(instant.valueOf() + 28800000).getUTCHours()].count++; }
  const dynamicRows=rows.filter(r=>r.business_type==='water'||r.business_type==='gas');
  const dynamicDays=Object.entries(dynamicRows.reduce((m:Record<string,number>,r)=>{const d=day(r.source_reported_at)??day(r.received_at)!;m[d]=(m[d]??0)+1;return m;},{})).map(([date,count])=>({date,count})).sort((a,b)=>a.date.localeCompare(b.date));
  const dynamicHours=Array.from({length:24},(_,hour)=>({hour,count:0}));
  for(const r of dynamicRows){const instant=new Date(day(r.source_reported_at)?r.source_reported_at:r.received_at);if(Number.isFinite(instant.valueOf()))dynamicHours[new Date(instant.valueOf()+28800000).getUTCHours()].count++;}
  const satisfactionStats = (list: Record<string, any>[]) => {
    let satisfiedOnly = 0, basically = 0, unsatisfied = 0, noReply = 0, unrated = 0;
    for(const r of list){
      const code = String(r.satisfaction_code ?? '').trim().toLowerCase();
      if(code === 'satisfied') satisfiedOnly += 1;
      else if(code === 'basically_satisfied') basically += 1;
      else if(code === 'unsatisfied') unsatisfied += 1;
      else if(code === 'no_reply') noReply += 1;
      else unrated += 1;
    }
    const rated = satisfiedOnly + basically + unsatisfied;
    const satisfied = satisfiedOnly + basically;
    const satisfiedRate = rated > 0
      ? { value: +((satisfied / rated).toFixed(4)), reason: null }
      : { value: null as number | null, reason: '无有效评价' as string | null };
    return { total: list.length, rated, satisfied, satisfiedOnly, basically, unsatisfied, noReply, unrated, satisfiedRate };
  };
  const satisfaction = satisfactionStats(rows);
  const satisfactionByIndustry = {
    gas: satisfactionStats(rows.filter(r => r.business_type === 'gas')),
    water: satisfactionStats(rows.filter(r => r.business_type === 'water')),
  };
  summary.satisfaction = satisfaction.satisfiedRate;
  const dynamicCharts={hourly:dynamicHours,weekly:groupTime('week',dynamicDays),monthly:groupTime('month',dynamicDays)};
  const WEEK_LABELS = ['周一','周二','周三','周四','周五','周六','周日'];
  const hourBuckets = Array.from({length:24},(_,hour)=>({hour,count:0,gas:0,water:0}));
  const weekdayBuckets = WEEK_LABELS.map((label,i)=>({weekday:i+1,label,count:0,gas:0,water:0}));
  const durationDiffs: number[] = [];
  type DurationEvaluation = { evaluatedCount: number; satisfiedCount: number; unsatisfiedCount: number; unevaluatedCount: number; percent: number | null };
  const bucketEvaluation = (): DurationEvaluation => ({ evaluatedCount: 0, satisfiedCount: 0, unsatisfiedCount: 0, unevaluatedCount: 0, percent: null });
  /** 标书 1.2.3：处理时长四档，每档同时累计 `satisfaction_code` 评价构成（满意=满意+基本满意，不满意=unsatisfied，其余=未评价）。 */
  const durationBuckets: { label: string; count: number; evaluation: DurationEvaluation }[] = [ { label: '≤24h', count: 0, evaluation: bucketEvaluation() }, { label: '24–48h', count: 0, evaluation: bucketEvaluation() }, { label: '48–72h', count: 0, evaluation: bucketEvaluation() }, { label: '>72h', count: 0, evaluation: bucketEvaluation() } ];
  let durationOvertime = 0;
  const districtByCategory: Record<string, {code:string;count:number}[]> = {};
  for(const r of rows){
    const at = firstValidTime(r.source_reported_at, r.received_at);
    if(at){
      const cn = new Date(at.valueOf() + 28800000);
      const hour = cn.getUTCHours();
      const weekday = ((cn.getUTCDay() + 6) % 7) + 1;
      for(const bucket of [hourBuckets[hour], weekdayBuckets[weekday-1]]){
        bucket.count += 1;
        if(r.business_type === 'gas') bucket.gas += 1;
        else if(r.business_type === 'water') bucket.water += 1;
      }
    }
    const category = String(r.minor_category_code || r.major_category_code || '__missing__');
    const district = String(r.district_code || '__missing__');
    const list = districtByCategory[category] ?? (districtByCategory[category] = []);
    const hit = list.find(x => x.code === district);
    if(hit) hit.count += 1; else list.push({code:district,count:1});
/* ---------- 处理时长：只认可核验的办结时间 source_completed_at ----------
     * 说明：source_synced_at 是同步管道固定延迟（窗口内全部 +3h），不能当处理时长；
     * 办结时间来自「宜接就办」导出批次的「实际完成时间」，回填后仅 461 条（2026-03~09）可用。
     */
    const startAt = firstValidTime(r.source_reported_at, r.received_at);
    const endedAt = firstValidTime(r.source_completed_at);
    if (startAt && endedAt) {
      const s = startAt;
      const e = endedAt;
      if (e.valueOf() >= s.valueOf()) {
        const hours = Math.floor((e.valueOf() - s.valueOf()) / 3600000);
        durationDiffs.push(hours);
        const bucket = hours <= 24 ? durationBuckets[0] : hours <= 48 ? durationBuckets[1] : hours <= 72 ? durationBuckets[2] : durationBuckets[3];
        bucket.count += 1;
        const satisfactionCode = String(r.satisfaction_code ?? '').trim().toLowerCase();
        if (satisfactionCode === 'satisfied' || satisfactionCode === 'basically_satisfied') { bucket.evaluation.satisfiedCount += 1; bucket.evaluation.evaluatedCount += 1; }
        else if (satisfactionCode === 'unsatisfied') { bucket.evaluation.unsatisfiedCount += 1; bucket.evaluation.evaluatedCount += 1; }
        else bucket.evaluation.unevaluatedCount += 1;
        if (r.source_deadline_at && new Date(r.source_deadline_at as any).valueOf() < e.valueOf()) durationOvertime += 1;
      }
    }
  }
  const durationCovered = durationBuckets.reduce((sum, b) => sum + b.count, 0);
  for (const bucket of durationBuckets) bucket.evaluation.percent = bucket.evaluation.evaluatedCount > 0 ? +(bucket.evaluation.satisfiedCount / bucket.evaluation.evaluatedCount).toFixed(4) : null;
  const durationChart: ScreenDurationChart = durationCovered > 0
    ? {
        value: {
          buckets: durationBuckets,
          covered: durationCovered,
          coverage: +(durationCovered / Math.max(1, rows.length)).toFixed(4),
          total: rows.length,
          overtime: durationOvertime,
          overtimeRate: +(durationOvertime / durationCovered).toFixed(4),
        },
        reason: null as string | null,
        evidence: null as any,
      }
    : {
        value: null,
        reason: '当前窗口无可用办结时间：仅 2026-03~09 批次（461 条）带「实际完成时间」，其余批次源数据未提供；source_synced_at 为管道固定延迟(+3h)不可用',
        evidence: { minHours: 3, maxHours: 3, identicalRatio: 1 },
      };
  for(const list of Object.values(districtByCategory)) list.sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code));
  const durationEvidence = (() => {
    if(!durationDiffs.length) return {minHours:null,maxHours:null,identicalRatio:null};
    // SQL TIMESTAMPDIFF(HOUR) 口径：按整小时截断，便于与验收证据对齐
    const hours = durationDiffs.map(h => Math.floor(h));
    const counts = new Map<number,number>();
    for(const h of hours){counts.set(h,(counts.get(h)??0)+1);}
    let modeCount=0; for(const n of counts.values()) if(n>modeCount) modeCount=n;
    return {minHours:Math.min(...hours),maxHours:Math.max(...hours),identicalRatio:+(modeCount/hours.length).toFixed(2)};
  })();

  const toDetail = (r: Record<string, any>) => ({ id: r.complaint_id, businessType: r.business_type ?? null, districtCode: r.district_code || '__missing__', enterpriseCode: r.enterprise_code || '__missing__', adminGridCode: r.admin_grid_code || '__missing__', communityCode: r.community_code || '__missing__', categoryCode: r.minor_category_code || r.major_category_code || '__missing__', title: '诉求 ' + String(r.complaint_id), status: r.source_event_status ?? r.status ?? null, occurredDay: day(r.source_reported_at) ?? day(r.received_at) });
  const previous = (value: string) => { const y = Number(value.slice(0, 4)) - 1; const candidate = String(y) + value.slice(4); const d = new Date(candidate + 'T00:00:00Z'); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === candidate ? candidate : String(y) + '-02-28'; };
  const priorFrom = previous(q.from), priorTo = previous(q.to), priorCounts: Record<string, number> = {}; for (const r of population) { const d = day(r.source_reported_at) ?? day(r.received_at)!; if (d >= priorFrom && d <= priorTo) { const key = String(r.minor_category_code || r.major_category_code || '__missing__'); priorCounts[key] = (priorCounts[key] ?? 0) + 1; } } const priorTop3 = { from: priorFrom, to: priorTo, items: Object.entries(priorCounts).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 3) };
  const priorEvidence=population.filter(r=>{const d=day(r.source_reported_at)??day(r.received_at)!;return d>=priorFrom&&d<=priorTo;}).map(toDetail);
  const details = rows.map(toDetail); const periodDetails = Object.fromEntries(Object.entries(periods).filter(([, v]) => typeof v === 'object').map(([key, v]) => { const range = v as { from: string; to: string }; return [key, population.filter(r => { const x = day(r.source_reported_at) ?? day(r.received_at)!; return x >= range.from && x <= range.to; }).map(toDetail)]; })) as Record<string, typeof details>;
  return { mode: q.mode, window: { from: q.from, to: q.to, timezone: 'Asia/Shanghai', timeBasis: '来源受理时间优先，缺失回退接收时间' }, summary: q.mode === 'simulation' && demonstration ? { ...summary, satisfaction: { value: demonstration.evaluation.percent, reason: demonstration.evaluation.evaluatedCount ? null : '无有效评价' }, duration: { value: demonstration.duration, reason: null } } : summary, quality: { duplicates, missingSourceKey, missingDate, sourceTimeFallback: fallback }, charts: { business: count('business_type'), district: count('district_code'), community: count('community_code'), enterprise: count('enterprise_code'), category: countMinor(), adminGrid: count('admin_grid_code'), trend: dayCounts, monthly: groupTime('month'), weekly: weekdayBuckets, hourly: hourBuckets, duration: durationChart, satisfaction: {...satisfaction, byIndustry: satisfactionByIndustry, sourceNote:'来源：市民回复结果（satisfaction_code），基本满意计入满意'}, districtByCategory, topTypes: countMinor().slice(0, 3) }, events: visibleEvents, layers: { cim: { state: 'unconfigured', reason: '未核验正式 CIM 授权和服务配置' }, heat: { state: 'unavailable', reason: '正式空间资源及已发布规则尚未核验' } }, unavailable: { households: summary.householdRate.reason, evaluation: summary.satisfaction.reason ?? '', duration: summary.duration.reason, history: '专题历史缺少来源系统和稳定主键映射，不纳入正式主账', spatial: '行政网格映射及空间资源版本待核验', warnings: '已发布预警规则及来源分类待核验', research: '历史覆盖与业务季节口径待确认', compare: '历史覆盖及比较口径待确认' }, periods, demonstration, compare: q.mode === 'simulation' ? count('admin_grid_code') : { value: null, reason: '正式网格映射及版本待核验' }, research: q.mode === 'simulation' ? demonstration?.seasons : { value: null, reason: '历史覆盖与季节口径待确认' }, warnings: q.mode === 'simulation' ? demonstration?.warnings : { value: null, reason: '正式发布预警规则与分类待核验' }, priorTop3, dynamicCharts, details, periodDetails, researchEvidence, priorEvidence };
}
export function compareGrids(details: { adminGridCode: string | null; categoryCode: string | null }[], codes: string[]) {
  const categories = [...new Set(details.filter(d => d.adminGridCode !== null && codes.includes(d.adminGridCode)).map(d => d.categoryCode ?? '__missing__'))].sort();
  return { gridCodes: codes, rows: categories.map(categoryCode => { const counts = codes.map(code => details.filter(d => d.adminGridCode === code && (d.categoryCode ?? '__missing__') === categoryCode).length), maximum = Math.max(...counts); return { categoryCode, values: codes.map((code, i) => ({ gridCode: code, count: counts[i], maximum: maximum > 0 && counts[i] === maximum })) }; }) };
}




