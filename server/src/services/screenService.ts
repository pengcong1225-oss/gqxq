import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { readScreenPriorRows, readScreenStatisticsRows, readStatisticsRows } from '../repositories/statisticsRepo';
import { normalizeShanghaiDay, previousYear } from '../domain/statisticsQuery';
import { normalizeScreenQuery } from './screenQuery';
import {screenContexts as cache,screenScopeKey as scopeKey,type ScreenContext} from './screenContext';
import { simulatedSupportData } from '../domain/tenderSupportData';
import { scopeSupportDataset } from '../domain/tenderSupportValidation';
import { buildScreen, compareGrids, type ScreenQuery } from '../domain/screen';
import { normalizeScreen } from '../domain/screenNormalize';
import {attachScreenEvidence, type ScreenEvidenceItem} from './screenEvidence';
import {screenHeat} from './screenHeat';
import { screenHouseholdEvidence } from './screenHouseholds';
import type { HouseholdEvidence } from '../types/statistics';
import type { SupportCommunity } from '../types/tenderSupport';
import { readScreenCommunities } from './screenCommunities';
import { loadUtility, utilityDetail } from './utilityService';
import { canReadShutdownEvent, readLayerEventsForBootstrap, type ShutdownDataSource } from './shutdownLayerService';
import { toUtilityEvent, toUtilityEvents, UNKNOWN_TIME_SENTINEL } from './eventSourceService';
import { findRelatedComplaints } from './relatedComplaintService';
import { AppError } from '../http/errors';
import type { AccessContext } from '../auth/accessScope';
import { buildComplaintScopeSql, canAccessComplaint } from '../auth/accessScope';
import type { UtilityEvent } from '../types/utility';
import { excludeIntegrationTestsSql } from '../domain/integrationTestPolicy';
function permissions(p: readonly string[]) { if (!['statistics.read', 'dashboard.read', 'complaint.read'].every(x => p.includes(x))) throw AppError.forbidden('大屏需要统计、总账和诉求查询权限'); }

function eventDistricts(event: UtilityEvent) {
  return event.kind === 'shutdown' && event.gridIds.length
    ? [...new Set(event.gridIds.map((code) => code.slice(0, 6)))]
    : [event.districtCode];
}

function canReadEvent(event: UtilityEvent, access: AccessContext) {
  return event.kind === 'shutdown'
    ? canReadShutdownEvent(access, event.enterpriseId, event.gridIds)
    : canAccessComplaint(access, { enterprise_code: event.enterpriseId, district_code: event.districtCode });
}

function hasEventDates(event: Pick<UtilityEvent, 'startsAt' | 'endsAt'>) {
  return event.startsAt !== UNKNOWN_TIME_SENTINEL && event.endsAt !== UNKNOWN_TIME_SENTINEL &&
    Number.isFinite(Date.parse(event.startsAt)) && Number.isFinite(Date.parse(event.endsAt)) &&
    Date.parse(event.startsAt) <= Date.parse(event.endsAt);
}

function matchesEventQuery(event: UtilityEvent, query: ScreenQuery) {
  const from = Date.parse(`${query.from}T00:00:00+08:00`);
  const until = Date.parse(`${query.to}T00:00:00+08:00`) + 86400000;
  return hasEventDates(event) && Date.parse(event.startsAt) < until && Date.parse(event.endsAt) >= from &&
    (!query.districtCode || eventDistricts(event).includes(query.districtCode)) &&
    (!query.enterpriseCode || event.enterpriseId === query.enterpriseCode) &&
    (!query.businessType || event.businessType === query.businessType);
}

