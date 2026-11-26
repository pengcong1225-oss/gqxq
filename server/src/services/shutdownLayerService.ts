/**
 * 停水停气图层服务（标书 1.2.6 停水停气图层）
 *
 * ===== 标书原文 =====
 * 「建设停水停气图层，根据停水停气上报时填写的涉及的网格信息，把停水停气事件与网格关联，
 *   当网格产生一个停水停气事件则产生一个打点标识，点击标识可查看停水停气企业、业务类型、
 *   时间范围、涉及户数、该事件产生的诉求量等信息，点击诉求量，可查看诉求详情。
 *   同时根据停水停气事件的划分也将图层划分为计划性停水、计划性停气、突发性停水、突发性停气图层。
 *   此外，若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示。
 *   点击事件详情查看时，可查看到事件的基本信息，包括企业名称、业务类型、时间范围、涉及户数、
 *   影响区域、应急预案、房屋信息、该网格停水停气历史数据等信息。」
 *
 * ===== 落图单位 =====
 * 「打点标识」= 一个 (事件 × 涉及网格) 点。同一事件涉及多个网格时产生多个点，
 * 前端按 eventId 关联，点击任一标识其余同事件标识联动高亮（标书明确要求）。
 * 点的位置取该网格的几何中心：admin_grid.geometry 有值则取真实几何质心，
 * 否则退回街道点位质心 / 区县中心（frontend 侧已有该能力）。
 *
 * ===== 数据口径（重要）=====
 * 数据来自正式台账或 `gqxq_tender_support_store.utility-feed-real` 的真实停水停气上报。
 */
import type {Pool} from 'mysql2/promise';
import {canAccessComplaint, type AccessContext} from '../auth/accessScope';
import {UNKNOWN_TIME_SENTINEL, type MappedUtilitySource} from '../domain/utilityFeed';
import {shutdownLayerVersion} from './eventSourceService';

/** 四类图层（标书明确要求分成四个独立图层） */
export type ShutdownCategory = 'planned_water' | 'planned_gas' | 'emergency_water' | 'emergency_gas';

export const SHUTDOWN_CATEGORIES: ShutdownCategory[] = [
  'planned_water',
  'planned_gas',
  'emergency_water',
  'emergency_gas',
];

export const CATEGORY_LABEL: Record<ShutdownCategory, string> = {
  planned_water: '计划性停水',
  planned_gas: '计划性停气',
  emergency_water: '突发性停水',
  emergency_gas: '突发性停气',
};

/**
 * 坐标系推定开关（Lead 约束：推定逻辑必须可关，不能变成不可撤销的隐式行为）。
 *
 * 置 `GQXQ_SHUTDOWN_ASSUME_GCJ02=false` 即可一键退回「来源坐标系不明 → 不落网格」的严格口径，
 * 此时图层不再使用下面的推定结论，接口照常报告堵点。
 */
export function assumeGcj02Source(): boolean {
  return String(process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02 ?? 'true').toLowerCase() !== 'false';
}

/**
 * 坐标系推定依据（写入接口与代码注释，供后来者复核，不允许只写「已转换」）。
 *
 * 事实：来源快照 467 条里 `source.coordinateSystem` 与 `fields.coordinateSystem` **全部为 null**，
 * 因此 `domain/utilityFeed.ts` 第 49 行 `if(...['WGS84','GCJ02','GCJ-02'].includes(coordinateSystem))`
 * 的几何兜底分支**永远进不去** —— 这是「影响范围无网格」的最底层原因。
 *
 * 两个独立实验判定来源实际是 GCJ-02（高德口径）：
 *   实验 A 内聚性投票：同一事件不应横跨多个区县。把 416 个「小多边形（<2km）」事件按两种假设换算后，
 *     只落在一个区县的事件数 —— 当作 WGS84 = 84/416，GCJ-02→WGS84 = 175/416。
 *   实验 B 小多边形内含小区（决定性命中率）：抽 12 个 <500m 的多边形，
 *     当作 WGS84 时 11/12 个内部一个小区都没有；GCJ-02→WGS84 后精准命中
 *     「中化誉峰小区」「清江樵湖小区」「三峡大学SOGO广场」「梧桐邑九棠府」等真实小区。
 *   宜昌的 GCJ-02 偏移约 680m，正好把多边形推到隔壁小区，这也解释了「看起来对不上」。
 */
export const COORDINATE_ASSUMPTION_NOTE =
  '来源未声明坐标系；经 GCJ-02→WGS84 推定转换（依据：同事件跨区县内聚性 175/416 vs 84/416；小多边形内小区命中率 12/12 vs 1/12）';

type CommunityGridPoint = import('mysql2').RowDataPacket & {
  location_lng: number | string;
  location_lat: number | string;
  admin_grid_code: string;
};

