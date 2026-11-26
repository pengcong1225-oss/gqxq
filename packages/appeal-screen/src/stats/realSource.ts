/**
 * 统计大屏 · **真实数据源**（接 gqxq 诉求平台真实接口）
 *
 * 真实接口（本地 `gqxq/server`，默认 http://127.0.0.1:3100）：
 *   POST /api/v1/auth/login                 → { code:200, data:{ token } }
 *   GET  /api/v1/screen/bootstrap?from&to[&businessType][&districtCode]
 *                                           → 一次返回 periods/summary/charts/supply/dynamic/top3/
 *                                             warnings/research/heat/spatial/unavailable/contextId
 *   GET  /api/v1/screen/demands?contextId&page&size[&businessType][&districtCode]
 *
 * 设计要点（与 docs/layer-screen/19 §九之二一致）：
 * 1. **一次窗口只打一次接口**：bootstrap 整包返回所有面板，按 (from,to,industry,district) 缓存；
 *    总览需要分行业，因此一次并行 3 个 bootstrap（ALL/GAS/WATER），其余面板复用缓存，不重复请求。
 * 2. **真实缺项一律 null + reason**：真实库当前缺分类映射/企业户数/评价/完成时间/行政网格，
 *    对应面板显示「不可计算：xxx」，绝不补 0（与不可计算语义一致）。
 * 3. **不伪造**：`heat`/`spatial`/`warnings`/`research`/`top3` 真实侧返回 unavailable 时，
 *    面板显示真实原因文案。
 */
import {
  INDUSTRIES,
  na,
  ok,
  type ApiResponse,
  type CommunityRow,
  type Computable,
  type DemandDynamicData,
  type DemandItem,
  type DemandListData,
  type DistrictStat,
  type DrillQuery,
  type DurationBucketEvaluation,
  type DurationBucketRow,
  type DurationStats,
  type EnterpriseRatio,
  type HourPoint,
  type IndustryFilter,
  type IndustryOverview,
  type MetricCard,
  type MonthPoint,
  type MonthSeries,
  type OverviewData,
  type PeriodKey,
  type ResearchItem,
  type ResearchTopData,
  type ScreenFilters,
  type ScreenMeta,
  type SupplyData,
  type TopTypesData,
  type TypeStat,
  type UncomputableReason,
  type WarningListData,
  type WeekdayPoint,
  type WeekdaySeries,
} from './types';

/**
 * 真实数据源自己的错误类型（避免与 api.ts 循环依赖）。
 * api.ts 收到后会转成 ScreenApiError，UI 侧仍按统一错误码语义处理。
 */
import { resolveApiBase } from './apiBase';
import type { AdministrativeHeat } from '../components/Map/map2d/administrativeHeat';

export class RealApiError extends Error {
  code: number;
  traceId: string;
  constructor(code: number, message: string, traceId = '') {
    super(message);
    this.name = 'RealApiError';
    this.code = code;
    this.traceId = traceId;
  }
}

/* ------------------------------------------------------------------ 会话 */

const TOKEN_KEY = 'gqxq-token';
let token: string | null = null;
try {
  token = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

/** 真实数据 API 基址（推导规则见 ./apiBase.ts，全项目唯一实现） */
export const REAL_BASE = resolveApiBase();

export function hasRealSession(): boolean {
  return !!token;
}

/**
 * 仅用于本地评审/截图：把外部已换到的 token 注入会话（`#/accept?source=real&token=...`）。
 * 生产验收屏必须走登录框，不要把 token 放进 URL。
 */
export function seedRealSession(t: string) {
  token = t;
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* 忽略 */
  }
}

export function clearRealSession() {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略：无 storage 环境 */
  }
}

export async function realLogin(username: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${REAL_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new RealApiError(2002, `真实数据服务不可达：无法连接 ${REAL_BASE}/auth/login（${e instanceof Error ? e.message : String(e)}）`, '');
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new RealApiError(
      res.status >= 500 ? 2002 : 2002,
      `真实数据服务不可达：登录接口返回非 JSON（HTTP ${res.status}）`,
      ''
    );
  }
  if (!res.ok || body?.code !== 200 || !body?.data?.token) {
    throw new RealApiError(body?.code ?? res.status, body?.message ?? '登录失败（后端未返回原因）', body?.data?.requestId ?? '');
  }
  token = String(body.data.token);
  try {
    sessionStorage.setItem(TOKEN_KEY, token!);
  } catch {
    /* 忽略 */
  }
}