export async function screenBootstrap(raw: Record<string, unknown>, access: AccessContext, p: readonly string[]) {
  permissions(p);
  const {mode,today,query,screen:sq}=normalizeScreenQuery(raw,access,p);
  let records: Record<string, any>[] = []; let households: HouseholdEvidence[] = []; let communityPoints: SupportCommunity[] = [];
  let utilityRevision: number | null = null, feedRevision: number | null = null, feedSyncedAt: string | null = null;
  let shutdownLayerSource: ShutdownDataSource | null = null;
  let dataset = mode === 'simulation' ? scopeSupportDataset(simulatedSupportData(today), access) : null;
  /** real 模式的首次计算结果（含 details/charts），避免二次全量重算 */
  let capturedResult: any = null;
  let capturedHeat: Awaited<ReturnType<typeof screenHeat>> | null = null;
  const heatGridDetails = new Map<string, ScreenEvidenceItem[]>();
  let capturedAt = Date.now();
  let events: any[] = [];
  if (mode === 'real') {
    const conn = await pool.getConnection();
    try {
      await conn.query('set transaction isolation level repeatable read');
      await conn.query('start transaction with consistent snapshot, read only');
      capturedAt = Date.now();
      records = await readScreenStatisticsRows(conn, query, access);
      const priorRows = await readScreenPriorRows(conn, {
        from: previousYear(sq.from), to: previousYear(sq.to),
      }, access, sq.businessType);
      const captured = buildScreen(sq, access, records, [], null, priorRows);
      capturedResult = captured;
      const counts = new Map<string, number>();
      for (const detail of captured.details) {
        if (detail.enterpriseCode !== '__missing__') counts.set(detail.enterpriseCode, (counts.get(detail.enterpriseCode) ?? 0) + 1);
      }
      households = await screenHouseholdEvidence(conn, query, access, p,
        [...counts].map(([enterpriseCode, count]) => ({ enterpriseCode, count })),
        captured.quality.missingDate > 0, !!(sq.adminGridCode || sq.communityCode));
      if (p.includes('grid.read') && p.includes('heatmap.read')) {
        communityPoints = await readScreenCommunities(conn, access, {
          districtCode: sq.districtCode, adminGridCode: sq.adminGridCode, communityCode: sq.communityCode,
        });
      }
      capturedHeat = await screenHeat(captured, null, p, { query: sq, access, db: conn, details: heatGridDetails });
    } finally {
      try { await conn.rollback(); } finally { conn.release(); }
    }
    const utility = await loadUtility(mode); utilityRevision = utility.revision; feedRevision = utility.feedRevision; feedSyncedAt = utility.feedSyncedAt;
    /**
     * 事件来源统一（见 services/eventSourceService.ts 顶部说明）。
     *
     * 旧实现取 `utility.state.events`，那是 `mapUtilityFeed` 的产物 —— 它把跨区县事件
     * 按区县拆成多条，且与 1.2.6 停水停气图层的解析口径不同（110 条 vs 157 条，ID 交集为 0）。
     * 现改为复用 `shutdownLayerService` 的解析（一个事件一条、保留多网格），
     * 保证图层与详情说的是同一批事件；多网格联动高亮也才能成立。
     *
     * 管道改造（pipeline）事件仍走原路径：shutdownLayerService 只负责停水停气。
     */
    const unifiedEvents = p.includes('shutdown.read') ? await readLayerEventsForBootstrap(pool) : null;
    shutdownLayerSource = unifiedEvents?.source ?? null;
    const shutdownEvents = unifiedEvents ? toUtilityEvents(unifiedEvents.events, unifiedEvents.source) : [];
    const pipelineEvents = p.includes('pipeline.read')
      ? utility.state.events.filter((event) => event.kind === 'pipeline' && event.mode === 'real')
      : [];
    events = [...shutdownEvents, ...pipelineEvents].filter((event) =>
      canReadEvent(event, access) && matchesEventQuery(event, sq),
    );
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
  const result = (mode === 'real' && !dataset && capturedResult) ? { ...capturedResult, events } : buildScreen(sq, access, records, events, dataset); const { details, eventDemandTimes, periodDetails, demonstration, researchEvidence, priorEvidence, ...data } = result;
  if (!p.includes('grid.read') || !p.includes('heatmap.read')) { data.events = data.events.map((e: { gridIds?: string[] }) => ({ ...e, gridIds: [] })); data.charts.adminGrid = []; data.charts.community = []; data.compare = { value: null, reason: '缺少网格或热力查询权限' }; }
  const sections = normalizeScreen(result, dataset, p, households, communityPoints);
  const evidence=attachScreenEvidence(sections,result);
  const heat=capturedHeat??await screenHeat(result,dataset,p);
  data.layers.heat={state:heat.state,reason:heat.reason};
  /*
   * 上下文有效期从 2 分钟放宽到 15 分钟。
   *
   * 原值 120000 是按「一次交互会话」估的，但大屏是**长时间挂着**的场景：
   * 用户看几分钟再点某个小区/网格的「明细」，/screen/demands 立刻 409
   * 「查询上下文已过期」，抽屉直接报错 —— 这是实际发生的投诉。
   *
   * 容量仍由下面 while(size>=100) 的 LRU 淘汰兜住，放宽 TTL 不会无限涨内存。
   */
  const CONTEXT_TTL_MS = 15 * 60 * 1000;
  const now = Date.now(); for (const [id, item] of cache) if (item.expires <= now) cache.delete(id); while (cache.size >= 100) cache.delete(cache.keys().next().value!);
  const contextId = randomUUID(), expires = now + CONTEXT_TTL_MS; cache.set(contextId, { owner: access.userId, scope: scopeKey(access), expires, capturedAt, details, eventDemandTimes, periodDetails, events: result.events, evidence, heatGridDetails, gridCodes: dataset?.grids.map(g => g.id) ?? details.map((d: { adminGridCode?: string | null }) => d.adminGridCode).filter((x: string | null | undefined): x is string => !!x), mode });
  return { ...data, ...sections, heat, contextId, generatedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), source: { complaints: mode === 'real' ? '宜接就办正式主账' : '独立模拟样本', events: mode==='simulation'?'独立专题模拟样本':'停供图层与管线申请独立于诉求快照读取', topicHistory: '未映射，不参与合计', cutoffAt: null, utilityRevision, feedRevision, feedSyncedAt, shutdownLayerSource }, permissionScope: { scopeVersion: access.scopeVersion }, periodAnchor: '截至所选日期 ' + query.to, consistency: '诉求聚合与明细来自同一次捕获；事件另读并标明版本' };
}
/**
 * 兼容不带统计上下文的地图明细查询。大屏浮层与抽屉通过 screenDemands 复用排名快照。
 */
