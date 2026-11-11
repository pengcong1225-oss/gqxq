import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { readStatisticsRows } from '../repositories/statisticsRepo';
import { normalizeShanghaiDay } from '../domain/statisticsQuery';
import { normalizeScreenQuery } from './screenQuery';
import {screenContexts as cache,screenScopeKey as scopeKey} from './screenContext';
import { simulatedSupportData } from '../domain/tenderSupportData';
import { scopeSupportDataset } from '../domain/tenderSupportValidation';
import { buildScreen, compareGrids } from '../domain/screen';
import { normalizeScreen } from '../domain/screenNormalize';
import {attachScreenEvidence} from './screenEvidence';
import {screenHeat} from './screenHeat';
import { screenHouseholdEvidence } from './screenHouseholds';
import type { HouseholdEvidence } from '../types/statistics';
import { loadUtility, utilityDetail } from './utilityService';
import { AppError } from '../http/errors';
import type { AccessContext } from '../auth/accessScope';
function permissions(p: readonly string[]) { if (!['statistics.read', 'dashboard.read', 'complaint.read'].every(x => p.includes(x))) throw AppError.forbidden('大屏需要统计、总账和诉求查询权限'); }
export async function screenBootstrap(raw: Record<string, unknown>, access: AccessContext, p: readonly string[]) {
  permissions(p);
  const {mode,today,query,screen:sq}=normalizeScreenQuery(raw,access,p);
  let records: Record<string, any>[] = []; let households: HouseholdEvidence[] = [];
  let utilityRevision: number | null = null, feedRevision: number | null = null, feedSyncedAt: string | null = null;
  let dataset = mode === 'simulation' ? scopeSupportDataset(simulatedSupportData(today), access) : null;
  let events: any[] = [];
  if (mode === 'real') {
    const conn = await pool.getConnection();
    try { await conn.query('set transaction isolation level repeatable read'); await conn.query('start transaction with consistent snapshot, read only'); records = await readStatisticsRows(conn, query, access); const captured = buildScreen(sq, access, records, [], null); const counts = new Map<string, number>(); for (const d of captured.details) if (d.enterpriseCode !== '__missing__') counts.set(d.enterpriseCode, (counts.get(d.enterpriseCode) ?? 0) + 1); households = await screenHouseholdEvidence(conn, query, access, p, [...counts].map(([enterpriseCode, count]) => ({ enterpriseCode, count })), captured.quality.missingDate > 0, !!(sq.adminGridCode || sq.communityCode)); } finally { try { await conn.rollback(); } finally { conn.release(); } }
    const utility = await loadUtility(mode); utilityRevision = utility.revision; feedRevision = utility.feedRevision; feedSyncedAt = utility.feedSyncedAt;
    events = utility.state.events.filter(e => p.includes(e.kind === 'shutdown' ? 'shutdown.read' : 'pipeline.read'));
  } else if (dataset) {
    const grids = new Map(dataset.grids.map(g => [g.id, g]));
    events = dataset.events.filter(e => p.includes(e.kind.includes('project') ? 'pipeline.read' : 'shutdown.read')).map(e => ({
      ...e, kind: e.kind.includes('project') ? 'pipeline' : 'shutdown', eventType: e.kind, mode: 'simulation',
      businessType: e.kind.includes('water') ? 'water' : 'gas', districtCode: grids.get(e.gridIds[0])?.districtCode ?? '',
      approvalStatus: 'approved', revision: dataset!.revision, updatedAt: dataset!.updatedAt, relatedTypes: e.kind.includes('water')?['水压问题','费用咨询']:['气压问题','费用咨询'], sourceSystem: 'simulation'
    }));
    dataset = {
...dataset, grids: dataset.grids.filter(g => (!sq.districtCode || g.districtCode === sq.districtCode) && (!sq.adminGridCode || g.id === sq.adminGridCode) && (!sq.communityCode || dataset!.communities.some(c=>c.id===sq.communityCode&&c.gridId===g.id))),
      communities: dataset.communities.filter(c => (!sq.adminGridCode || c.gridId === sq.adminGridCode) && (!sq.communityCode || c.id === sq.communityCode) && (!sq.districtCode || grids.get(c.gridId)?.districtCode === sq.districtCode)),
      pipelines: (dataset.pipelines ?? []).filter(x => (!sq.enterpriseCode || x.enterpriseId === sq.enterpriseCode) && (!sq.businessType || x.businessType === sq.businessType) && (!sq.adminGridCode || x.gridIds.includes(sq.adminGridCode)) && (!sq.districtCode || x.gridIds.every(id => grids.get(id)?.districtCode === sq.districtCode)))
};
  }
  events = events.filter(e => (!sq.adminGridCode || e.gridIds?.includes(sq.adminGridCode)) && (!sq.districtCode || mode!=='simulation' || e.gridIds.every((id:string)=>dataset?.grids.some(g=>g.id===id))) && !sq.communityCode && !sq.categoryCode);
  const result = buildScreen(sq, access, records, events, dataset); const { details, periodDetails, demonstration, researchEvidence, priorEvidence, ...data } = result;
  if (!p.includes('grid.read') || !p.includes('heatmap.read')) { data.events = data.events.map(e => ({ ...e, gridIds: [] })); data.charts.adminGrid = []; data.charts.community = []; data.compare = { value: null, reason: '缺少网格或热力查询权限' }; }
  const sections = normalizeScreen(result, dataset, p, households);
  const evidence=attachScreenEvidence(sections,result);
  const heat=screenHeat(result,dataset,p);
  const now = Date.now(); for (const [id, item] of cache) if (item.expires <= now) cache.delete(id); while (cache.size >= 100) cache.delete(cache.keys().next().value!);
  const contextId = randomUUID(), expires = now + 120000; cache.set(contextId, { owner: access.userId, scope: scopeKey(access), expires, details, periodDetails, events: data.events, evidence, gridCodes: dataset?.grids.map(g => g.id) ?? details.map(d => d.adminGridCode).filter((x): x is string => !!x), mode });
  return { ...data, ...sections, heat, contextId, generatedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), source: { complaints: mode === 'real' ? '宜接就办正式主账' : '独立模拟样本', events: mode==='simulation'?'独立专题模拟样本':'utility 来源读取；与主账并非同一数据库快照', topicHistory: '未映射，不参与合计', cutoffAt: null, utilityRevision, feedRevision, feedSyncedAt }, permissionScope: { scopeVersion: access.scopeVersion }, periodAnchor: '截至所选日期 ' + query.to, consistency: '诉求聚合与明细来自同一次捕获；事件另读并标明版本' };
}
export function screenDemands(id: unknown, page: unknown, size: unknown, access: AccessContext, p: readonly string[], filters: Record<string, unknown> = {}) {
  permissions(p); if (typeof id !== 'string') throw AppError.validation('需要 contextId'); const item = cache.get(id); if (!item || item.expires <= Date.now()) { cache.delete(id); throw AppError.conflict('查询上下文已过期，请刷新'); } if (item.owner !== access.userId || item.scope !== scopeKey(access)) throw AppError.notFound('查询上下文不存在或权限范围已变化');
  const allowed = ['metricKey', 'categoryCode', 'districtCode', 'adminGridCode', 'communityCode', 'enterpriseCode', 'from', 'to']; if (Object.keys(filters).some(k => !allowed.includes(k)) || Object.values(filters).some(v => typeof v !== 'string' || v.length > 100)) throw AppError.validation('明细筛选无效');
  if ((filters.adminGridCode || filters.communityCode) && (!p.includes('grid.read') || !p.includes('heatmap.read'))) throw AppError.forbidden('缺少网格或热力查询权限');
  for (const value of [filters.from, filters.to]) if (typeof value === 'string') normalizeShanghaiDay(value); if (typeof filters.from === 'string' && typeof filters.to === 'string' && filters.from > filters.to) throw AppError.validation('明细日期须正序');
  const metric = filters.metricKey ?? 'selected'; if (!['selected', 'yesterday', 'month', 'quarter', 'year'].includes(String(metric))) throw AppError.validation('指标类型无效'); const source = metric === 'selected' ? item.details : item.periodDetails[String(metric)];
  const selected = source.filter(r => (!filters.categoryCode || r.categoryCode === filters.categoryCode) && (!filters.districtCode || r.districtCode === filters.districtCode) && (!filters.adminGridCode || r.adminGridCode === filters.adminGridCode) && (!filters.communityCode || r.communityCode === filters.communityCode) && (!filters.enterpriseCode || r.enterpriseCode === filters.enterpriseCode) && (!filters.from || r.occurredDay! >= filters.from) && (!filters.to || r.occurredDay! <= filters.to));
  const n = Number(page ?? 1), s = Number(size ?? 20); if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(s) || s < 1 || s > 100) throw AppError.validation('页码无效，每页最多100条'); return { contextId: id, page: n, size: s, total: selected.length, items: selected.slice((n - 1) * s, n * s).map(r => p.includes('grid.read') && p.includes('heatmap.read') ? r : { ...r, adminGridCode: null, communityCode: null }) };
}