async function realGet<T>(path: string, qs: URLSearchParams, signal?: AbortSignal): Promise<T> {
  if (!token) throw new RealApiError(3001, '未登录：真实数据需要先登录', '');
  let res: Response;
  try {
    res = await fetch(`${REAL_BASE}${path}?${qs.toString()}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal,
      cache: signal ? 'no-store' : undefined,
    });
  } catch (e) {
    throw new RealApiError(
      2002,
      `真实数据服务不可达：无法连接 ${REAL_BASE}${path}（${e instanceof Error ? e.message : String(e)}）`,
      ''
    );
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new RealApiError(
      2002,
      `真实数据服务不可达：${REAL_BASE}${path} 返回非 JSON（HTTP ${res.status}）`,
      ''
    );
  }
  if (!res.ok || body?.code !== 200) {
    // 401/403 语义化，便于顶部条提示「需要重新登录 / 无权限」
    const code = body?.code ?? res.status;
    const msg = body?.message ?? (res.status >= 500 ? `真实数据服务不可达（HTTP ${res.status}）` : `请求失败（HTTP ${res.status}）`);
    throw new RealApiError(res.status === 401 ? 3001 : code, msg, body?.data?.requestId ?? '');
  }
  return body.data as T;
}

/* ------------------------------------------------------------------ 真实返回结构（只声明用到的字段） */

interface RealPeriod { from: string; to: string; count: number }
interface RealBootstrap {
  mode: string;
  window: { from: string; to: string; timezone: string; timeBasis: string };
  summary: {
    total: number;
    unlocated: number;
    householdRate: { value: number | null; reason?: string };
    satisfaction: { value: number | null; reason?: string };
    duration: { value: number | null; reason?: string };
  };
  quality: Record<string, number>;
  charts: {
    business: { code: string; count: number }[];
    district: { code: string; count: number }[];
    community: { id?: string; code?: string; name?: string | null; count: number; rank?: number }[];
    enterprise: { code: string; count: number }[];
    category: { code: string; count: number }[];
    adminGrid: { code: string; count: number }[];
    trend: { date: string; count: number }[];
    monthly: { date: string; count: number }[];
    /** 周一=1 … 周日=7；按行业拆分（标书 1.2.3） */
    weekly: { weekday: number; label: string; count: number; gas: number; water: number }[];
    /** 0–23 小时；按行业拆分（标书 1.2.3） */
    hourly: { hour: number; count: number; gas: number; water: number }[];
    /** 满意度：satisfaction_code 聚合；分母 rated=满意+基本满意+不满意，noReply/unrated 单列 */
    satisfaction: {
      total: number;
      rated: number;
      satisfied: number;
      satisfiedOnly: number;
      basically: number;
      unsatisfied: number;
      noReply: number;
      unrated: number;
      satisfiedRate: { value: number | null; reason: string | null };
      byIndustry: {
        gas: { total: number; rated: number; satisfied: number; satisfiedOnly: number; basically: number; unsatisfied: number; noReply: number; unrated: number; satisfiedRate: { value: number | null; reason: string | null } };
        water: { total: number; rated: number; satisfied: number; satisfiedOnly: number; basically: number; unsatisfied: number; noReply: number; unrated: number; satisfiedRate: { value: number | null; reason: string | null } };
      };
      sourceNote: string;
    };
    /** 处理时长：缺可核验办结时间，四档件数不可计算（source_synced_at 为同步固定延迟 +3h） */
    duration: {
      value: null;
      reason: string;
      evidence: { minHours: number | null; maxHours: number | null; identicalRatio: number | null };
    };
    /** 类型 × 区县交叉分布（同一 bootstrap 响应内，不新增请求） */
    districtByCategory: Record<string, { code: string; count: number }[]>;
    topTypes: { code: string; count: number }[];
  };
  periods: { yesterday: RealPeriod; month: RealPeriod; quarter: RealPeriod; year: RealPeriod; coverage: string };
  supply: { state: string; reason?: string; data?: any };
  dynamic: { state: string; reason?: string; data?: any };
  top3: { state: string; reason?: string; data?: { items: any[]; from: string; to: string; coverage?: string } };
  warnings: { state: string; reason?: string; data?: { items: any[] } };
  research: { state: string; reason?: string; data?: { seasons: any[] } };
  heat: AdministrativeHeat;
  spatial?: { state: string; reason?: string; data?: { communities?: { id: string; name?: string; gridId?: string; longitude?: number; latitude?: number; coordinateSource?: string }[] } };
  spatial: { state: string; reason?: string; data?: any };
  unavailable: Record<string, string>;
  contextId: string;
  generatedAt: string;
  expiresAt: string;
  periodAnchor?: string;
}

/* ------------------------------------------------------------------ 窗口与缓存 */

const DISTRICTS: Record<string, string> = {
  '420502': '西陵区',
  '420503': '伍家岗区',
  '420504': '点军区',
  '420505': '猇亭区',
  '420506': '夷陵区',
  /** 真实库当前使用 420507 表示高新区（另有 420500 的历史写法，两者都保留映射） */
  '420507': '高新区',
  '420581': '宜都市',
  '420582': '当阳市',
  '420583': '枝江市',
  '420525': '远安县',
  '420526': '兴山县',
  '420527': '秭归县',
  '420528': '长阳县',
  '420529': '五峰县',
  '420500': '高新区',
};

/** 企业名称（enterprise 主数据 12 家；后端 enterpriseRates 只返回 code） */
const ENTERPRISE_NAMES: Record<string, string> = {
  'ENT-GAS-001': '宜昌中燃城市燃气',
  'ENT-GAS-002': '中燃智慧能源',
  'ENT-GAS-003': '夷陵中燃',
  'ENT-GAS-004': '长阳燃气',
  'ENT-GAS-005': '兴山新捷天然气',
  'ENT-LPG-001': '宜昌蓝天气体',
  'ENT-WATER-001': '宜昌市供水总公司',
  'ENT-WATER-002': '点军供水',
  'ENT-WATER-003': '宜昌浦华三峡水务',
  'ENT-WATER-004': '宜昌城发集团',
  'ENT-WATER-005': '长阳清江水务',
  'ENT-WATER-006': '兴山自来水',
};
/** 企业筛选选项（enterprise 主数据 12 家；筛选参数 enterpriseCode） */
export const ENTERPRISE_OPTIONS: { code: string; name: string }[] = Object.entries(ENTERPRISE_NAMES).map(([code, name]) => ({
  code,
  name,
}));

const MISSING ='__missing__';
const MISSING_LABEL = '未映射（后台主数据缺失）';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 统计窗口：以 asOf（默认今天）为锚点，按 period 反推；与统计期间语义一致 */
export function periodWindow(period: PeriodKey, asOf = new Date()): { from: string; to: string } {
  const end = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const start = new Date(end);
  switch (period) {
    case 'today':
      break;
    case '7d':
      start.setDate(end.getDate() - 6);
      break;
    case 'quarter':
      start.setMonth(Math.floor(end.getMonth() / 3) * 3, 1);
      break;
    case 'year':
      start.setMonth(0, 1);
      break;
    case '30d':
    default:
      start.setDate(end.getDate() - 29);
      break;
  }
  return { from: ymd(start), to: ymd(end) };
}

/** 当前真实统计窗口（与界面显示/筛选条默认日期保持一致；锚点可用 ?asOf= 覆盖） */
export function currentRealWindow(period: PeriodKey): { from: string; to: string } {
  return periodWindow(period, anchorDate());
}

/** 真实数据锚点：真实库最新数据在 2026-09；用 ?asOf= 覆盖，保证演示有数 */
let asOfOverride: string | null = null;
export function setRealAsOf(v: string | null) {
  asOfOverride = v;
  bootstrapCache.clear();
}
function anchorDate(): Date {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const d = new Date(`${asOfOverride ?? today}T00:00:00`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

interface Bundle {
  all: RealBootstrap;
  gas: RealBootstrap;
  water: RealBootstrap;
}

const bootstrapCache = new Map<string, Promise<Bundle>>();
/** 最近一次 ALL 维度 bundle（三维小区点位等复用，避免重复拉 bootstrap） */
let lastAllBundle: RealBootstrap | null = null;

function bundleKey(filters: ScreenFilters): string {
  const w = filters.window ?? currentRealWindow(filters.period);
  return [
    w.from,
    w.to,
    filters.gridCode ?? '',
    filters.districtCode ?? '',
    filters.enterpriseCode ?? '',
    filters.communityCode ?? '',
    filters.categoryCode ?? '',
  ].join('|');
}

async function loadOne(
  from: string,
  to: string,
  industry?: 'gas' | 'water',
  district?: string | null,
  extra?: { adminGridCode?: string | null; enterpriseCode?: string | null; communityCode?: string | null; categoryCode?: string | null }
) {
  const qs = new URLSearchParams({ from, to });
  if (industry) qs.set('businessType', industry);
  if (district) qs.set('districtCode', district);
  if (extra?.adminGridCode) qs.set('adminGridCode', extra.adminGridCode);
  if (extra?.enterpriseCode) qs.set('enterpriseCode', extra.enterpriseCode);
  if (extra?.communityCode) qs.set('communityCode', extra.communityCode);
  if (extra?.categoryCode) qs.set('categoryCode', extra.categoryCode);
  return realGet<RealBootstrap>('/screen/bootstrap', qs);
}

/* ---- 筛选选项缓存：首次无筛选 bootstrap 后记住全量选项，避免筛选后下拉只剩当前子集 ---- */
let adminGridOptionCache: { code: string; count: number }[] = [];
let communityOptionCache: { id: string; name: string; gridId?: string }[] = [];

function rememberFilterOptions(bs: RealBootstrap) {
  const grids = (bs.charts.adminGrid ?? []).filter((g) => g.code && g.code !== MISSING);
  const merged = new Map(adminGridOptionCache.map((g) => [g.code, g.count]));
  for (const g of grids) merged.set(g.code, Math.max(merged.get(g.code) ?? 0, g.count));
  adminGridOptionCache = [...merged.entries()].map(([code, count]) => ({ code, count }));
  const communities = bs.spatial?.data?.communities ?? [];
  const cm = new Map(communityOptionCache.map((c) => [c.id, c]));
  for (const c of communities) if (c?.id) cm.set(String(c.id), { id: String(c.id), name: String(c.name ?? c.id), gridId: c.gridId ? String(c.gridId) : undefined });
  communityOptionCache = [...cm.values()];
}

/** 行政网格筛选选项（代码来自 charts.adminGrid；不含 __missing__） */
export function realAdminGridOptions(): { code: string; count: number }[] {
  return [...adminGridOptionCache].sort((a, b) => a.code.localeCompare(b.code));
}

/** 小区筛选选项（代码来自 spatial.communities；最多由调用方截前 200 个） */
export function realCommunityOptions(): { id: string; name: string; gridId?: string }[] {
  return [...communityOptionCache].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 丢弃某组筛选条件下的 bootstrap 缓存。
 *
 * 用途：服务端的查询上下文（contextId）有有效期，过期后 /screen/demands 会 409。
 * 此时必须重新 bootstrap 拿新 contextId —— 但如果只 clear() 整个缓存，
 * 其它筛选条件的缓存也会一起丢（大屏上会看到整屏重新加载）。
 * 所以按 bundleKey 精确失效。
 */
export function invalidateBundleCache(filters: ScreenFilters): void {
  bootstrapCache.delete(bundleKey(filters));
}

/** 一次取齐 ALL/GAS/WATER 三份 bootstrap（同一窗口），所有面板共用 */
export function fetchBundle(filters: ScreenFilters): Promise<Bundle> {
  const key = bundleKey(filters);
  const hit = bootstrapCache.get(key);
  if (hit) return hit;
  const { from, to } = filters.window ?? currentRealWindow(filters.period);
  const district = filters.districtCode ?? null;
  const extra = {
    adminGridCode: filters.gridCode,
    enterpriseCode: filters.enterpriseCode,
    communityCode: filters.communityCode,
    categoryCode: filters.categoryCode,
  };
  const p = Promise.all([
    loadOne(from, to, undefined, district, extra),
    loadOne(from, to, 'gas', district, extra),
    loadOne(from, to, 'water', district, extra),
  ]).then(([all, gas, water]) => { lastAllBundle = all; rememberFilterOptions(all); return { all, gas, water }; })
    .catch((e) => {
      bootstrapCache.delete(key);
      throw e;
    });
  bootstrapCache.set(key, p);
  return p;
}

/** 已缓存的真实小区点位（来自 spatial.communities，含抖动坐标）；无缓存返回空数组 */
export function realCommunityPoints(): { id: string; name: string; longitude: number; latitude: number; gridId?: string }[] {
  const list = lastAllBundle?.spatial?.data?.communities ?? [];
  return list
    .filter((c) => Number.isFinite(Number(c.longitude)) && Number.isFinite(Number(c.latitude)))
    .map((c) => ({ id: String(c.id), name: String(c.name ?? c.id), longitude: Number(c.longitude), latitude: Number(c.latitude), gridId: c.gridId ? String(c.gridId) : undefined }));
}
/* ------------------------------------------------------------------ 通用映射 */

/** charts.community 项可能是 {id} 或 {code}（后端两处实现不一致），统一取键 */
const communityKey = (c: { id?: string; code?: string }) => String(c?.id ?? c?.code ?? '');
/** 小区元信息（名称/所属网格），来自后端 spatial.communities */
function communityMeta(bs: Bundle): Map<string, { name?: string; gridId?: string }> {
  const m = new Map<string, { name?: string; gridId?: string }>();
  for (const cm of bs.all.spatial?.data?.communities ?? []) {
    if (cm?.id) m.set(String(cm.id), { name: cm.name, gridId: cm.gridId });
  }
  return m;
}

/** 诉求问题类型（dict_item.complaint_category，19 项；与后台字典同源，改动需同步） */
const CATEGORY_LABELS: Record<string, string> = {
  g01: '燃气服务问题', g02: '燃气费用问题', g03: '燃气施工问题', g04: '燃气报装点火',
  g05: '燃气报损报修', g06: '停气问题', g07: '燃气业务查询', g08: '燃气气压问题',
  g09: '燃气捆绑销售（停用）',
  w01: '城镇停水', w02: '用水费用问题', w03: '水质问题', w04: '水压问题',
  w05: '城镇用水问题', w06: '用水服务问题', w07: '供水施工挖断', w08: '用水报损报修',
  gas_service: '供气服务（大类）', water_service: '供水服务（大类）',
};
const catLabel = (code: string) => (code === MISSING ? '未映射分类' : CATEGORY_LABELS[code] ?? code);

/** 分类筛选选项（CATEGORY_LABELS 的小类；排除 g09 停用项与 major 大类） */
export const CATEGORY_OPTIONS: { code: string; name: string }[] = Object.entries(CATEGORY_LABELS)
  .filter(([code]) => !code.endsWith('_service') && code !== 'g09')
  .map(([code, name]) => ({ code, name }));
function buildMeta(bs: RealBootstrap, filters: ScreenFilters): ScreenMeta {
  const catMissingAll = !bs.charts.category.length || bs.charts.category.every((c) => c.code === MISSING);
  const catUnmapped = bs.charts.category.filter((c) => c.code === MISSING).reduce((s, c) => s + c.count, 0);
  const entMissingAll = !bs.charts.enterprise.length || bs.charts.enterprise.every((e) => e.code === MISSING);
  const communityMissingAll = !bs.charts.community.some((c) => { const k = communityKey(c); return !!k && k !== MISSING; });
  /** 未定位：优先用区域图里的 __missing__（与区域合计自洽）；没有区域明细时退回 summary.unlocated */
  const districtMissing = (bs.charts.district ?? []).filter((d) => d.code === MISSING).reduce((s, d) => s + d.count, 0);
  const unlocated = districtMissing > 0 ? districtMissing : bs.summary.unlocated;
  const notes: string[] = [];
  if (catMissingAll) notes.push('分类映射未配置：真实库缺「诉求类型→标准分类」对照');
  else if (catUnmapped > 0) notes.push(`分类未映射 ${catUnmapped} 件`);
  if (entMissingAll) notes.push('企业服务户数未维护：缺跨期有效户数及分母口径，企业每万户不可计算');
  if (communityMissingAll) notes.push('小区/网格主数据未配置：缺「小区→行政网格」对照，高频小区不可排名');
  if (bs.heat?.reason) notes.push(`网格热力：${bs.heat.reason}`);
  if (unlocated > 0) notes.push(`未定位 ${unlocated} 件（单列，不参与六区着色）`);
  return {
    snapshotId: `REAL-${bs.contextId.slice(0, 8)}`,
    dataCutoffTime: bs.generatedAt,
    lastSyncTime: bs.generatedAt,
    spatialVer: bs.heat?.state === 'available' ? 'READY' : '未核验',
    heatRuleVer: bs.heat?.data?.ruleVersion ?? '未发布',
    categoryVer: catMissingAll ? '未配置' : '真实',
    unlocatedCount: unlocated,
    missingEvaluationCount: 0,
    missingEnterpriseDenominatorCount: entMissingAll ? (bs.charts.enterprise?.length ?? 0) : 0,
    missingNote: notes.length ? `真实数据：${notes.join('；')}` : null,
  };
}

const distName = (code: string) => (code === MISSING ? MISSING_LABEL : DISTRICTS[code] ?? `${code}（区划名未配置）`);

/** 月度序列：真实返回按月计数（count 为 0 的月不返回），未出现在结果里的月按「无数据」处理 */
function toMonthSeries(rows: { date: string; count: number }[], from: string, to: string): MonthSeries {
  if (!rows.length) {
    return { points: [], reason: 'NO_SAMPLE', note: '该窗口无月度数据' };
  }
  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.date.slice(0, 7), r.count));
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const points: MonthPoint[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${pad(m)}`;
      if (key < from.slice(0, 7) || key > to.slice(0, 7)) continue;
      const v = map.get(key);
      points.push({
        month: m,
        label: points.length === 0 || m === 1 ? `${m}月` : `${m}月`,
        value: v ?? null,
        partial: key === to.slice(0, 7),
      });
    }
  }
  return { points, reason: null, note: `真实按月计数（来源受理时间）；未返回的月表示该月无工单，不是 0` };
}

