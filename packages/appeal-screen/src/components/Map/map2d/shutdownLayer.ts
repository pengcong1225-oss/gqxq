/**
 * 停水停气图层（标书 1.2.6 停水停气图层）
 *
 * ===== 标书原文 =====
 * 「建设停水停气图层，根据停水停气上报时填写的涉及的网格信息，把停水停气事件与网格关联，
 *   当网格产生一个停水停气事件则产生一个打点标识，点击标识可查看停水停气企业、业务类型、
 *   时间范围、涉及户数、该事件产生的诉求量等信息，点击诉求量，可查看诉求详情。
 *   同时根据停水停气事件的划分也将图层划分为计划性停水、计划性停气、突发性停水、突发性停气图层。
 *   此外，若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示。」
 *
 * ===== 落图单位：打点标识（不是色块）=====
 * 一个 (事件 × 涉及网格) = 一个点。同一事件涉及多个网格时产生多个点，
 * 前端按 `eventId` 关联，点击任一标识 → 其余同 eventId 的标识联动高亮（标书明确要求）。
 *
 * ===== 不造数据 =====
 * 后端没有可打点事件时，本模块返回空 markers + 如实说明，**不伪造任何点位**。
 * 网格中心点由边界图层（gridLayer）的真实/近似面质心推导，推不出来就如实不画。
 *
 * ===== 数据来源（架构约束，与 pipelineLayer.ts 同一套）=====
 * 前端不直连任何地图/业务系统，只调 gqxq 后端；token 取 sessionStorage 的 `gqxq-token`；
 * API base 必须用 `stats/apiBase.ts` 的 `API_BASE`（硬编码 /api/v1 会让面板静默 404）。
 */
import { API_BASE } from '../../../stats/apiBase';

/** 四类图层（标书明确要求 4 个独立图层） */
export type ShutdownCategory = 'planned_water' | 'planned_gas' | 'emergency_water' | 'emergency_gas';

export const SHUTDOWN_CATEGORIES: ShutdownCategory[] = [
  'planned_water',
  'planned_gas',
  'emergency_water',
  'emergency_gas',
];

/**
 * 四类图层配色（与大屏深色底协调）。
 * 计划停水=蓝、计划停气=橙、突发停水深红、突发停气紫 —— 与 task 要求一致。
 */
export const CATEGORY_COLORS: Record<
  ShutdownCategory,
  { fill: string; stroke: string; label: string; short: string }
> = {
  planned_water: { fill: '#3498db', stroke: '#7ec8f0', label: '计划性停水', short: '计划停水' },
  planned_gas: { fill: '#e67e22', stroke: '#f5b25e', label: '计划性停气', short: '计划停气' },
  emergency_water: { fill: '#c0392b', stroke: '#f08070', label: '突发性停水', short: '突发停水' },
  emergency_gas: { fill: '#8e44ad', stroke: '#c39bd3', label: '突发性停气', short: '突发停气' },
};

export const CATEGORY_LABEL: Record<ShutdownCategory, string> = {
  planned_water: '计划性停水',
  planned_gas: '计划性停气',
  emergency_water: '突发性停水',
  emergency_gas: '突发性停气',
};

/** 打点标识 */
export interface ShutdownMarker {
  markerId: string;
  eventId: string;
  category: ShutdownCategory;
  categoryLabel: string;
  gridCode: string;
  gridName: string | null;
  businessType: 'water' | 'gas';
  center: [number, number] | null;
}

export interface ShutdownComplaint {
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
  startTime: string | null;
  endTime: string | null;
  restoredAt: string | null;
  affectedHouseholds: number | null;
  /** 诉求量（缺失为 null，不补 0） */
  complaintCount: number | null;
  complaints: ShutdownComplaint[];
  gridCodes: string[];
  affectedArea: string | null;
  emergencyPlan: string | null;
  housingInfo: string | null;
  sourceApplyNo: string | null;
  sourceFeedId: number | null;
  approvalStatus: string | null;
  ring: number[][] | null;
  coordinateNote: string | null;
  /** 多边形坐标系是否为推定值（true 时显示「推定」角标） */
  coordinateAssumed: boolean;
  status: string | null;
}

export interface ShutdownGridHistoryEntry {
  eventId: string;
  category: ShutdownCategory;
  categoryLabel: string;
  enterpriseName: string | null;
  startTime: string | null;
  endTime: string | null;
  affectedHouseholds: number | null;
}

export interface ShutdownGridHistory {
  gridCode: string;
  gridName: string | null;
  total: number;
  byCategory: Record<ShutdownCategory, number>;
  events: ShutdownGridHistoryEntry[];
}

export interface ShutdownDataBlocker {
  sourceTotal: number;
  locatedCount: number;
  blockedByEnterprise: number;
  blockedByGrid: number;
  blockedByNature: number;
  blockedByBoth: number;
  pendingEnterprises: { name: string; count: number; reason: string }[];
  fixableByEnterpriseFix: number;
  resolvableByGridWhenAssumed: number;
  resolvableBoth: number;
  resolvableBothMultiGrid: number;
  coordinateAssumptionEnabled: boolean;
  coordinateAssumptionNote: string;
  note: string;
}