export async function screenEvent(contextId: unknown, id: string, access: AccessContext, p: readonly string[], readDetail: typeof utilityDetail = utilityDetail) { permissions(p); if (typeof contextId !== 'string') throw AppError.validation('需要 contextId'); const item = cache.get(contextId); if (!item || item.expires <= Date.now()) throw AppError.conflict('查询上下文已过期，请刷新'); if (item.owner !== access.userId || item.scope !== scopeKey(access)) throw AppError.notFound('查询上下文不存在或权限范围已变化'); const event = item.events.find(e => e.id === id); if (!event || !p.includes(event.kind === 'shutdown' ? 'shutdown.read' : 'pipeline.read')) throw AppError.notFound('事件不存在或无权限'); const eventView=p.includes('grid.read')&&p.includes('heatmap.read')?event:{...event,gridIds:[]}; if (item.mode === 'simulation') {
 const hasSpatial=p.includes('grid.read')&&p.includes('heatmap.read');
 const categories=event.businessType==='water'?['水压问题','费用咨询']:['气压问题','费用咨询'];
 const rows=hasSpatial?item.details.filter(d=>d.businessType===event.businessType&&event.gridIds.includes(d.adminGridCode)&&categories.includes(d.categoryCode)&&d.occurredDay!==null&&d.occurredDay>=event.startsAt.slice(0,10)&&d.occurredDay<=event.endsAt.slice(0,10)):null;
 return {contextId,event:eventView,history:[{revision:event.revision,updatedAt:event.updatedAt,approvalStatus:event.approvalStatus,reason:event.reason,area:event.area,plan:event.plan,housing:event.housing,workers:event.workers}],relatedDemands:{items:rows?.map(d=>({id:d.id,type:d.categoryCode,occurredAt:d.occurredDay,gridId:d.adminGridCode}))??[],total:rows?.length??null,reason:hasSpatial?'模拟规则：当前筛选交集中，同行业、共同网格、事件日期内且类型为压力问题或费用咨询；occurredAt 为日期精度，仅供演示，不代表因果':'缺少网格或热力权限，模拟关联不可用'}};
 } const detail = await readDetail(item.mode, id, { userId: access.userId, userName: '', clientIp: null, access, permissionCodes: [...p] }); if (detail.event.revision !== event.revision || detail.event.updatedAt !== event.updatedAt || String(detail.event.sourceRevision ?? '') !== String(event.sourceRevision ?? '')) throw AppError.conflict('事件版本已变化，请刷新'); return { contextId, event:eventView, history: detail.history.map((h: any) => ({ revision: h.revision, updatedAt: h.updatedAt, approvalStatus: h.event?.approvalStatus ?? null, reason: h.event?.reason ?? null, area: h.event?.area ?? null, plan: h.event?.plan ?? null, housing: h.event?.housing ?? null, workers: h.event?.workers ?? null })), relatedDemands: { items: detail.complaints.map(c => ({ id: c.id, type: c.type, occurredAt: c.occurredAt, gridId: p.includes('grid.read') && p.includes('heatmap.read') ? c.gridId : null })), total: event.hasGrid && event.hasCategories ? detail.complaints.length : null, reason: '按现有事件行业、分类、时间和网格规则匹配，仅表示相关而非因果；诉求明细单独读取，不与主账快照声明一致' } }; }