function metricCard(key: MetricCard['key'], label: string, value: number | null, caption: string, deltaNa = true): MetricCard {
  return {
    key,
    label,
    caption,
    value: value === null ? na('NO_SAMPLE') : ok(value),
    // 环比：真实接口暂无基期，明确不可计算，不编造
    delta: deltaNa ? na('HISTORY_MISSING') : na('HISTORY_MISSING'),
    deltaCaption: '环比：真实接口暂无基期口径',
  };
}

function industryOverview(bs: RealBootstrap, code: 'GAS' | 'WATER'): IndustryOverview {
  const p = bs.periods;
  return {
    industry: code,
    name: INDUSTRIES[code].name,
    color: INDUSTRIES[code].color,
    metrics: [
      metricCard('year', '年度总量', p?.year?.count ?? null, `${p?.year?.from ?? ''} ~ ${p?.year?.to ?? ''}`),
      metricCard('quarter', '本季度总量', p?.quarter?.count ?? null, `${p?.quarter?.from ?? ''} ~ ${p?.quarter?.to ?? ''}`),
      metricCard('month', '本月总量', p?.month?.count ?? null, `${p?.month?.from ?? ''} ~ ${p?.month?.to ?? ''}`),
      metricCard('yesterday', '昨日诉求量', p?.yesterday?.count ?? null, p?.yesterday?.from ?? ''),
    ],
  };
}