export async function screenMapPickDemands(
  raw: Record<string, unknown>,
  access: AccessContext,
  p: readonly string[],
) {
  permissions(p);
  if (!p.includes('grid.read') || !p.includes('heatmap.read')) throw AppError.forbidden('缺少网格或热力查询权限');

  const communityCode = typeof raw.communityCode === 'string' ? raw.communityCode.trim() : '';
  const adminGridCode = typeof raw.adminGridCode === 'string' ? raw.adminGridCode.trim() : '';
  if (!communityCode && !adminGridCode) {
    throw AppError.validation('需要 communityCode 或 adminGridCode');
  }
  if (communityCode && adminGridCode) {
    throw AppError.validation('communityCode 与 adminGridCode 只能二选一');
  }

  const from = typeof raw.from === 'string' ? normalizeShanghaiDay(raw.from) : null;
  const to = typeof raw.to === 'string' ? normalizeShanghaiDay(raw.to) : null;
  if (from && to && from > to) throw AppError.validation('开始日期不能晚于结束日期');

  const page = Number(raw.page ?? 1);
  const size = Number(raw.size ?? 10);
  if (!Number.isSafeInteger(page) || page < 1) throw AppError.validation('页码无效');
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw AppError.validation('每页条数无效（1~100）');

  const businessType = typeof raw.businessType === 'string' ? raw.businessType.trim() : '';
  if (businessType && businessType !== 'gas' && businessType !== 'water') {
    throw AppError.validation('行业只能是 gas 或 water');
  }

  const scope = buildComplaintScopeSql(access, 'c');
  const params: unknown[] = [...scope.params];
  const columns = 'c.complaint_id id, coalesce(nullif(c.minor_category_code, \'\'),c.major_category_code) type, ' +
    'coalesce(c.source_reported_at,c.received_at) occurredAt, c.admin_grid_code gridId';
  let where = 'from complaint c where ' + scope.sql + " and c.source_system = '宜接就办' and c.source_id <> ''";

  if (communityCode) {
    where += ' and c.community_code = ?';
    params.push(communityCode);
  } else {
    where += ' and c.admin_grid_code = ?';
    params.push(adminGridCode);
  }
  if (businessType) {
    where += ' and c.business_type = ?';
    params.push(businessType);
  }

  // 保留索引范围查询，仅在来源上报时间为空时按接收时间筛选。
  const fromDate = from ? new Date(from + 'T00:00:00+08:00') : null;
  const toExclusive = to ? new Date(new Date(to + 'T00:00:00+08:00').valueOf() + 86400000) : null;
  if (fromDate || toExclusive) {
    const pushRange = (col: string) => {
      let c = '';
      if (fromDate) {
        c += ` and c.${col} >= ?`;
        params.push(fromDate);
      }
      if (toExclusive) {
        c += ` and c.${col} < ?`;
        params.push(toExclusive);
      }
      return c;
    };
    where += ' and ((c.source_reported_at is not null' + pushRange('source_reported_at') + ') or ' +
      '(c.source_reported_at is null' + pushRange('received_at') + '))';
  } else {
    where += ' and (c.source_reported_at is not null or c.received_at is not null)';
  }

  // 与主屏统计保持一致：排除集成测试数据
  where += ' and ' + excludeIntegrationTestsSql('c');

  // 总数
  const [countRows] = await pool.query<import('mysql2').RowDataPacket[]>('select count(*) n ' + where, params);
  const total = Number(countRows[0]?.n ?? 0);

  const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(
    `select ${columns} ${where} order by occurredAt desc, c.id desc limit ? offset ?`,
    [...params, size, (page - 1) * size],
  );

  return {
    total,
    page,
    size,
    items: rows.map((r) => ({
      id: String(r.id ?? ''),
      type: String(r.type ?? ''),
      occurredAt: new Date(r.occurredAt).toISOString(),
      gridId: r.gridId ? String(r.gridId) : null,
    })),
    /** 口径说明：让前端在空态时能解释「为什么是 0」，而不是让人以为加载失败 */
    note:
      total === 0
        ? '所选时间窗口内该范围内无诉求记录（不是加载失败）'
        : '统计口径：宜接就办来源，上报时间优先，缺失回退接收时间',
  };
}
export function screenDemands(id: unknown, page: unknown, size: unknown, access: AccessContext, p: readonly string[], filters: Record<string, unknown> = {}) {
  permissions(p); if (typeof id !== 'string') throw AppError.validation('需要 contextId'); const item = cache.get(id); if (!item || item.expires <= Date.now()) { cache.delete(id); throw AppError.conflict('查询上下文已过期，请刷新'); } if (item.owner !== access.userId || item.scope !== scopeKey(access)) throw AppError.notFound('查询上下文不存在或权限范围已变化');
  const allowed = ['metricKey', 'businessType', 'categoryCode', 'districtCode', 'adminGridCode', 'heatGridCode', 'communityCode', 'enterpriseCode', 'from', 'to']; if (Object.keys(filters).some(k => !allowed.includes(k)) || Object.values(filters).some(v => typeof v !== 'string' || v.length > 100)) throw AppError.validation('明细筛选无效');
  if (filters.businessType !== undefined && filters.businessType !== 'gas' && filters.businessType !== 'water') throw AppError.validation('行业只能是 gas 或 water');
  if ((filters.adminGridCode || filters.heatGridCode || filters.communityCode) && (!p.includes('grid.read') || !p.includes('heatmap.read'))) throw AppError.forbidden('缺少网格或热力查询权限');
  for (const value of [filters.from, filters.to]) if (typeof value === 'string') normalizeShanghaiDay(value); if (typeof filters.from === 'string' && typeof filters.to === 'string' && filters.from > filters.to) throw AppError.validation('明细日期须正序');
  const metric = filters.metricKey ?? 'selected'; if (!['selected', 'yesterday', 'month', 'quarter', 'year'].includes(String(metric))) throw AppError.validation('指标类型无效');
  const heatDetails=typeof filters.heatGridCode==='string'?item.heatGridDetails?.get(filters.heatGridCode):undefined;
  if(filters.heatGridCode&&!heatDetails)throw AppError.notFound('当前统计快照内没有该正式网格');
  const source = heatDetails ?? (metric === 'selected' ? item.details : item.periodDetails[String(metric)]);
  const selected = source.filter(r => (!filters.businessType || r.businessType === filters.businessType) && (!filters.categoryCode || r.categoryCode === filters.categoryCode) && (!filters.districtCode || r.districtCode === filters.districtCode) && (!filters.adminGridCode || r.adminGridCode === filters.adminGridCode) && (!filters.communityCode || r.communityCode === filters.communityCode) && (!filters.enterpriseCode || r.enterpriseCode === filters.enterpriseCode) && (!filters.from || r.occurredDay! >= filters.from) && (!filters.to || r.occurredDay! <= filters.to));
  const n = Number(page ?? 1), s = Number(size ?? 20); if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(s) || s < 1 || s > 100) throw AppError.validation('页码无效，每页最多100条'); return { contextId: id, page: n, size: s, total: selected.length, items: selected.slice((n - 1) * s, n * s).map(r => p.includes('grid.read') && p.includes('heatmap.read') ? r : { ...r, adminGridCode: null, communityCode: null }) };
}

