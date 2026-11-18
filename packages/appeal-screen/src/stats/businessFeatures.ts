/**
 * 验收大屏 · 底部四个专题按钮的**真实主账接口**（标书 1.2.6/1.2.7/1.2.8/1.2.10/1.2.11）
 *
 * 统一走同源 `/api/v1`（dev 由 vite 代理到 gqxq/server，生产 nginx 反代同一相对路径），
 * 认证沿用大屏现有会话：sessionStorage 的 `gqxq-token`（由登录框 realLogin 写入），
 * 这里只读取、不写入，不改动 `src/stats/**` 的既有数据链路。
 *
 * 接口（已由主线实测，前端不得猜测参数）：
 *   GET  /assessment/admin-grids                             行政网格列表（含名称）
 *   GET  /assessment/grid-comparison?adminGridCodes&dataset&projection&periodKind&from&to
 *   GET  /assessment/seasonal?scene&businessType&year        冬夏研判（year 必传）
 *   GET  /business-alerts                                    已保存预警
 *   POST /business-alerts/evaluate {"day":"YYYY-MM-DD"}      当日核算
 *
 * 口径：只展示后端返回；count=null 一律按「资料不足/无数据」展示，**不补 0**。
 */

const TOKEN_KEY = 'gqxq-token';
const BASE = '/api/v1';

export class FeatureApiError extends Error {
  code: number;
  traceId: string;
  requestId: string;
  constructor(code: number, message: string, requestId = '') {
    super(message);
    this.name = 'FeatureApiError';
    this.code = code;
    this.requestId = requestId;
    this.traceId = requestId;
  }
}