/* ------------------------------------------------------------------ 六个面板映射 */

/** 按行业口径从三份 bundle 里选出对应的那一份（ALL / GAS / WATER） */
export function pickIndustryBundle(bs: Bundle, industry: unknown): RealBootstrap {
  if (industry === 'GAS') return bs.gas;
  if (industry === 'WATER') return bs.water;
  return bs.all;
}

export function mapOverview(bs: Bundle, filters: ScreenFilters): OverviewData {
  /*
   * 必须按 filters.industry 选 bundle，不能用 bs.all。
   *
   * 历史 bug：这里原来写死 bs.all —— 无论切到「供气服务」还是「供水服务」，
   * 诉求总览的合计/年度/季度/月度全是「全部行业」的数字，客户看到的就是
   * 「切 tab 只有部分内容变，总览和地图纹丝不动」。
   * 实测同一窗口：全部 844 件 / 供气 583 件 / 供水 261 件。
   */
  const picked = pickIndustryBundle(bs, filters.industry);
  const meta = buildMeta(picked, filters);
  const s = picked.summary;
  return {
    meta,
    summary: {
      total: ok(s.total),
      // 真实库无来源完成时间 → 办结率不可计算
      finishRate: na('NO_SAMPLE'),
      satisfactionRate: s.satisfaction?.value === null || s.satisfaction?.value === undefined
        ? na('NO_SAMPLE')
        : ok(s.satisfaction.value),
      unlocated: meta.unlocatedCount,
      finishedCount: 0,
    },
    industries: [industryOverview(bs.gas, 'GAS'), industryOverview(bs.water, 'WATER')],
  };
}