export function screenCompare(contextId: unknown, gridCodes: unknown, access: AccessContext, p: readonly string[]) { permissions(p); if (!p.includes('grid.read') || !p.includes('heatmap.read')) throw AppError.forbidden('缺少网格或热力查询权限'); if (typeof contextId !== 'string' || typeof gridCodes !== 'string') throw AppError.validation('需要 contextId 和 gridCodes'); const codes = gridCodes.split(','); if (codes.length < 2 || codes.length > 3 || new Set(codes).size !== codes.length || codes.some(c => !/^[A-Za-z0-9_.-]{1,100}$/.test(c))) throw AppError.validation('请选择2至3个不同网格编码'); const item = cache.get(contextId); if (!item || item.expires <= Date.now()) throw AppError.conflict('查询上下文已过期，请刷新'); if (item.owner !== access.userId || item.scope !== scopeKey(access)) throw AppError.notFound('查询上下文不存在或权限范围已变化'); if (codes.some(code => !item.gridCodes.includes(code))) throw AppError.notFound('网格不存在、无授权或当前范围没有诉求'); return { ...compareGrids(item.details, codes), contextId, provenance: '主账行政网格编码计数，正式空间映射尚未核验' }; }

export function screenEvidence(contextId:unknown,evidenceKey:unknown,page:unknown,size:unknown,access:AccessContext,p:readonly string[]){
 permissions(p);
 if(typeof contextId!=='string'||typeof evidenceKey!=='string')throw AppError.validation('需要 contextId 与 evidenceKey');
 const context=cache.get(contextId);
 if(!context||context.expires<=Date.now()){cache.delete(contextId);throw AppError.conflict('查询上下文已过期，请刷新');}
 if(context.owner!==access.userId||context.scope!==scopeKey(access))throw AppError.notFound('查询上下文不存在或权限范围已变化');
 const evidence=context.evidence[evidenceKey];
 if(!evidence)throw AppError.notFound('证据不存在或无权限');
 const hasSpatial=p.includes('grid.read')&&p.includes('heatmap.read');
 if(evidence.requiresSpatial&&!hasSpatial)throw AppError.forbidden('缺少网格或热力查询权限');
 const n=Number(page??1),s=Number(size??20);
 if(!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(s)||s<1||s>100)throw AppError.validation('页码无效，每页最多100条');
 const items=evidence.items?.slice((n-1)*s,n*s).map(r=>hasSpatial?r:{...r,adminGridCode:null,communityCode:null})??[];
 return {contextId,evidenceKey,state:evidence.state,reason:evidence.reason,total:evidence.items?.length??null,items,window:evidence.window,ruleVersion:evidence.ruleVersion,page:n,size:s};
}