function sessionToken(): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, query?: Record<string, unknown>, body?: unknown): Promise<T> {
  const token = sessionToken();
  if (!token) throw new FeatureApiError(3001, '未登录：专题接口需要先登录真实数据');
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
  let res: Response | null = null;
  let lastErr: unknown = null;
  // 专题接口在首屏 3 份 bootstrap 并发时偶发连接被重置（dev 代理 ECONNRESET / 后端忙），
  // 只对「网络层失败」重试 2 次；HTTP 业务错误不重试（避免重复写）。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (!res) {
    throw new FeatureApiError(
      2002,
      `专题接口不可达：无法连接 ${url}（${lastErr instanceof Error ? lastErr.message : String(lastErr)}）`
    );
  }
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    throw new FeatureApiError(2002, `专题接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || payload?.code !== 200) {
    throw new FeatureApiError(
      res.status === 401 ? 3001 : Number(payload?.code ?? res.status),
      String(payload?.message ?? `请求失败（HTTP ${res.status}）`),
      String(payload?.data?.requestId ?? '')
    );
  }
  return payload.data as T;
}

/* ---------------------------------------------------------------- 类型（与后端契约一致） */

export interface AssessmentGrid {
  code: string;
  name: string;
  version: number;
  hasGeometry: boolean;
}

export interface AssessmentDetail {
  complaintId: string;
  complaintNo: string;
  adminGridCode: string | null;
  businessAt: string | null;
  majorCode: string | null;
  dictionaryVersion: string | null;
}

export interface AssessmentMeta {
  snapshotId?: string;
  timezone?: string;
  timeBasis?: string;
  dataCutoffAt?: string;
  categoryVersions?: string[];
  sourceTimeFallbackCount?: number;
  coverageStatus?: string;
  coverageNote?: string;
  status?: string;
  reason?: string;
}

export interface ComparisonCategory {
  /** major 时是 water_service/gas_service；minor 时是诉求小类 g01…/w01…（标书 1.2.8「诉求类型」口径） */
  code: string;
  dictionaryVersion: string;
  count: number;
  /** 每个网格的件数：键 = 网格编码 */
  counts: Record<string, number>;
  /** 最高值网格编码数组；并列时多个，前端全部高亮 */
  highest: string[];
}

export type CategoryLevel = 'major' | 'minor';

export interface ComparisonResult extends AssessmentMeta {
  totals: Record<string, number>;
  categories: ComparisonCategory[];
  grids: AssessmentGrid[];
  /** 未定位件数：单列，不进入网格对比 */
  unlocatedCount: number;
  /** 本次返回的分类层级（后端默认 minor） */
  categoryLevel?: CategoryLevel;
  partial?: boolean;
  details?: AssessmentDetail[] | null;
}

export interface SeasonalSeasonRow {
  year: number;
  from: string;
  to: string;
  observedTo?: string;
  truncated?: boolean;
  /** null = 无接入记录 / 规则未覆盖，不补 0 */
  count: number | null;
  status: 'observed' | 'insufficient' | 'outside_rule_period' | string;
}

export interface SeasonalMonthRow {
  month: string;
  count: number | null;
  status: string;
}

export interface SeasonalTop6Row {
  code: string;
  name?: string;
  count: number;
  /** null = 上一保障季无记录（资料不足），不得据此算降幅 */
  previousCount: number | null;
}

export interface SeasonalResult extends AssessmentMeta {
  status: 'available' | 'unconfigured' | 'not_started' | string;
  rule?: { ruleId: string; version: number; name: string; definitionBasis: string };
  seasons?: SeasonalSeasonRow[];
  previousMonths?: SeasonalMonthRow[];
  top6?: SeasonalTop6Row[];
  unlocatedCount?: number;
  details?: AssessmentDetail[] | null;
}

/** 预警统计范围（标书 1.2.10「诉求量」为全市口径；旧数据缺省按 city 处理） */
export type AlertScope = 'city' | 'district' | 'enterprise' | 'grid';

export interface BusinessAlertRow {
  alertId: string;
  ruleId: string;
  ruleVersion: number;
  /** 统计范围；缺省=全市（兼容引擎改造前的历史行） */
  scope?: AlertScope;
  from: string;
  to: string;
  enterpriseCode: string | null;
  districtCode: string | null;
  adminGridCode: string | null;
  quantity: number;
  threshold: number;
  state: string;
  createdAt: string;
  scene: string;
  ruleName: string;
  definitionBasis: string;
  complaintIds: string[] | null;
  dataCutoffAt: string;
}

/**
 * 预警处理记录（GET /business-alerts/:id/history）
 * 后端返回 business_alert_action 原始行：action / notes / user_id / created_at（snake_case），
 * 这里统一成 camelCase，避免每个组件各写一套兼容分支。
 */
export interface BusinessAlertHistoryRow {
  /** acknowledge / resolve */
  action: string;
  notes: string;
  /** 处理人（后端 user_id；空表示系统/未记录） */
  userId: string | null;
  createdAt: string | null;
}

export interface EvaluateStatusRow {
  ruleId: string;
  name: string;
  status: 'triggered' | 'below_threshold' | 'insufficient' | string;
  reason: string | null;
  count?: number;
  /** 统计范围（缺省=全市） */
  scope?: AlertScope;
  /** 可判定件数（时间/分类/及范围所需编码齐全）；缺省=旧响应未提供 */
  eligibleCount?: number | null;
  /** 因缺字段无法判定的件数；缺省=旧响应未提供 */
  incompleteCount?: number | null;
}

export interface EvaluateResult {
  created: number;
  statuses: EvaluateStatusRow[];
  /** 未发布规则的场景（如 gas_three_piece 三件套未确认定义时） */
  unconfiguredScenes: string[];
}

/* ---------------------------------------------------------------- 接口函数 */

export function fetchAssessmentGrids(): Promise<AssessmentGrid[]> {
  return request<AssessmentGrid[]>('GET', '/assessment/admin-grids');
}

export interface GridComparisonQuery {
  adminGridCodes: string[];
  from: string;
  to: string;
  /** 分类层级：minor=诉求类型小类（标书 1.2.8 默认）；major=大类兼容口径 */
  categoryLevel?: CategoryLevel;
}

export function fetchGridComparison(q: GridComparisonQuery): Promise<ComparisonResult> {
  return request<ComparisonResult>('GET', '/assessment/grid-comparison', {
    adminGridCodes: q.adminGridCodes.join(','),
    dataset: 'ledger',
    projection: 'current',
    periodKind: 'custom',
    from: q.from,
    to: q.to,
    categoryLevel: q.categoryLevel ?? 'minor',
  });
}

export interface SeasonalQuery {
  scene: 'winter' | 'summer';
  businessType: 'gas' | 'water';
  year: number;
}

export function fetchSeasonal(q: SeasonalQuery): Promise<SeasonalResult> {
  return request<SeasonalResult>('GET', '/assessment/seasonal', {
    scene: q.scene,
    businessType: q.businessType,
    year: q.year,
  });
}

export function fetchBusinessAlerts(): Promise<BusinessAlertRow[]> {
  return request<BusinessAlertRow[]>('GET', '/business-alerts');
}

export function evaluateBusinessAlerts(day: string): Promise<EvaluateResult> {
  return request<EvaluateResult>('POST', '/business-alerts/evaluate', undefined, { day });
}

/**
 * 预警详情里的处理记录（标书 1.2.10「预警信息可查看详细信息」）。
 * 后端契约：GET /business-alerts/:id/history → business_alert_action 行（无权限/不存在时抛 403/404，
 * 由调用方如实展示错误，不伪造记录）。
 */
export async function fetchBusinessAlertHistory(id: string): Promise<BusinessAlertHistoryRow[]> {
  const rows = await request<any[]>('GET', `/business-alerts/${encodeURIComponent(id)}/history`);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    action: String(r?.action ?? ''),
    notes: String(r?.notes ?? ''),
    userId: r?.userId ?? r?.user_id ?? null,
    createdAt: r?.createdAt ?? r?.created_at ?? null,
  }));
}