export function mapSupply(bs: Bundle, filters: ScreenFilters): SupplyData {
  const b = filters.industry === 'ALL' ? bs.all : filters.industry === 'GAS' ? bs.gas : bs.water;
  const meta = buildMeta(b, filters);
  const total = b.summary.total;

  const typeStats: TypeStat[] = b.charts.category
    .filter((c) => c.code !== MISSING)
    .map((c) => ({ typeId: c.code, name: catLabel(c.code), count: c.count, share: total ? +((c.count / total) * 100).toFixed(1) : 0 }));

  // 标书 1.2.2：企业万户诉求占比 = 诉求量 ÷ 后台维护的企业服务户数 × 10000
  // 后端 supply.data.enterpriseRates 已按 enterprise_household_version（后台维护的户数与有效期）算好 per10k
  const rates: any[] = Array.isArray(b.supply?.data?.enterpriseRates) ? b.supply.data.enterpriseRates : [];
  const enterpriseRatio: EnterpriseRatio[] = rates
    .filter((r) => r && r.id)
    .map((r) => {
      const households = typeof r.households === 'number' && r.households > 0 ? r.households : null;
      const per10k = typeof r.per10k === 'number' ? r.per10k : null;
      const computable = households !== null && per10k !== null && !r.reason;
      return {
        enterpriseId: String(r.id),
        // 标书 1.1.8：大屏显示企业名由后台「企业管理」维护（display_on_screen/screen_name），后端已下发；
        // 本地 ENTERPRISE_NAMES 仅在后台未配置时兜底，避免把硬编码当作业务配置。
        name: r.name ?? ENTERPRISE_NAMES[String(r.id)] ?? String(r.id),
        industry: filters.industry === 'ALL' ? 'WATER' : (filters.industry as 'WATER' | 'GAS'),
        demandCount: Number(r.count ?? 0),
        households,
        ratio: computable
          ? { value: +per10k!.toFixed(2) }
          : households === null
            ? na('MISSING_HOUSEHOLDS')
            : na('ZERO_BASE'),
        reasonText: typeof r.reason === 'string' ? r.reason : undefined,
        denominatorDate: r.at ? String(r.at) : r.version ? `维护版本 ${r.version}` : '—',
      } as EnterpriseRatio;
    })
    .sort((a, b2) => Number(b2.ratio.value ?? -1) - Number(a.ratio.value ?? -1));

  const districtRows = b.charts.district.filter((d) => d.code !== MISSING);
  const unlocated = b.charts.district.filter((d) => d.code === MISSING).reduce((s, d) => s + d.count, 0);
  const districtSum = districtRows.reduce((s, d) => s + d.count, 0);
  const items: DistrictStat[] = districtRows
    .map((d) => ({
      districtCode: d.code,
      name: distName(d.code),
      count: d.count,
      share: districtSum ? +((d.count / districtSum) * 100).toFixed(1) : 0,
    }))
    .sort((x, y) => y.count - x.count);

  /** 类型 × 区县：供「区域分布按当前选中类型过滤」使用（同一响应，不新增请求） */
  const districtByType: Record<string, { items: DistrictStat[]; unlocated: number }> = {};
  for (const [categoryCode, rows] of Object.entries(b.charts.districtByCategory ?? {})) {
    const locRows = rows.filter((d) => d.code !== MISSING);
    const catSum = locRows.reduce((s, d) => s + d.count, 0);
    districtByType[categoryCode] = {
      items: locRows
        .map((d) => ({
          districtCode: d.code,
          name: distName(d.code),
          count: d.count,
          share: catSum ? +((d.count / catSum) * 100).toFixed(1) : 0,
        }))
        .sort((x, y) => y.count - x.count),
      unlocated: rows.filter((d) => d.code === MISSING).reduce((s, d) => s + d.count, 0),
    };
  }

  // 小区名称/所属网格取后端 spatial.communities（含抖动坐标与名称），缺失才回退编码
    const commMeta = communityMeta(bs);
  const communityItems: CommunityRow[] = b.charts.community
    .filter((c) => { const k = communityKey(c); return !!k && k !== MISSING; })
    .slice(0, 10)
    .map((c, i) => {
      const code = communityKey(c);
      return {
      rank: i + 1,
      /** 小区编码（C-xxxxxxxx-xxxx）：点击后按该编码过滤明细（标书 1.2.2 ④） */
      communityCode: code,
      communityName: c.name ?? commMeta.get(code)?.name ?? code,
      gridName: commMeta.get(code)?.gridId ?? '未映射（缺行政网格主数据）',
      districtName: '—',
      count: c.count,
      // 真实库未提供有效评价/满意率口径：不补 0，显式不可计算
      satisfactionRate: na('NO_SAMPLE'),
      };
    });

  return {
    meta,
    industry: filters.industry,
    period: filters.period,
    total: ok(total),
    typeStats,
    enterpriseRatio,
    denominatorDate: (rates.find((r) => r?.at)?.at as string | undefined) ?? (rates.find((r) => r?.version)?.version ? `维护版本 ${rates.find((r) => r?.version)?.version} ` : '—'),
    monthly: toMonthSeries(b.charts.monthly, b.window.from, b.window.to),
    district: { items, unlocated },
    districtByType,
    communityTop: { captured: communityItems.length, items: communityItems },
  };
}