/** 一个事件在某网格上的打点标识 */
export interface ShutdownMarker {
  /** 标识唯一键 = eventId + gridCode（同一事件多网格 → 多个标识） */
  markerId: string;
  /** 事件 ID：联动高亮的匹配依据 */
  eventId: string;
  category: ShutdownCategory;
  categoryLabel: string;
  gridCode: string;
  gridName: string | null;
  businessType: 'water' | 'gas';
  /** 事件在该网格上的中心点（WGS84）。无几何时为 null —— 前端如实不画 */
  center: [number, number] | null;
}

/** 事件与诉求的关联摘要 */
export interface ShutdownComplaintItem {
  complaintId: string;
  title: string;
  occurredAt: string | null;
  category: string | null;
}

export interface ShutdownEvent {
  eventId: string;
  layerVersion: string;
  category: ShutdownCategory;
  categoryLabel: string;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  businessType: 'water' | 'gas';
  shutdownType: 'planned' | 'emergency';
  /** 时间范围（标书要求） */
  startTime: string | null;
  endTime: string | null;
  restoredAt: string | null;
  /** 涉及户数（标书要求） */
  affectedHouseholds: number | null;
  /** 该事件产生的诉求量（标书要求；缺失为 null，不补 0） */
  complaintCount: number | null;
  complaints: ShutdownComplaintItem[];
  /** 涉及网格（可能多个 → 多标识联动高亮） */
  gridCodes: string[];
  /** 影响区域（标书要求） */
  affectedArea: string | null;
  /** 应急预案（标书要求） */
  emergencyPlan: string | null;
  /** 房屋信息（标书要求） */
  housingInfo: string | null;
  /** 来源追溯 */
  sourceApplyNo: string | null;
  sourceFeedId: number | null;
  approvalStatus: string | null;
  /** 影响范围多边形（WGS84；无则 null，前端不画） */
  ring: number[][] | null;
  coordinateNote: string | null;
  /** 该事件的多边形坐标系是否为**推定值**（true 时前端必须显示「推定」角标） */
  coordinateAssumed: boolean;
  status: string | null;
}

/** 某网格的历史停水停气事件（标书要求：该网格停水停气历史数据） */
export interface ShutdownGridHistory {
  gridCode: string;
  gridName: string | null;
  total: number;
  byCategory: Record<ShutdownCategory, number>;
  events: {
    eventId: string;
    category: ShutdownCategory;
    categoryLabel: string;
    enterpriseName: string | null;
    startTime: string | null;
    endTime: string | null;
    affectedHouseholds: number | null;
  }[];
}

/** 数据堵点的量化报告（如实上报，不粉饰） */
export interface ShutdownDataBlocker {
  /** 来源快照里的真实条数 */
  sourceTotal: number;
  /** 仍待映射的来源数及按原快照问题组合分组的互斥计数 */
  pendingCount: number;
  pendingIssueGroups: {issues: string[]; count: number}[];
  /** 已成功落库可打点的事件数 */
  locatedCount: number;
  /** 因「填报单位未映射」落不了的条数 */
  blockedByEnterprise: number;
  /** 因「影响范围无网格」落不了的条数 */
  blockedByGrid: number;
  /** 因「计划/突发性质不明」落不了的条数 */
  blockedByNature: number;
  /** 既无企业又无网格的条数 */
  blockedByBoth: number;
  blockedByApproval: number;
  blockedByTime: number;
  /** 待业主确认归属口径的企业（不自己猜） */
  pendingEnterprises: {name: string; count: number; reason: string}[];
  /** 修好企业映射后能落库的条数（来源名能在 enterprise 表精确命中的） */
  fixableByEnterpriseFix: number;
  /** 修好坐标系推定后能落网格的条数 */
  resolvableByGridWhenAssumed: number;
  /** 企业 + 网格都能解析、真正能落库打点的条数 */
  resolvableBoth: number;
  /** 其中涉及多个网格（标书「多网格联动高亮」的真实样本） */
  resolvableBothMultiGrid: number;
  /** 坐标系推定是否已启用 */
  coordinateAssumptionEnabled: boolean;
  /** 坐标系推定依据 */
  coordinateAssumptionNote: string;
  /** 卡点说明（人话） */
  note: string;
}