async function collectRelatedDemands(event: UtilityEvent, access: AccessContext, p: readonly string[]) {
  if (!hasEventDates(event)) {
    return { items: [], total: null, reason: '事件缺少有效时间范围，无法核对关联诉求' };
  }
  const hasSpatial = p.includes('grid.read') && p.includes('heatmap.read');
  const rows = await findRelatedComplaints(
    { gridIds: event.gridIds, businessType: event.businessType },
    { userId: access.userId, userName: '', clientIp: null, access, permissionCodes: [...p] },
    event.startsAt,
    event.endsAt,
  );
  return {
    items: rows.map((r) => ({ id: r.id, type: r.type, occurredAt: r.occurredAt, gridId: hasSpatial ? r.gridId : null })),
    total: rows.length,
    reason: '按授权范围匹配同行业、事件时间范围及已知网格内的正式诉求。时间取来源受理时间，缺失时使用接收时间。',
  };
}

function snapshotRelatedDemands(event: UtilityEvent, snapshot: ScreenContext) {
  const from = Date.parse(event.startsAt);
  const to = Math.min(Date.parse(event.endsAt), snapshot.capturedAt);
  const times = snapshot.eventDemandTimes;
  if (!times || !event.gridIds.length || !hasEventDates(event) || from > to) {
    return { items: [], total: null, reason: '当前统计快照未覆盖有效的事件时段和网格，无法核对诉求。' };
  }
  const grids = new Set(event.gridIds);
  const items = snapshot.details.flatMap((row) => {
    if (row.businessType !== event.businessType || !grids.has(row.adminGridCode)) return [];
    const timing = times.get(String(row.id));
    if (!timing?.occurredAt) return [];
    const occurredAt = Date.parse(timing.occurredAt);
    if (occurredAt < from || occurredAt > to) return [];
    return [{
      id: String(row.id), complaintNo: timing.complaintNo, type: row.categoryCode,
      occurredAt: timing.occurredAt, gridId: row.adminGridCode,
    }];
  });
  return {
    items, total: items.length,
    reason: '在当前统计快照的筛选和授权范围内，按同行业、事件涉及网格和事件时段匹配宜接就办诉求。时间取来源受理时间，缺失时取接收时间。匹配仅作线索，因果关系待核实。',
  };
}