export function mapDemandDynamic(bs: Bundle, filters: ScreenFilters): DemandDynamicData {
  const b = filters.industry === 'ALL' ? bs.all : filters.industry === 'GAS' ? bs.gas : bs.water;
  const meta = buildMeta(b, filters);
  const dyn = b.dynamic?.data;

  const naReason = (): UncomputableReason => 'NO_SAMPLE';

  /** 标书 1.2.3：处理时长不可计算（source_synced_at 是同步管道固定延迟 +3h，不是办结时间） */
  const durationRaw = b.charts.duration as
    | {
        value?: {
          buckets?: { label: string; count: number; evaluation?: DurationBucketEvaluation | null }[];
          covered?: number;
          coverage?: number;
          total?: number;
          overtime?: number;
          overtimeRate?: number;
        } | null;
        reason?: string | null;
        evidence?: DurationStats['evidence'];
      }
    | null
    | undefined;
  const durationValue = durationRaw?.value && (durationRaw.value.covered ?? 0) > 0
    ? {
        buckets: durationRaw.value.buckets ?? [],
        covered: durationRaw.value.covered ?? 0,
        coverage: durationRaw.value.coverage ?? 0,
        total: durationRaw.value.total ?? 0,
        overtime: durationRaw.value.overtime ?? 0,
        overtimeRate: durationRaw.value.overtimeRate ?? 0,
      }
    : null;
  const durationStats: DurationStats = {
    value: durationValue,
    reason: durationValue ? null : (durationRaw?.reason ?? '缺可核验的办结时间，不能作为处理时长'),
    evidence: durationValue ? null : (durationRaw?.evidence ?? null),
  };
  /** 四档（仅在 value 存在时有值；无则空数组，不画 0）
   *  每档 evaluation 原样透传（DurationBucketsCard 的「每档满意度/不满意%」用它）；
   *  同时给 DurationTable 需要的 demandCount 与 satisfiedRate/dissatisfiedRate（分母=该档有效评价 rated）。 */
  const bucketKeys: DurationBucketRow['bucket'][] = ['[0,24]', '(24,48]', '(48,72]', '>72'];
  const durationBuckets: DurationBucketRow[] = durationValue
    ? durationValue.buckets.map((x, i) => {
        const ev = x.evaluation ?? null;
        const rated = typeof ev?.evaluatedCount === 'number' ? ev.evaluatedCount : 0;
        const satisfiedRate: Computable<number> =
          ev && rated > 0 && typeof ev.percent === 'number'
            ? ok(+(ev.percent * 100).toFixed(1))
            : na<number>('NO_SAMPLE');
        const dissatisfiedRate: Computable<number> =
          ev && rated > 0 && typeof ev.unsatisfiedCount === 'number'
            ? ok(+((ev.unsatisfiedCount / rated) * 100).toFixed(1))
            : na<number>('NO_SAMPLE');
        return {
          bucket: bucketKeys[i] ?? bucketKeys[0],
          label: x.label,
          demandCount: x.count,
          satisfiedRate,
          dissatisfiedRate,
          evaluation: ev,
        };
      })
    : [];

  /** 标书 1.2.3：24 小时双行业桶 */
  const hourlySplit = (b.charts.hourly ?? []).map((h) => ({
    hour: h.hour,
    label: `${pad(h.hour)}:00`,
    count: h.count,
    gas: h.gas ?? 0,
    water: h.water ?? 0,
  }));
  const peakHours: HourPoint[] = hourlySplit.map((h) => ({
    hour: h.hour,
    label: h.label,
    count: h.count,
    gas: h.gas,
    water: h.water,
  }));

  const monthlyTotal = toMonthSeries(b.charts.monthly, b.window.from, b.window.to);

  /** 标书 1.2.3：周一~周日双行业桶 */
  const weekdaySplit = (b.charts.weekly ?? []).map((x) => ({
    weekday: x.weekday,
    label: x.label,
    count: x.count,
    gas: x.gas ?? 0,
    water: x.water ?? 0,
  }));
  const weekdayMap = new Map<number, number>();
  for (const row of weekdaySplit) {
    /**
     * 后端 `charts.weekly[].weekday` 口径：**周一=1 … 周日=7**（已对运行中接口实测确认）。
     *
     * 旧实现是 `row.weekday % 7` + `labels = ['周日','周一',…,'周六']`。
     * **实测旧实现的结果其实是对的**（7 % 7 = 0 恰好落回「周日」那格），不存在错位。
     *
     * 之所以仍然改写，是因为它对**两种口径都只是碰巧成立**：
     *   · 后端若改回 0=周日…6=周六，旧代码同样“看起来”能跑，但语义完全变了；
     *   · 反过来若有人按注释把数据改成 0-6，旧代码会整体平移一格，且不报错、极难发现。
     * 现在显式归一为「周一=0 … 周日=6」的内部索引，并兼容 0..6 输入，
     * 让口径写死在一处、可读、可测，不再依赖巧合。
     */
    const raw = Number(row.weekday);
    let idx: number;
    if (raw >= 1 && raw <= 7) {
      idx = raw - 1; // 周一=1 → 0；周日=7 → 6
    } else if (raw >= 0 && raw <= 6) {
      idx = raw; // 已是 0-6 口径
    } else {
      continue;
    }
    weekdayMap.set(idx, (weekdayMap.get(idx) ?? 0) + row.count);
  }
  // 周一在前的展示顺序（标书 1.2.3 的「周变化」按自然工作周读更顺；周日在末）
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekdayPoints: WeekdayPoint[] = labels.map((label, i) => ({
    weekday: i,
    label,
    value: weekdayMap.get(i) ?? null,
  }));
  const weekday: WeekdaySeries = {
    points: weekdayPoints,
    reason: weekdayMap.size ? null : 'NO_SAMPLE',
    coverage: { covered: weekdayMap.size, need: 7 },
  };

  /** 标书 1.2.3：满意度（真实 satisfaction_code；分母只含有效评价 rated） */
  const satRaw = b.charts.satisfaction;
  const mapSat = (s: any) => ({
    total: Number(s?.total ?? 0),
    rated: Number(s?.rated ?? 0),
    satisfied: Number(s?.satisfied ?? 0),
    satisfiedOnly: Number(s?.satisfiedOnly ?? 0),
    basically: Number(s?.basically ?? 0),
    unsatisfied: Number(s?.unsatisfied ?? 0),
    noReply: Number(s?.noReply ?? 0),
    unrated: Number(s?.unrated ?? 0),
    satisfiedRate:
      s?.satisfiedRate?.value === null || s?.satisfiedRate?.value === undefined
        ? na('NO_SAMPLE')
        : ok(Number(s.satisfiedRate.value)),
  });
  const satisfactionStats = {
    ...mapSat(satRaw),
    byIndustry: {
      gas: mapSat(satRaw?.byIndustry?.gas),
      water: mapSat(satRaw?.byIndustry?.water),
    },
    sourceNote: String(satRaw?.sourceNote ?? ''),
  };

  return {
    meta,
    period: filters.period,
    industry: filters.industry,
    total: ok(b.summary.total),
    satisfaction: {
      satisfied: satisfactionStats.satisfiedOnly,
      dissatisfied: satisfactionStats.unsatisfied,
      unevaluated: satisfactionStats.noReply + satisfactionStats.unrated,
      satisfiedRate: satisfactionStats.satisfiedRate,
      items: [],
    },
    dissatisfaction: [],
    durationBuckets,
    peakHours,
    monthlyTotal,
    weekday,
    satisfactionStats,
    hourlySplit,
    weekdaySplit,
    durationStats,
  };
}