export interface ShutdownLayerResult {
  category: ShutdownCategory | 'all';
  /** 数据来源：snapshot=来源快照直读（未落主表） / table=shutdown_application 主表 */
  dataSource: ShutdownDataSource;
  /** 数据来源说明（前端必须显式展示，别让业主以为已是正式台账数据） */
  dataSourceNote: string;
  events: ShutdownEvent[];
  markers: ShutdownMarker[];
  /** 网格 → 历史事件（标书要求） */
  gridHistory: Record<string, ShutdownGridHistory>;
  /** 四类各自的事件数 */
  categoryCounts: Record<ShutdownCategory, number>;
  /** 涉及网格总数 */
  gridCount: number;
  /** 数据堵点如实说明 */
  dataNote: string | null;
  /** 企业映射堵点说明 */
  mappingNote: string | null;
  /** 量化堵点 */
  blocker: ShutdownDataBlocker;
}

/* ------------------------------------------------------------------ 工具 */

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** 日期归一为 ISO 字符串（MySQL datetime → ISO） */
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** 解析 admin_grid_codes（JSON 列在 mysql2 下可能是字符串或数组） */
function parseGridCodes(raw: unknown): string[] {
  if (!raw) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = raw.split(',');
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length === 6 || v.length === 9);
}

/** 归一化四类分类：业务类型 + 计划/突发 */
function categoryOf(businessType: unknown, shutdownType: unknown): ShutdownCategory | null {
  const bt = String(businessType ?? '').toLowerCase();
  const st = String(shutdownType ?? '').toLowerCase();
  const biz: 'water' | 'gas' | null = bt === 'water' || bt === 'gas' ? bt : null;
  if (!biz) return null;
  // planned=计划性 / emergency=突发性；兼容「计划停水」「计划外停水」等中文写法
  const planned =
    st === 'planned' || st === 'plan' || st === '计划' || st === '计划性' || st.includes('计划停');
  const emergency =
    st === 'emergency' || st === 'urgent' || st === '突发' || st === '突发性' || st.includes('计划外') || st.includes('抢修');
  if (emergency) return (`emergency_${biz}` as ShutdownCategory);
  if (planned) return (`planned_${biz}` as ShutdownCategory);
  return null;
}

/* ------------------------------------------------------------------ 主逻辑 */

/** 数据来源：snapshot=来源快照直读（未落主表） / table=shutdown_application 主表 */
export type ShutdownDataSource = 'snapshot' | 'table';

export const DATA_SOURCE_NOTE: Record<ShutdownDataSource, string> = {
  snapshot:
    '事件来自公用事业来源快照，使用已核验网格或地图标注的历史范围。正式台账独立维护。',
  table:
    '事件来自 shutdown_application 业务主表（已落库的正式台账记录）',
};

/**
 * 读取停水停气图层数据。
 *
 * 数据来源两种（用 `dataSource` 字段区分，前端必须显式展示）：
 *
 *   A. `snapshot`（**当前生效**）：直读 `gqxq_tender_support_store.utility-feed-real` 快照里
 *      已能解析企业 + 网格的来源记录，在内存中构造事件，**不写任何主表**。
 *      为什么：`shutdown_application` 全库零写入方（只有 SELECT），落库链路尚未建设；
 *      且「什么算一条正式停水停气事件」的口径（主键用哪个字段、审批状态怎么映射、
 *      未审批事件是否计入）属数据治理决策，不应由实现方代定。
 *
 *   B. `table`：读 `shutdown_application` 主表。等口径确认、同步器建好之后自动切换。
 *
 * 两条路径共用同一套「事件 → 打点标识 → 网格历史」组装逻辑（见 `assembleLayer`），
 * 将来加同步器只需让主表有数据，不改下游。
 */
export async function loadShutdownLayer(
  db: Pool,
  category: ShutdownCategory | 'all',
  access: AccessContext,
): Promise<ShutdownLayerResult> {
  const layer = await readLayerEventsForBootstrap(db);
  const all = access.rules.some((rule) => rule.kind === 'all');
  const events = layer.events.filter((event) => canReadShutdownEvent(access, event.enterpriseCode, event.gridCodes));
  const blocker = all ? await readSourceBlocker(db, 0) : emptyBlocker(0);
  const result = assembleLayer(category, events, layer.gridNames, blocker, layer.source);
  if (!all) {
    result.dataNote = result.events.length
      ? `${result.dataSourceNote}。按授权范围显示停供事件。`
      : '授权范围内暂无可打点停供事件';
    result.blocker.note = '全域来源诊断仅向全域用户提供';
  }
  return result;
}

export function canReadShutdownEvent(access: AccessContext, enterpriseCode: string | null, gridCodes: string[]) {
  // Event descriptions and household totals cover all affected grids.
  return gridCodes.length > 0 && gridCodes.every((code) => canAccessComplaint(access, {
    enterprise_code: enterpriseCode, district_code: code.slice(0, 6),
  }));
}

/**
 * 对外暴露的「统一事件读取」入口（供 bootstrap 等非图层场景使用）。
 *
 * 与 `loadShutdownLayer` 共用同一套判定与解析：主表有可用行走主表，否则退回来源快照。
 * 这样「图层说 157 起、详情说 110 起」的口径分裂不会再次出现。
 */
