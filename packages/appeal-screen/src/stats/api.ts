/**
 * 统计大屏 · 接口层（**真实数据源 only**）
 *
 * 2026-11-13 客户要求「诉求切换真实数据，模拟数据都去掉」：
 *  - 本层只走 `src/stats/realSource.ts` 的 gqxq 真实接口（`/api/v1`，相对路径）；
 *  - 不再保留历史数据分支 / 数据源开关 / 强制三态注入；任何请求失败都如实抛错，由面板显示错误态；
 *  - 
 *    
 *
 * 真实接口（详见 realSource.ts）：
 *   POST /api/v1/auth/login
 *   GET  /api/v1/screen/bootstrap?from&to[&businessType][&districtCode]
 *   GET  /api/v1/screen/demands?contextId&page&size
 */
import {
  API_ERRORS,
  type ApiResponse,
  type DemandDynamicData,
  type DemandListData,
  type DrillQuery,
  type ForcedState,
  type OverviewData,
  type ResearchTopData,
  type ScreenFilters,
  type SupplyData,
  type TopTypesData,
  type WarningListData,
} from './types';
import {
  RealApiError,
  fetchBundle,
  mapDemandDynamic,
  mapOverview,
  mapResearch,
  mapSupply,
  mapTopTypes,
  mapWarnings,
  realFetchDemands,
} from './realSource';

/** 真实模式快照号由每个 bootstrap 响应的 contextId 生成并写入 meta；此常量仅兼容调用方类型 */
export const SNAPSHOT_ID = 'REAL';

/** 首屏未拿到 meta 前的占位（真实值以 /screen/bootstrap 返回的 generatedAt/contextId 为准） */
export const SCREEN_BOOTSTRAP = {
  snapshotId: '—',
  dataCutoffTime: '—',
  lastSyncTime: '—',
} as const;

/** 真实接口路径（与 realSource.ts 的 REAL_BASE=/api/v1 对应） */
export const SCREEN_API = {
  overview: '/screen/bootstrap',
  supply: '/screen/bootstrap',
  demandDynamic: '/screen/bootstrap',
  topTypes: '/screen/bootstrap',
  warningList: '/screen/bootstrap',
  research: '/screen/bootstrap',
  demands: '/screen/demands',
  snapshotLatest: '/screen/bootstrap',
} as const;

export const SCREEN_ENDPOINTS = [
  { name: 'bootstrap', method: 'GET', path: SCREEN_API.overview, desc: '一次返回 periods/summary/charts/supply/dynamic/top3/warnings/research/heat/spatial' },
  { name: 'demands', method: 'GET', path: SCREEN_API.demands, desc: '下钻明细（按 contextId 分页）' },
  { name: 'login', method: 'POST', path: '/auth/login', desc: '登录换取 Bearer token（仅存 sessionStorage）' },
] as const;

/** 与后端统一错误包装一致；面板直接展示 code / message / traceId */
export class ScreenApiError extends Error {
  code: number;
  traceId: string;
  httpStatus: number;

  constructor(code: number, message?: string, traceId?: string) {
    const meta = API_ERRORS[code] ?? { http: 500, message: '未知错误' };
    super(message || meta.message);
    this.name = 'ScreenApiError';
    this.code = code;
    this.traceId = traceId || newTraceId();
    this.httpStatus = meta.http;
  }
}

let traceSeq = 0;
function newTraceId(): string {
  traceSeq += 1;
  return `ui-${Date.now().toString(36)}-${traceSeq.toString(36)}`;
}

/**
 * 兼容旧调用方（useStatScreen 会在筛选变化时调用 setForcedState）。
 * 真实数据源不接受前端强制三态，这里保留空实现，避免影响真实请求。
 */
let forcedState: ForcedState = 'normal';
export function setForcedState(state: ForcedState) {
  forcedState = state;
}
export function getForcedState(): ForcedState {
  return forcedState;
}

/**
 * 数据源：固定真实数据（客户「模拟数据都去掉」）。
 * 保留 DataSource 类型与 set/get 函数是为了不破坏既有调用签名；切换能力已移除。
 */
export type DataSource = 'real';
export function setDataSource(_src: DataSource) {
  /* 固定真实数据源，无历史数据开关 */
}
export function getDataSource(): DataSource {
  return 'real';
}

/** 把 realSource 的错误转成 UI 认的 ScreenApiError（保持错误码语义） */
function toScreenError(e: unknown): never {
  if (e instanceof ScreenApiError) throw e;
  const code = (e as RealApiError)?.code ?? 2002;
  const message = e instanceof Error ? e.message : String(e);
  const traceId = (e as RealApiError)?.traceId ?? '';
  throw new ScreenApiError(code, message, traceId);
}

/** 统一的响应包装（traceId 取真实 requestId/contextId） */
function wrap<T>(data: T, traceId = ''): ApiResponse<T> {
  return { code: 0, message: 'ok', traceId, data };
}

export async function fetchOverview(filters: ScreenFilters): Promise<ApiResponse<OverviewData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapOverview(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchSupply(filters: ScreenFilters): Promise<ApiResponse<SupplyData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapSupply(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchDemandDynamic(filters: ScreenFilters): Promise<ApiResponse<DemandDynamicData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapDemandDynamic(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchTopTypes(filters: ScreenFilters): Promise<ApiResponse<TopTypesData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapTopTypes(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchWarningList(filters: ScreenFilters): Promise<ApiResponse<WarningListData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapWarnings(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchResearchTop(filters: ScreenFilters): Promise<ApiResponse<ResearchTopData>> {
  try {
    const bs = await fetchBundle(filters);
    return wrap(mapResearch(bs, filters), bs.all.contextId);
  } catch (e) {
    toScreenError(e);
  }
}

export async function fetchDemands(query: DrillQuery): Promise<ApiResponse<DemandListData>> {
  try {
    const bs = await fetchBundle({
      period: query.period,
      industry: query.industry,
      snapshotId: SNAPSHOT_ID,
      districtCode: query.districtCode ?? null,
    });
    return await realFetchDemands(bs, query);
  } catch (e) {
    toScreenError(e);
  }
}