/**** 标书 1.2.9：往年同期 TOP3 跑马灯 ****
 * 后端 top3.data.items 已按诉求类型（小类）聚合前 3（code = minor_category_code，回退 major），
 * 这里只负责 code → 中文类型名（CATEGORY_LABELS）与展示字段，不再丢弃 items。
 * items 只在有可识别编码时返回；无 items 才显示不可用原因（保留参考期与覆盖说明）。
 */
export function mapTopTypes(bs: Bundle, filters: ScreenFilters): TopTypesData {
  const b = pickIndustryBundle(bs, filters.industry);
  const meta = buildMeta(b, filters);
  const refFrom = b.top3?.data?.from ?? '—';
  const refTo = b.top3?.data?.to ?? '—';
  const coverage = b.top3?.data?.coverage;
  const rawItems = Array.isArray(b.top3?.data?.items) ? b.top3.data.items : [];
  /** 只认有编码、件数为正的前 3 项；__missing__/0 不占 TOP3 名额（与后端排序口径一致） */
  const valid = rawItems
    .filter((it) => it && typeof it.code === 'string' && it.code && it.code !== MISSING && Number.isFinite(Number(it.count)) && Number(it.count) > 0)
    .slice(0, 3);
  const topTotal = valid.reduce((sum, it) => sum + Number(it.count), 0);

  const items: ResearchItem[] = valid.map((it, i) => {
    const count = Number(it.count);
    const hintParts = [
      `往年同期（${refFrom} ~ ${refTo}）按诉求类型（小类）计数，按件数取前 3`,
      `占比分母 = TOP3 合计 ${topTotal} 件（历史覆盖未知，不能当作全量占比）`,
    ];
    if (coverage) hintParts.push(`覆盖：${coverage}`);
    if (b.top3?.reason) hintParts.push(`后端说明：${b.top3.reason}`);
    return {
      rank: i + 1,
      typeId: it.code,
      ...(typeof it.evidenceKey === 'string' ? { evidence: { contextId: b.contextId, key: it.evidenceKey } } : {}),
      title: `${catLabel(it.code)} · 往年同期（${refFrom} ~ ${refTo}）`,
      typeName: catLabel(it.code),
      count,
      share: topTotal ? +((count / topTotal) * 100).toFixed(1) : 0,
      hint: hintParts.join('；'),
      relatedEventNo: null,
      severity: i === 0 ? 'HIGH' : i === 1 ? 'MID' : 'LOW',
    };
  });

  const emptyReason = items.length
    ? null
    : b.top3?.reason
      ? `往年同期 Top3 不可用：${b.top3.reason}（参考期 ${refFrom} ~ ${refTo}${coverage ? `；覆盖：${coverage}` : ''}）`
      : `往年同期无数据（参考期 ${refFrom} ~ ${refTo}）`;

  return { meta, period: filters.period, industry: filters.industry, items, coverage, emptyReason };
}

export function mapWarnings(bs: Bundle, filters: ScreenFilters): WarningListData {
  const meta = buildMeta(bs.all, filters);
  return { meta, items: [] };
}

export function mapResearch(bs: Bundle, filters: ScreenFilters): ResearchTopData {
  const meta = buildMeta(bs.all, filters);
  return {
    meta,
    period: filters.period,
    industry: filters.industry,
    items: [],
    emptyReason: bs.all.research?.reason ? `冬夏研判不可用：${bs.all.research.reason}` : '冬夏研判无数据',
  };
}

/* ------------------------------------------------------------------ 下钻明细 */

export interface ShutdownStatsSnapshot {
  contextId: string;
  expiresAt: string;
  from: string;
  to: string;
}

export interface ShutdownDemandEvidence {
  id: string;
  complaintNo: string | null;
  type: string;
  occurredAt: string;
  gridId: string;
}

interface ShutdownMapEvidence {
  contextId: string;
  event: { id: string; kind: 'shutdown'; layerVersion: string };
  relatedDemands: { items: ShutdownDemandEvidence[]; total: number | null; reason: string };
}

export interface RealComplaintDetail {
  complaintId: string;
  complaintNo: string;
  title: string;
  content: string | null;
  businessTypeName: string;
  complaintTypeName: string;
  sourceEventStatusName: string;
  enterpriseName: string | null;
}