export async function readLayerEventsForBootstrap(
  db: Pool
): Promise<{ events: RawLayerEvent[]; source: ShutdownDataSource; gridNames: Record<string, string> }> {
  const [gridRows] = await db.query<import('mysql2').RowDataPacket[]>(
    'select code, name, district_code from admin_grid'
  );
  const gridNames: Record<string, string> = {};
  for (const g of gridRows) gridNames[String(g.code)] = String(g.name ?? '');

  const tableEvents = await readTableEvents(db);
  const tableLocatable = tableEvents.filter(
    (e) => e.gridCodes.length > 0 && (e.enterpriseName || e.enterpriseCode)
  );
  if (tableLocatable.length) return { events: tableLocatable, source: 'table', gridNames };
  return { events: await readSnapshotEvents(db, gridNames), source: 'snapshot', gridNames };
}
/* --------------------------------------------------------------- 主表路径 */

export interface RawLayerEvent {
  eventId: string;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  businessType: 'water' | 'gas';
  shutdownType: 'planned' | 'emergency';
  startTime: string | null;
  endTime: string | null;
  restoredAt: string | null;
  affectedHouseholds: number | null;
  complaintCount: number | null;
  complaints: ShutdownComplaintItem[];
  gridCodes: string[];
  affectedArea: string | null;
  emergencyPlan: string | null;
  housingInfo: string | null;
  sourceApplyNo: string | null;
  sourceFeedId: number | null;
  approvalStatus: string | null;
  ring: number[][] | null;
  coordinateNote: string | null;
  coordinateAssumed: boolean;
  status: string | null;
  sourceRevision: string | null;
  sourceVersion: number | null;
  sourceChangedAt: string | null;
}

async function readTableEvents(db: Pool): Promise<RawLayerEvent[]> {
  const [rows] = await db.query<import('mysql2').RowDataPacket[]>(
    `select shutdown_id, app_no, enterprise_code, enterprise_name, business_type, shutdown_type,
            affected_area, affected_households, planned_start_time, planned_end_time, status,
            admin_grid_codes, emergency_plan, housing_info, source_apply_no, source_feed_id,
            approval_status, coordinate_note, source_revision, source_version, received_at
       from shutdown_application
      order by planned_start_time is null, planned_start_time desc, id desc`
  );
  const out: RawLayerEvent[] = [];
  for (const r of rows) {
    if (!categoryOf(r.business_type, r.shutdown_type)) continue;
    const st = String(r.shutdown_type).toLowerCase();
    out.push({
      eventId: String(r.shutdown_id ?? ''),
      enterpriseCode: strOrNull(r.enterprise_code),
      enterpriseName: strOrNull(r.enterprise_name),
      businessType: String(r.business_type) as 'water' | 'gas',
      shutdownType: st.includes('emerg') || st.includes('突发') ? 'emergency' : 'planned',
      startTime: isoOrNull(r.planned_start_time),
      endTime: isoOrNull(r.planned_end_time),
      restoredAt: null,
      affectedHouseholds: numOrNull(r.affected_households),
      // 诉求量需与诉求表做时段+网格匹配，shutdown_complaint_link 为空 → 如实 null，不补 0
      complaintCount: null,
      complaints: [],
      gridCodes: parseGridCodes(r.admin_grid_codes),
      affectedArea: strOrNull(r.affected_area),
      emergencyPlan: strOrNull(r.emergency_plan),
      housingInfo: strOrNull(r.housing_info),
      sourceApplyNo: strOrNull(r.source_apply_no),
      sourceFeedId: numOrNull(r.source_feed_id),
      approvalStatus: strOrNull(r.approval_status),
      ring: null,
      coordinateNote: strOrNull(r.coordinate_note),
      // 主表行不带多边形：ring 为 null 时谈不上坐标系推定
      coordinateAssumed: false,
      status: strOrNull(r.status),
      sourceRevision: strOrNull(r.source_revision),
      sourceVersion: numOrNull(r.source_version),
      sourceChangedAt: isoOrNull(r.received_at),
    });
  }
  return out;
}

/* ------------------------------------------------------------- 快照路径 */

/** 从来源 fields 里取描述用文本（缺失如实留 null；「无」「0」「否」是占位值不算内容） */
function pickText(f: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = f[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s && s !== '无' && s !== '0' && s !== '否') return s;
  }
  return null;
}

/**
 * 审批状态归一。
 * 来源 status/approvalStatus：00=待审、10/11=已审、90=驳回；其它 legacy 码不猜。
 */