export interface ShutdownLayerPayload {
  category: string;
  /** 数据来源：snapshot=来源快照直读 / table=主表 */
  dataSource?: 'snapshot' | 'table';
  dataSourceNote?: string | null;
  events: ShutdownEvent[];
  markers: ShutdownMarker[];
  gridHistory: Record<string, ShutdownGridHistory>;
  categoryCounts: Record<ShutdownCategory, number>;
  gridCount: number;
  dataNote: string | null;
  mappingNote: string | null;
  blocker: ShutdownDataBlocker;
}

/** 前端消费结果 */
export interface ShutdownLayerResult {
  events: ShutdownEvent[];
  markers: ShutdownMarker[];
  gridHistory: Record<string, ShutdownGridHistory>;
  categoryCounts: Record<ShutdownCategory, number>;
  gridCount: number;
  dataNote: string | null;
  mappingNote: string | null;
  blocker: ShutdownDataBlocker | null;
  /**
   * 数据来源：snapshot=来源快照直读（未落主表） / table=shutdown_application 主表 / null=请求失败
   * 面板上必须显式展示 —— 不能让人误以为是正式台账数据。
   */
  dataSource: 'snapshot' | 'table' | null;
  dataSourceNote: string | null;
  /** 失败/降级原因（成功为 null） */
  note: string | null;
}

/** 取当前会话 token（大屏真实数据会话存在 sessionStorage 的 gqxq-token） */
function currentToken(): string | null {
  try {
    return sessionStorage.getItem('gqxq-token');
  } catch {
    return null;
  }
}

function emptyResult(note: string | null): ShutdownLayerResult {
  return {
    events: [],
    markers: [],
    gridHistory: {},
    categoryCounts: { planned_water: 0, planned_gas: 0, emergency_water: 0, emergency_gas: 0 },
    gridCount: 0,
    dataNote: null,
    mappingNote: null,
    blocker: null,
    dataSource: null,
    dataSourceNote: null,
    note,
  };
}

/**
 * 拉取停水停气图层数据（一次取全部，四类开关在前端本地过滤）。
 *
 * 失败时返回空结果 + note，渲染层据此显示空态，**不伪造事件/标识**。
 */
export async function fetchShutdownLayer(signal?: AbortSignal): Promise<ShutdownLayerResult> {
  const token = currentToken();
  if (!token) {
    return emptyResult('未登录，无法获取停水停气事件数据');
  }
  try {
    const res = await fetch(`${API_BASE}/assessment/shutdown-layer?category=all`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {
      return emptyResult(`停水停气图层接口 HTTP ${res.status}`);
    }
    const body = (await res.json()) as { code?: number; data?: ShutdownLayerPayload; message?: string };
    if (body.code !== 200 || !body.data) {
      return emptyResult(body.message ?? '停水停气图层接口返回异常');
    }
    const d = body.data;
    // 数据来源必须原样透传到界面（快照直读 vs 主表），不能默认成某一个
    const src = d.dataSource === 'table' ? 'table' : d.dataSource === 'snapshot' ? 'snapshot' : null;
    return {
      events: Array.isArray(d.events) ? d.events : [],
      markers: Array.isArray(d.markers) ? d.markers : [],
      gridHistory: d.gridHistory && typeof d.gridHistory === 'object' ? d.gridHistory : {},
      categoryCounts: d.categoryCounts ?? {
        planned_water: 0,
        planned_gas: 0,
        emergency_water: 0,
        emergency_gas: 0,
      },
      gridCount: Number(d.gridCount ?? 0),
      dataNote: d.dataNote ?? null,
      mappingNote: d.mappingNote ?? null,
      blocker: d.blocker ?? null,
      dataSource: src,
      dataSourceNote: d.dataSourceNote ?? null,
      note: null,
    };
  } catch (e) {
    return emptyResult(`停水停气图层请求失败：${(e as Error)?.message ?? e}`);
  }
}

/* ------------------------------------------------------------------ 展示口径 */

/** 时间范围文案（标书要求字段；缺失如实说「未提供」，不补 0、不留空） */
export function periodText(ev: ShutdownEvent): string {
  const s = ev.startTime;
  const e = ev.endTime;
  if (!s && !e) return '未提供';
  return `${formatShutdownTime(s)} ~ ${formatShutdownTime(e)}`;
}

const shanghaiTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
});

export function formatShutdownTime(iso: string | null): string {
  const timestamp = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(timestamp) ? shanghaiTime.format(timestamp) : '未提供';
}

/** 涉及户数文案（缺失如实说「未提供」，不补 0） */
export function householdsText(ev: ShutdownEvent): string {
  return typeof ev.affectedHouseholds === 'number' && Number.isFinite(ev.affectedHouseholds)
    ? `${ev.affectedHouseholds} 户`
    : '未提供';
}

/** 诉求量文案（缺失如实说「未提供」，不补 0） */
export function complaintCountText(ev: ShutdownEvent): string {
  return typeof ev.complaintCount === 'number' && Number.isFinite(ev.complaintCount)
    ? `${ev.complaintCount} 件`
    : '未提供';
}

/** 该事件是否是「多网格事件」（标书联动高亮场景） */
export function isMultiGrid(ev: ShutdownEvent): boolean {
  return Array.isArray(ev.gridCodes) && ev.gridCodes.length > 1;
}

/** 按 4 类开关过滤标识 */
export function filterMarkersByLayers(
  markers: ShutdownMarker[],
  on: Record<ShutdownCategory, boolean>
): ShutdownMarker[] {
  const out: ShutdownMarker[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const m = markers[i];
    if (m && on[m.category]) out.push(m);
  }
  return out;
}