export type ShutdownComplaintDetail = RealComplaintDetail;

export async function realFetchShutdownEvidence(
  eventId: string, layerVersion: string, snapshot: ShutdownStatsSnapshot, signal: AbortSignal,
) {
  const data = await realGet<ShutdownMapEvidence>(
    `/screen/events/${encodeURIComponent(eventId)}`,
    new URLSearchParams({ contextId: snapshot.contextId, layerVersion }), signal,
  );
  if (data.contextId !== snapshot.contextId || data.event?.id !== eventId ||
      data.event.kind !== 'shutdown' || data.event.layerVersion !== layerVersion) {
    throw new RealApiError(409, '图层事件与统计快照不一致，请刷新');
  }
  return data.relatedDemands;
}

export async function realFetchComplaintDetail(row: Pick<ShutdownDemandEvidence, 'id' | 'complaintNo'>, signal: AbortSignal) {
  // 既有详情接口将纯数字路径按数值主键解释。纯数字工单号用证据行的业务主键定位。
  const key = row.complaintNo && !/^\d+$/.test(row.complaintNo) ? row.complaintNo : row.id;
  const complaint = await realGet<RealComplaintDetail>(`/complaints/${encodeURIComponent(key)}`, new URLSearchParams(), signal);
  if (complaint.complaintId !== row.id || (row.complaintNo && complaint.complaintNo !== row.complaintNo)) {
    throw new RealApiError(409, '工单记录已变化，请刷新统计后核对');
  }
  return complaint;
}

export const realFetchShutdownComplaint = realFetchComplaintDetail;

export interface PipelineComplaintClues {
  projectId: string;
  gridCode: string;
  page: number;
  size: number;
  state: 'available' | 'unavailable';
  reason: string;
  window: { from: string; to: string } | null;
  total: number | null;
  items: (ShutdownDemandEvidence & { title: string })[];
}

export async function realFetchPipelineClues(
  projectId: string, gridCode: string, page: number, revision: string | null | undefined, signal: AbortSignal,
) {
  const query = new URLSearchParams({ gridCode, page: String(page) });
  if (revision) query.set('sourceRevision', revision);
  const data = await realGet<PipelineComplaintClues>(
    `/assessment/pipeline-layer/projects/${encodeURIComponent(projectId)}/complaints`, query, signal,
  );
  if (data.projectId !== projectId || data.gridCode !== gridCode || data.page !== page) {
    throw new RealApiError(409, '改造项目或网格已变化，请重新选择色块');
  }
  return data;
}

interface RealDemands {
  contextId: string;
  window?: { from: string; to: string } | null;
  page: number;
  size: number;
  total: number;
  items: {
    id: string;
    businessType: string;
    districtCode: string;
    enterpriseCode: string;
    adminGridCode: string | null;
    communityCode: string | null;
    categoryCode: string;
    title: string;
    status: string;
    occurredDay: string;
  }[];
}

export async function realFetchDemands(
  bs: Bundle,
  query: DrillQuery
): Promise<ApiResponse<DemandListData>> {
  const picked = pickIndustryBundle(bs, query.industry);
  const qs = new URLSearchParams({
    contextId: query.evidence?.contextId ?? picked.contextId,
    page: String(query.page ?? 1),
    size: String(query.pageSize ?? 8),
  });
  if (query.metricKey) qs.set('metricKey', String(query.metricKey));
  if (query.typeId) qs.set('categoryCode', String(query.typeId));
  if (query.districtCode) qs.set('districtCode', query.districtCode);
  if (query.gridCode) qs.set(query.formalHeatGrid ? 'heatGridCode' : 'adminGridCode', String(query.gridCode));
  // 标书 1.2.2 ④：高频小区点击传小区编码（C-xxxxxxxx-xxxx）按小区过滤；
  // 中文小区名不是后端可识别条件（传了会 400），只在旧调用方传 C- 编码时兼容。
  if (query.communityCode) qs.set('communityCode', String(query.communityCode));
  else if (query.communityName && /^C-/.test(query.communityName)) qs.set('communityCode', query.communityName);
  if (query.enterpriseId) qs.set('enterpriseCode', String(query.enterpriseId));
  // 月度趋势点击：后端白名单只有 from/to，用它表达「某月」
  if (query.month) {
    const year = Number(String(picked.window?.to ?? '').slice(0, 4)) || new Date().getFullYear();
    const m = String(query.month).padStart(2, '0');
    const last = new Date(Date.UTC(year, query.month, 0)).getUTCDate();
    qs.set('from', `${year}-${m}-01`);
    qs.set('to', `${year}-${m}-${String(last).padStart(2, '0')}`);
  }

  const data = query.evidence
    ? await realGet<RealDemands>('/screen/evidence', new URLSearchParams({
        contextId: query.evidence.contextId, evidenceKey: query.evidence.key,
        page: String(query.page ?? 1), size: String(query.pageSize ?? 8),
      }))
    : await realGet<RealDemands>('/screen/demands', qs);
  const commMeta = communityMeta(bs);
  const items: DemandItem[] = data.items.map((it) => ({
    caseNo: it.id,
    industry: it.businessType === 'gas' ? 'GAS' : 'WATER',
    typeName: catLabel(it.categoryCode),
    communityName: !it.communityCode ? '—' : it.communityCode === MISSING ? '未映射小区' : (commMeta.get(it.communityCode)?.name ?? it.communityCode),
    gridName: !it.adminGridCode ? '—' : it.adminGridCode === MISSING ? '未映射网格' : it.adminGridCode,
    intakeTime: it.occurredDay,
    status: it.status === 'completed' ? '已办结' : it.status === 'pending' ? '处理中' : '待核验',
    relatedEvent: false,
    eventNo: null,
    satisfaction: '未评价',
  }));

  const meta = buildMeta(picked, {
    period: query.period,
    industry: query.industry,
    snapshotId: '',
  });

  return {
    code: 0,
    message: 'ok',
    traceId: data.contextId ?? picked.contextId,
    data: {
      meta,
      condition: query,
      page: data.page,
      pageSize: data.size,
      total: data.total,
      items,
      ...(query.evidence && data.window ? { evidenceWindow: data.window } : {}),
    },
  };
}

