function normalizeApproval(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (s === '00') return 'pending';
  if (s === '10' || s === '11') return 'approved';
  if (s === '90') return 'rejected';
  return s ? `unknown:${s}` : 'unknown';
}

/** 来源时间 `2026-09-30 23:00:00` → ISO（+08:00） */
function feedIso(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const norm = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(s)
    ? `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}+08:00`
    : s;
  const d = new Date(norm);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function legacyReporter(source: MappedUtilitySource['source']): string {
  const traces = source.approvalTraces ?? [];
  const isInitiator = (trace: (typeof traces)[number]) => String(trace.action ?? '').trim() === '3';
  const byAction = traces.filter(isInitiator).map(trace => strOrNull(trace.operator)).filter(Boolean);
  const byOpinion = traces.filter(trace => /发起人/.test(String(trace.opinion ?? '')))
    .map(trace => strOrNull(trace.operator)).filter(Boolean);
  return strOrNull(source.enterprise?.name) ?? strOrNull(source.fields?.companyName) ??
    strOrNull(source.fields?.sgdwName) ?? byAction.at(-1) ?? byOpinion.at(-1) ?? '';
}

function shutdownNature(fields: Record<string, unknown>) {
  const nature = String(fields.isReportTingshui ?? fields.isReportTingqi ?? '').trim();
  if (/计划外|突发|抢修|紧急/.test(nature)) return 'emergency';
  return /计划/.test(nature) ? 'planned' : null;
}

function sourceDisplayRing(source: MappedUtilitySource['source'], allowAssumption: boolean) {
  const fields = source.fields ?? {};
  const crs = String(source.coordinateSystem ?? fields.coordinateSystem ?? '').trim().toUpperCase();
  const coordinateAssumed = !crs && allowAssumption;
  const rawRing = parseFeedRing(fields);
  if (!rawRing) return {ring: null, coordinateAssumed: false};
  if (crs === 'WGS84') return {ring: rawRing, coordinateAssumed: false};
  if (['GCJ02', 'GCJ-02'].includes(crs) || coordinateAssumed) {
    return {ring: rawRing.map(([lng, lat]) => gcj02ToWgs84(lng, lat)), coordinateAssumed};
  }
  return {ring: null, coordinateAssumed: false};
}

/**
 * 从来源快照构造可直接打点的事件（全程只读，不写任何表）。
 *
 * 只收 **企业能解析 + 网格能解析** 的记录；其余由 `readSourceBlocker` 如实统计，
 * 不在图层上冒充事件，也不拿小区点位硬凑网格。
 */
async function readSnapshotEvents(
  db: Pool,
  gridNames: Record<string, string>
): Promise<RawLayerEvent[]> {
  const [storeRows] = await db.query<import('mysql2').RowDataPacket[]>(
    "select content from gqxq_tender_support_store where store_key = 'utility-feed-real'"
  );
  if (!storeRows.length) return [];
  let content = storeRows[0].content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return [];
    }
  }
  const sources: unknown[] = Array.isArray((content as { sources?: unknown[] })?.sources)
    ? (content as { sources: unknown[] }).sources
    : [];
  if (!sources.length) return [];

  const [entRows] = await db.query<import('mysql2').RowDataPacket[]>(
    "select enterprise_code, enterprise_name, business_type from enterprise where status = 'enabled'"
  );
  // 小区点位：库内没有 admin_grid 边界几何，只能靠「点位归属哪个网格」把多边形转成网格
  const [commRows] = await db.query<CommunityGridPoint[]>(
    'select location_lng, location_lat, admin_grid_code from community ' +
      'where location_lng is not null and location_lat is not null and location_lng <> 0 and location_lat <> 0'
  );

  const assumeGcj = assumeGcj02Source();
  const out: RawLayerEvent[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

  for (const rawItem of sources) {
    const s = rawItem as Partial<MappedUtilitySource>;
    const src = s?.source;
    if (src?.dataMode !== 'real') continue;
    const f = (src.fields ?? {}) as Record<string, unknown>;
    const kind = str(src.kind);
    const biz: 'water' | 'gas' | null =
      kind === 'gas-stops' ? 'gas' : kind === 'water-stops' ? 'water' : null;
    // 只处理停水停气（施工改造归 1.2.7 管线图层）
    if (!biz) continue;

    // —— 计划 / 突发性质：来源自带字段，不猜 ——
    const shutdownType = shutdownNature(f);
    if (!shutdownType) continue;

    // 同一申请可能按区县保存多条映射，地图按申请号汇合其已核验网格。
    const verifiedParts = Array.isArray(s.events) ? s.events.filter(event => event.hasVerifiedGrid === true) : [];
    const verified = verifiedParts[0];
    if (verified && !verifiedParts.every(event => event.mode === 'real' && event.kind === 'shutdown' &&
      event.sourceSystem === 'public-utility' && event.sourceApplicationNo === src.sourceApplicationNo &&
      event.sourceRevision === src.revision && event.revision === verified.revision && event.businessType === biz &&
      event.enterpriseId === verified.enterpriseId && event.gridIds.length &&
      event.gridIds.every(code => Object.hasOwn(gridNames, code)))) continue;
    if (!verified && src.sourceKind !== 'legacy') continue;

    const nameCandidate = legacyReporter(src);
    const entHit = entRows.filter(e => String(e.business_type) === biz && (verified
      ? String(e.enterprise_code) === verified.enterpriseId
      : nameCandidate !== '' && String(e.enterprise_name) === nameCandidate));
    if (entHit.length !== 1) continue;
    const enterprise = entHit[0];

    // 历史多边形兼容仅用于地图展示。来源已核验的网格优先。
    const {ring, coordinateAssumed} = sourceDisplayRing(src, !verified && assumeGcj);
    const gridCodes = verified
      ? [...new Set(verifiedParts.flatMap(event => event.gridIds))].sort()
      : legacyGridCodes(ring, commRows).filter(code => Object.hasOwn(gridNames, code));
    if (!gridCodes.length) continue;

    const startTime = verified ? feedIso(verified.startsAt === UNKNOWN_TIME_SENTINEL ? null : verified.startsAt)
      : feedIso(f.tingshuiDate ?? f.tingqiDate ?? f.startsAt);
    const endTime = verified ? feedIso(verified.endsAt === UNKNOWN_TIME_SENTINEL ? null : verified.endsAt)
      : feedIso(f.fugongDate ?? f.fuqiDate ?? f.endsAt);
    const households = numOrNull(f.effectResidentTotal) ?? 0;
    const nonResident = numOrNull(f.effectNotResidentTotal) ?? 0;

    out.push({
      // 事件 ID 用来源申请号：稳定可追溯，刷新不跳变
      eventId: str(src.sourceApplicationNo) || `feed-${String(src.feedId ?? '')}`,
      enterpriseCode: str(enterprise.enterprise_code),
      enterpriseName: str(enterprise.enterprise_name),
      businessType: biz,
      shutdownType,
      startTime,
      endTime,
      restoredAt: verified ? verified.restoredAt : endTime,
      affectedHouseholds: verified?.households ?? households + nonResident,
      complaintCount: null,
      complaints: [],
      gridCodes,
      affectedArea: pickText(f, ['keyUnit']) ?? strOrNull(verified?.area) ?? gridCodes.map((c) => gridNames[c] ?? c).join('、'),
      emergencyPlan: pickText(f, ['plan', 'emergencyPlan']),
      housingInfo: pickText(f, ['housing', 'housingInfo']),
      sourceApplyNo: str(src.sourceApplicationNo) || null,
      sourceFeedId: numOrNull(src.feedId),
      approvalStatus: verified?.approvalStatus ?? normalizeApproval(src.approvalStatus ?? src.status),
      ring,
      coordinateNote: coordinateAssumed ? COORDINATE_ASSUMPTION_NOTE : null,
      coordinateAssumed,
      status: str(src.status) || null,
      sourceRevision: str(src.revision) || null,
      sourceVersion: verified?.revision ?? null,
      sourceChangedAt: feedIso(src.changedAt),
    });
  }
  return out;
}