export async function screenEvent(
  contextId: unknown, id: string, access: AccessContext, p: readonly string[],
  readDetail: typeof utilityDetail = utilityDetail,
  layerVersion?: unknown,
) {
  permissions(p);
  if (layerVersion !== undefined && (typeof layerVersion !== 'string' || !/^[a-f0-9]{64}$/.test(layerVersion)))
    throw AppError.validation('图层事件版本无效');
  if (typeof contextId !== 'string') throw AppError.validation('需要 contextId');
  const item = cache.get(contextId);
  if (!item || item.expires <= Date.now()) throw AppError.conflict('查询上下文已过期，请刷新');
  if (item.owner !== access.userId || item.scope !== scopeKey(access))
    throw AppError.notFound('查询上下文不存在或权限范围已变化');
  const captured = item.events.find((row) => row.id === id);
  if (!captured || !p.includes(captured.kind === 'shutdown' ? 'shutdown.read' : 'pipeline.read'))
    throw AppError.notFound('事件不存在或无权限');
  const hasSpatial = p.includes('grid.read') && p.includes('heatmap.read');
  if (layerVersion !== undefined) {
    if (!hasSpatial) throw AppError.forbidden('缺少网格或热力查询权限');
    if (item.mode !== 'real' || captured.kind !== 'shutdown') throw AppError.notFound('真实停水停气事件不存在');
    if (layerVersion !== (captured as {layerVersion?: string}).layerVersion)
      throw AppError.conflict('图层事件版本与统计快照不一致，请刷新');
  }
  const eventView = hasSpatial ? captured : { ...captured, gridIds: [] };
  if (item.mode === 'simulation') {
    const categories = captured.businessType === 'water' ? ['水压问题', '费用咨询'] : ['气压问题', '费用咨询'];
    const rows = hasSpatial ? item.details.filter((d) =>
      d.businessType === captured.businessType && captured.gridIds.includes(d.adminGridCode) &&
      categories.includes(d.categoryCode) && d.occurredDay !== null &&
      d.occurredDay >= captured.startsAt.slice(0, 10) && d.occurredDay <= captured.endsAt.slice(0, 10),
    ) : null;
    return {
      contextId,
      event: eventView,
      history: [{ revision: captured.revision, updatedAt: captured.updatedAt, approvalStatus: captured.approvalStatus,
        reason: captured.reason, area: captured.area, plan: captured.plan, housing: captured.housing, workers: captured.workers }],
      relatedDemands: {
        items: rows?.map((d) => ({ id: d.id, type: d.categoryCode, occurredAt: d.occurredDay, gridId: d.adminGridCode })) ?? [],
        total: rows?.length ?? null,
        reason: hasSpatial ? '模拟规则：当前筛选交集中，同行业、共同网格、事件日期内且类型为压力问题或费用咨询；occurredAt 为日期精度，仅供演示，不代表因果' : '缺少网格或热力权限，模拟关联不可用',
      },
    };
  }

  if (captured.kind === 'shutdown') {
    const layer = await readLayerEventsForBootstrap(pool);
    const row = layer.events.find((candidate) => candidate.eventId === id);
    if (!row) throw AppError.conflict('事件版本已变化，请刷新');
    const current = toUtilityEvent(row, layer.source);
    if (!canReadEvent(current, access)) throw AppError.notFound('事件不存在或无权限');
    if (current.layerVersion !== (captured as { layerVersion?: string }).layerVersion)
      throw AppError.conflict('事件版本已变化，请刷新');

    const gridHistory = hasSpatial ? toUtilityEvents(layer.events, layer.source)
      .filter((previous) => previous.id !== id && hasEventDates(previous) &&
        Date.parse(previous.startsAt) < Date.parse(current.startsAt) && canReadEvent(previous, access) &&
        previous.gridIds.some((grid) => current.gridIds.includes(grid)))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
      .map((previous) => ({
        id: previous.id, title: previous.title, startsAt: previous.startsAt, endsAt: previous.endsAt,
        gridIds: previous.gridIds.filter((grid) => current.gridIds.includes(grid)),
      })) : [];
    return {
      contextId,
      event: eventView,
      history: row.sourceRevision || row.sourceVersion !== null || row.sourceChangedAt ? [{
        revision: row.sourceVersion, sourceRevision: row.sourceRevision, updatedAt: row.sourceChangedAt,
        approvalStatus: current.approvalStatus, area: current.area, plan: current.plan, housing: current.housing,
      }] : [],
      historyNote: '版本信息取自当前图层。同网格停供历史按授权范围读取。',
      gridHistory,
      relatedDemands: layerVersion === undefined
        ? await collectRelatedDemands(current, access, p)
        : snapshotRelatedDemands(current, item),
      detailSource: layer.source,
    };
  }

  const detail = await readDetail(item.mode, id, {
    userId: access.userId, userName: '', clientIp: null, access, permissionCodes: [...p],
  });
  if (detail.event.id !== id || detail.event.kind !== captured.kind ||
      detail.event.revision !== captured.revision || detail.event.updatedAt !== captured.updatedAt ||
      String(detail.event.sourceRevision ?? '') !== String(captured.sourceRevision ?? ''))
    throw AppError.conflict('事件版本已变化，请刷新');
  const hasDates = hasEventDates(detail.event);
  return {
    contextId,
    event: eventView,
    history: detail.history.map((h: any) => ({
      revision: h.revision, updatedAt: h.updatedAt, approvalStatus: h.event?.approvalStatus ?? null,
      reason: h.event?.reason ?? null, area: h.event?.area ?? null, plan: h.event?.plan ?? null, housing: h.event?.housing ?? null,
      workers: h.event?.workers ?? null,
    })),
    relatedDemands: {
      items: detail.complaints.map((c) => ({ id: c.id, type: c.type, occurredAt: c.occurredAt, gridId: hasSpatial ? c.gridId : null })),
      total: hasDates ? detail.complaints.length : null,
      reason: hasDates ? '从正式台账独立读取授权范围内、与事件行业、时间及已知网格匹配的诉求。' : '事件缺少有效时间范围，无法核对关联诉求',
    },
  };
}

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