/* -------------------------------------------------------------- 组装图层 */

/** 把原始事件组装成「四类事件 + 打点标识 + 网格历史」（两条数据源共用） */
function assembleLayer(
  category: ShutdownCategory | 'all',
  rawEvents: RawLayerEvent[],
  gridNames: Record<string, string>,
  blocker: ShutdownDataBlocker,
  dataSource: ShutdownDataSource
): ShutdownLayerResult {
  const events: ShutdownEvent[] = [];
  const gridHistory: Record<string, ShutdownGridHistory> = {};
  const categoryCounts: Record<ShutdownCategory, number> = {
    planned_water: 0,
    planned_gas: 0,
    emergency_water: 0,
    emergency_gas: 0,
  };

  for (const rawEv of rawEvents) {
    const cat = (`${rawEv.shutdownType}_${rawEv.businessType}`) as ShutdownCategory;
    if (category !== 'all' && category !== cat) continue;

    const ev: ShutdownEvent = {
      ...rawEv, layerVersion: shutdownLayerVersion(rawEv, dataSource), category: cat, categoryLabel: CATEGORY_LABEL[cat],
    };
    events.push(ev);
    categoryCounts[cat] += 1;

    // 该网格历史停水停气（标书要求：事件详情里可看该网格历史数据）
    for (const code of ev.gridCodes) {
      const h =
        gridHistory[code] ??
        (gridHistory[code] = {
          gridCode: code,
          gridName: gridNames[code] ?? null,
          total: 0,
          byCategory: { planned_water: 0, planned_gas: 0, emergency_water: 0, emergency_gas: 0 },
          events: [],
        });
      h.total += 1;
      h.byCategory[cat] += 1;
      h.events.push({
        eventId: ev.eventId,
        category: cat,
        categoryLabel: CATEGORY_LABEL[cat],
        enterpriseName: ev.enterpriseName,
        startTime: ev.startTime,
        endTime: ev.endTime,
        affectedHouseholds: ev.affectedHouseholds,
      });
    }
  }

  // 打点标识：一个 (事件 × 网格) 一个点。同一事件多网格 → 多个标识，
  // 前端按 eventId 联动高亮（标书明确要求）。
  const markers: ShutdownMarker[] = [];
  for (const ev of events) {
    for (const code of ev.gridCodes) {
      markers.push({
        markerId: `${ev.eventId}@${code}`,
        eventId: ev.eventId,
        category: ev.category,
        categoryLabel: ev.categoryLabel,
        gridCode: code,
        gridName: gridNames[code] ?? null,
        businessType: ev.businessType,
        // 点位中心由前端按网格面/质心算；算不出就不画（不臆造坐标）
        center: null,
      });
    }
  }

  blocker.locatedCount = events.length;

  const notes: string[] = [DATA_SOURCE_NOTE[dataSource]];
  if (!events.length) {
    notes.push('停水停气事件图层暂无数据：没有同时满足「企业可映射」与「涉及网格可解析」的来源记录');
  }
  if (blocker.sourceTotal > 0) {
    notes.push(
      `来源快照有 ${blocker.sourceTotal} 条真实停供上报，其中 ${blocker.pendingCount} 条待映射。` +
        `当前图层可打点 ${events.length} 起。`
    );
  }

  return {
    category,
    dataSource,
    dataSourceNote: DATA_SOURCE_NOTE[dataSource],
    events,
    markers,
    gridHistory,
    categoryCounts,
    gridCount: Object.keys(gridHistory).length,
    dataNote: notes.join('；'),
    mappingNote: blocker.pendingCount ? blocker.note : null,
    blocker,
  };
}

const emptyBlocker = (locatedCount: number): ShutdownDataBlocker => ({
  sourceTotal: 0,
  pendingCount: 0,
  pendingIssueGroups: [],
  locatedCount,
  blockedByEnterprise: 0,
  blockedByGrid: 0,
  blockedByNature: 0,
  blockedByBoth: 0,
  blockedByApproval: 0,
  blockedByTime: 0,
  pendingEnterprises: [],
  fixableByEnterpriseFix: 0,
  resolvableByGridWhenAssumed: 0,
  resolvableBoth: 0,
  resolvableBothMultiGrid: 0,
  coordinateAssumptionEnabled: assumeGcj02Source(),
  coordinateAssumptionNote: COORDINATE_ASSUMPTION_NOTE,
  note: '',
});

/** GCJ-02 → WGS84（宜昌实测偏移约 680m）。与 domain/utilityCoordinates.ts 同一算法。 */
function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const PI = Math.PI;
  const tLat = (x: number, y: number) => {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
    r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
    return r;
  };
  const tLng = (x: number, y: number) => {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
    r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
    return r;
  };
  let dLat = tLat(lng - 105, lat - 35);
  let dLng = tLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng - dLng, lat - dLat];
}

function legacyGridCodes(ring: number[][] | null, points: CommunityGridPoint[]) {
  if (!ring) return [];
  const hits = new Set<string>();
  for (const point of points) {
    const lng = Number(point.location_lng);
    const lat = Number(point.location_lat);
    const code = strOrNull(point.admin_grid_code);
    if (code && Number.isFinite(lng) && Number.isFinite(lat) && pointInRing([lng, lat], ring)) hits.add(code);
  }
  return [...hits].sort();
}

function pointInRing(p: [number, number], r: number[][]): boolean {
  let yes = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i];
    const b = r[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}

/** 从来源 fields 解析影响范围多边形（latLog 是「lng,lat;lng,lat;…」字符串） */
function parseFeedRing(fields: Record<string, unknown>): number[][] | null {
  const raw = fields.tingshuiRange ?? fields.tingqiRange ?? fields.constructionRange ?? fields.range;
  let parsed: unknown = raw;
  // 来源可能是「JSON 字符串里再套一个 JSON 字符串」（历史数据两层转义）
  for (let i = 0; i < 2 && typeof parsed === 'string'; i += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const first = parsed[0] as {latLog?: unknown};
  if (!first || typeof first.latLog !== 'string') return null;
  const pts = first.latLog
    .split(';')
    .filter(Boolean)
    .map((s) => s.split(',').map(Number))
    .filter((a) => a.length === 2 && a.every((n) => Number.isFinite(n)));
  return pts.length >= 3 ? (pts as number[][]) : null;
}

/** 按已保存的问题原文核对真实停供记录，并单独计算历史地图的空间线索。 */
async function readSourceBlocker(db: Pool, locatedCount: number): Promise<ShutdownDataBlocker> {
  const result = emptyBlocker(locatedCount);
  try {
    const [storeRows] = await db.query<import('mysql2').RowDataPacket[]>(
      "select content from gqxq_tender_support_store where store_key = 'utility-feed-real'"
    );
    const content = storeRows[0]?.content;
    const snapshot = typeof content === 'string' ? JSON.parse(content) : content;
    const sources: MappedUtilitySource[] = Array.isArray(snapshot?.sources) ? snapshot.sources.filter(
      (row: MappedUtilitySource) => row?.source?.dataMode === 'real' &&
        ['gas-stops', 'water-stops'].includes(row.source.kind)
    ) : [];
    const pending = sources.filter(row => row.syncStatus === 'pending_mapping');
    result.sourceTotal = sources.length;
    result.pendingCount = pending.length;
    if (!pending.length) return result;

    const [companies] = await db.query<import('mysql2').RowDataPacket[]>(
      "select enterprise_code, enterprise_name, business_type from enterprise where status = 'enabled'"
    );
    const [points] = await db.query<CommunityGridPoint[]>(
      'select location_lng, location_lat, admin_grid_code from community ' +
        'where location_lng is not null and location_lat is not null and location_lng <> 0 and location_lat <> 0'
    );
    const enterpriseGroups = new Map<string, number>();
    const issueGroups = new Map<string, ShutdownDataBlocker['pendingIssueGroups'][number]>();

    for (const {source, issues: rawIssues} of pending) {
      const issues = [...new Set(Array.isArray(rawIssues) ? rawIssues.filter(issue => typeof issue === 'string') : [])].sort();
      const key = JSON.stringify(issues);
      const group = issueGroups.get(key) ?? {issues, count: 0};
      group.count += 1;
      issueGroups.set(key, group);

      const enterpriseGap = issues.some(issue => issue.includes('填报单位尚未映射'));
      const gridGap = issues.some(issue => /网格|影响范围无/.test(issue));
      if (enterpriseGap) result.blockedByEnterprise += 1;
      if (gridGap) result.blockedByGrid += 1;
      if (enterpriseGap && gridGap) result.blockedByBoth += 1;
      if (!shutdownNature(source.fields ?? {})) result.blockedByNature += 1;
      if (issues.some(issue => /审批/.test(issue))) result.blockedByApproval += 1;
      if (issues.some(issue => /开始或结束时间|结束或复供时间/.test(issue))) result.blockedByTime += 1;

      const name = legacyReporter(source);
      const businessType = source.kind === 'gas-stops' ? 'gas' : 'water';
      const exactEnterprise = name !== '' && companies.filter(
        company => company.business_type === businessType && company.enterprise_name === name
      ).length === 1;

      if (enterpriseGap) {
        const label = name || '来源未提供填报单位';
        enterpriseGroups.set(label, (enterpriseGroups.get(label) ?? 0) + 1);
        if (exactEnterprise) result.fixableByEnterpriseFix += 1;
      }

      if (source.sourceKind !== 'legacy') continue;
      const {ring, coordinateAssumed} = sourceDisplayRing(source, result.coordinateAssumptionEnabled);
      const gridCodes = legacyGridCodes(ring, points);
      if (coordinateAssumed && gridCodes.length) result.resolvableByGridWhenAssumed += 1;
      if (exactEnterprise && gridCodes.length) {
        result.resolvableBoth += 1;
        if (gridCodes.length > 1) result.resolvableBothMultiGrid += 1;
      }
    }

    result.pendingEnterprises = [...enterpriseGroups].map(([name, count]) => ({
      name, count, reason: '来源快照缺少唯一的同业启用企业映射，需核对填报主体。',
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    result.pendingIssueGroups = [...issueGroups.values()].sort((a, b) =>
      b.count - a.count || a.issues.join('、').localeCompare(b.issues.join('、'))
    );
    result.note = `待映射 ${result.pendingCount} 条。缺企业 ${result.blockedByEnterprise} 条、缺网格 ${result.blockedByGrid} 条、` +
      `缺审批证据 ${result.blockedByApproval} 条、缺有效时间 ${result.blockedByTime} 条。各原因可同时出现。`;
    return result;
  } catch {
    return emptyBlocker(locatedCount);
  }
}
