/**
 * 统计大屏 · 数据契约（与 docs/layer-screen/06-数据模型与接口契约.md 同构）
 *
 * 约定：
 * - 所有面板数据都来自统一响应包装 `ApiResponse<T>`：{ code, message, traceId, data }
 * - 所有响应体都携带 `meta` 块，大屏顶部直接展示（快照号/截止时间/未定位/缺项提示）
 * - 可计算数值一律用 `Computable<T>`：算不出来时是 `null + reason`，UI 显示「不可计算：xxx」，**禁止用 0 冒充**
 */

/* ---------------------------------------------------------------- 统一响应 */

export interface ApiResponse<T> {
  code: number;
  message: string;
  traceId: string;
  data: T;
}

/** §5 错误码（只列大屏会用到的） */
export const API_ERRORS: Record<number, { http: number; message: string }> = {
  0: { http: 200, message: 'ok' },
  1001: { http: 400, message: '参数缺失或非法' },
  1002: { http: 400, message: '网格对比数量不合法（需 2~3 个）' },
  1003: { http: 404, message: '快照不存在或未 READY' },
  1004: { http: 409, message: '空间版本不匹配' },
  2001: { http: 503, message: '空间资源缺项（如管线几何未接入）' },
  2002: { http: 503, message: '外部地图服务不可用' },
  3001: { http: 403, message: '无该辖区/图层权限' },
};

/* ---------------------------------------------------------------- 顶部 meta */

export interface ScreenMeta {
  snapshotId: string;
  /** 数据截止时间，取快照时间，不是浏览器当前时间 */
  dataCutoffTime: string;
  /** 最后一次成功同步时间 */
  lastSyncTime: string;
  spatialVer: string;
  heatRuleVer: string;
  categoryVer: string;
  /** 未定位件数（不参与六区着色，单独计数） */
  unlocatedCount: number;
  /** 缺评价件数 */
  missingEvaluationCount: number;
  /** 缺企业服务户数的企业数（万户占比不可计算来源） */
  missingEnterpriseDenominatorCount: number;
  /** 数据缺项/口径提示，null 表示无 */
  missingNote: string | null;
}

/* ------------------------------------------------------------ 三态与不可计算 */

export type UncomputableReason =
  | 'NO_SAMPLE'
  | 'ZERO_BASE'
  | 'MISSING_HOUSEHOLDS'
  | 'HISTORY_MISSING'
  | 'INSUFFICIENT_WINDOW';

export const UNCOMPUTABLE_TEXT: Record<UncomputableReason, string> = {
  NO_SAMPLE: '无样本',
  ZERO_BASE: '基期为零',
  MISSING_HOUSEHOLDS: '缺户数',
  HISTORY_MISSING: '历史缺失',
  INSUFFICIENT_WINDOW: '统计窗口不足',
};

export type Computable<T> =
  | { value: T; reason?: undefined }
  | { value: null; reason: UncomputableReason };

export const ok = <T>(value: T): Computable<T> => ({ value });
export const na = <T = never>(reason: UncomputableReason): Computable<T> => ({ value: null, reason });

/** 面板请求状态：loading 骨架屏 / ready 正常 / empty 空态 / error 错误（含 traceId） */
export type PanelStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface PanelState<T> {
  status: PanelStatus;
  data: T | null;
  error: { code: number; message: string; traceId: string } | null;
}

/* ---------------------------------------------------------------- 筛选条件 */

export type Industry = 'WATER' | 'GAS';
export type IndustryFilter = 'ALL' | Industry;

export interface IndustryMeta {
  code: Industry;
  name: string;
  color: string;
}

export const INDUSTRIES: Record<Industry, IndustryMeta> = {
  WATER: { code: 'WATER', name: '供水', color: '#19d3f0' },
  GAS: { code: 'GAS', name: '供气', color: '#f5a623' },
};

export type PeriodKey = 'today' | '7d' | '30d' | 'quarter' | 'year';

export interface PeriodMeta {
  key: PeriodKey;
  label: string;
  /** 统计窗口自述，顶部筛选与图例共用 */
  range: string;
}

export const PERIODS: PeriodMeta[] = [
  { key: 'today', label: '今日', range: '2026-12-22' },
  { key: '7d', label: '近7天', range: '2026-12-16 ~ 2026-12-22' },
  { key: '30d', label: '近30天', range: '2026-11-23 ~ 2026-12-22' },
  { key: 'quarter', label: '本季', range: '2026-10-01 ~ 2026-12-22' },
  { key: 'year', label: '本年', range: '2026-01-01 ~ 2026-12-22' },
];

export const INDUSTRY_FILTERS: { key: IndustryFilter; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'WATER', label: '供水' },
  { key: 'GAS', label: '供气' },
];

export interface ScreenFilters {
  period: PeriodKey;
  industry: IndustryFilter;
  snapshotId: string;
  /** 地图下钻范围：选中行政网格后统计面板收窄到该网格（不传=全域） */
  gridCode?: string | null;
  /** 区县收窄：点击区域分布/筛选条区域后，面板收窄到该区（不传=全域） */
  districtCode?: string | null;
}

/** 地图侧网格范围元数据（统计面板收窄时使用，真实项目由 /api/screen/grid/{code} 提供） */
export interface ScopeGrid {
  gridCode: string;
  gridName: string;
  communityName: string;
  districtCode: string;
  districtName: string;
  /** 该网格诉求量占全域比例，用于空间收窄；真实接口按 gridCode 过滤，不需要这个系数 */
  factor: number;
}

/** 强制切换面板状态，用来演示三态 */
export type ForcedState = 'normal' | 'loading' | 'empty' | 'uncomputable' | 'error';

/* ---------------------------------------------------------------- overview */

export type MetricKey = 'year' | 'quarter' | 'month' | 'yesterday';

export interface MetricCard {
  key: MetricKey;
  label: string;
  /** 指标口径自述，例如「2026 年（截至 12-22）」 */
  caption: string;
  value: Computable<number>;
  /** 环比（与上一同长度窗口比），单位 %；历史缺失时 value=null */
  delta: Computable<number>;
  /** 环比基准说明，例如「较 2026Q3」 */
  deltaCaption: string;
}

export interface IndustryOverview {
  industry: Industry;
  name: string;
  color: string;
  metrics: MetricCard[];
}

export interface OverviewSummary {
  total: Computable<number>;
  finishRate: Computable<number>;
  satisfactionRate: Computable<number>;
  unlocated: number;
  /** 已办结件数（tooltip 用） */
  finishedCount: number;
}

export interface OverviewData {
  meta: ScreenMeta;
  summary: OverviewSummary;
  industries: IndustryOverview[];
}

/* ------------------------------------------------------------ supply 四维 */

export interface TypeStat {
  typeId: string;
  name: string;
  count: number;
  /** 占比 % */
  share: number;
}

export interface EnterpriseRatio {
  enterpriseId: string;
  name: string;
  industry: Industry;
  demandCount: number;
  /** 服务户数；null 表示后台未维护（不可计算：缺户数） */
  households: number | null;
  /** 件/万户；null + reason 时 UI 显示「不可计算：xxx」 */
  ratio: Computable<number>;
  denominatorDate: string;
}

export interface MonthPoint {
  month: number;
  label: string;
  /** 该月未到/无数据时为 null，不补 0 */
  value: number | null;
  /** 是否包含截止日（不完整月） */
  partial: boolean;
}

/** 月度序列 + 不可计算原因（整条序列缺失时 reason 非空，UI 显示「不可计算：xxx」） */
export interface MonthSeries {
  points: MonthPoint[];
  reason: UncomputableReason | null;
  note: string;
}

export interface DistrictStat {
  districtCode: string;
  name: string;
  count: number;
  share: number;
}

export interface CommunityRow {
  rank: number;
  communityName: string;
  /**
   * 小区编码（charts.community 的 code，形如 C-420502-0001）。
   * 高频小区点击后按小区编码过滤明细（/screen/demands?communityCode=）；
   * 旧契约没有该字段时缺省，此时点击不按小区过滤（不猜编码）。
   */
  communityCode?: string;
  gridName: string;
  districtName: string;
  count: number;
  /**
   * 满意率（分母=已评价件），用于右栏「高频诉求小区 Top10」。
   * null + reason 时显示「不可计算：无有效评价」，不补 0（可选字段，兼容旧契约）。
   */
  satisfactionRate?: Computable<number>;
}

export interface SupplyData {
  meta: ScreenMeta;
  industry: IndustryFilter;
  period: PeriodKey;
  total: Computable<number>;
  typeStats: TypeStat[];
  enterpriseRatio: EnterpriseRatio[];
  /** 分母日期（服务户数由后台维护，需标注日期） */
  denominatorDate: string;
  monthly: MonthSeries;
  district: {
    items: DistrictStat[];
    /** 未定位单列，不并入六区 */
    unlocated: number;
  };
  /** 按问题类型（categoryCode）拆分的区县分布（同一 bootstrap 响应内，不新增请求） */
  districtByType: Record<string, { items: DistrictStat[]; unlocated: number }>;
  communityTop: {
    /** 当前期间可统计到的小区数，可能少于 10 */
    captured: number;
    items: CommunityRow[];
  };
}

/* ------------------------------------------------------ demand-dynamic 动态 */

export interface SatisfactionBreakdown {
  satisfied: number;
  dissatisfied: number;
  unevaluated: number;
  satisfiedRate: Computable<number>;
  items: { name: string; value: number }[];
}

export interface DissatisfactionRing {
  industry: Industry;
  name: string;
  total: number;
  items: { name: string; value: number }[];
}

export type DurationBucketKey = '[0,24]' | '(24,48]' | '(48,72]' | '>72';

export interface DurationBucketRow {
  bucket: DurationBucketKey;
  label: string;
  demandCount: number;
  satisfiedRate: Computable<number>;
  dissatisfiedRate: Computable<number>;
  /**
   * 后端 domain/screen.ts 交叉统计的每档评价（有办结时间时才有）：
   * evaluatedCount/satisfiedCount/unsatisfiedCount/unevaluatedCount/percent（percent 为 0~1）。
   * 缺省/null = 该档无评价数据，UI 显示不可计算/「—」，不补 0。
   */
  evaluation?: DurationBucketEvaluation | null;
}

export interface HourPoint {
  hour: number;
  label: string;
  count: number;
  /** 供气件数（高峰时段卡片双系列用） */
  gas?: number;
  /** 供水件数（高峰时段卡片双系列用） */
  water?: number;
}

/** 标书 1.2.3：24 小时分行业桶 */
export interface HourlyBucketPoint {
  hour: number;
  label: string;
  count: number;
  gas: number;
  water: number;
}

/** 标书 1.2.3：周一~周日分行业桶（周一=1 … 周日=7） */
export interface WeekdayBucketPoint {
  weekday: number;
  label: string;
  count: number;
  gas: number;
  water: number;
}

/** 标书 1.2.3：处理时长分档（满意度无数据源，satisfaction 恒为 null） */
export interface DurationEvidence {
  minHours: number | null;
  maxHours: number | null;
  identicalRatio: number | null;
}

/**
 * 处理时长四档 · 每档满意度（后端按 satisfaction_code 与 source_completed_at 交叉统计）
 * 口径与后端 domain/screen.ts 一致：percent 为 0~1 小数（满意/evaluated），分母 0 时为 null。
 */
export interface DurationBucketEvaluation {
  /** 该档有有效评价的件数（分母 = satisfiedCount + unsatisfiedCount） */
  evaluatedCount?: number | null;
  /** 满意 + 基本满意 */
  satisfiedCount?: number | null;
  unsatisfiedCount?: number | null;
  /** 暂无回复 / 未评价 / 其他 */
  unevaluatedCount?: number | null;
  /** 满意率（0~1 小数）；分母 0 时为 null */
  percent?: number | null;
}

export interface DurationBucketCount {
  label: string;
  count: number;
  /**
   * 每档满意度/不满意百分比来源；缺省或 null 表示该档无评价数据（UI 隐藏/显示「—」，不补 0）。
   */
  evaluation?: DurationBucketEvaluation | null;
}

export interface DurationStats {
  /** 有可核验办结时间时给出四档真值；否则 null（不可计算，不补 0） */
  value: {
    buckets: DurationBucketCount[];
    /** 有办结时间的件数（分母） */
    covered: number;
    /** covered / total */
    coverage: number;
    total: number;
    /** 实际完成时间晚于规定完成时间的件数 */
    overtime: number;
    overtimeRate: number;
  } | null;
  reason: string | null;
  evidence: DurationEvidence | null;
}

export interface WeekdayPoint {
  weekday: number;
  label: string;
  /** 统计窗口未覆盖的星期为 null（不补 0） */
  value: number | null;
}

export interface WeekdaySeries {
  points: WeekdayPoint[];
  reason: UncomputableReason | null;
  /** 统计窗口覆盖到的星期数（不足 7 时部分点为 null） */
  coverage: { covered: number; need: number };
}

/** 标书 1.2.3：满意度（分母=有效评价 rated；基本满意计入满意；暂无回复/未评价单列） */
export interface SatisfactionIndustryStats {
  total: number;
  rated: number;
  satisfied: number;
  satisfiedOnly: number;
  basically: number;
  unsatisfied: number;
  noReply: number;
  unrated: number;
  satisfiedRate: Computable<number>;
}

export interface SatisfactionStats extends SatisfactionIndustryStats {
  byIndustry: { gas: SatisfactionIndustryStats; water: SatisfactionIndustryStats };
  sourceNote: string;
}

export interface DemandDynamicData {
  meta: ScreenMeta;
  period: PeriodKey;
  industry: IndustryFilter;
  total: Computable<number>;
  satisfaction: SatisfactionBreakdown;
  dissatisfaction: DissatisfactionRing[];
  durationBuckets: DurationBucketRow[];
  peakHours: HourPoint[];
  monthlyTotal: MonthSeries;
  weekday: WeekdaySeries;
  /** 标书 1.2.3：满意度（真实 satisfaction_code，供气/供水拆分） */
  satisfactionStats: SatisfactionStats;
  /** 标书 1.2.3：24 小时双行业桶（高峰时段卡） */
  hourlySplit: HourlyBucketPoint[];
  /** 标书 1.2.3：周一~周日双行业桶（周变化卡） */
  weekdaySplit: WeekdayBucketPoint[];
  /** 标书 1.2.3：处理时长不可计算（缺可核验办结时间） */
  durationStats: DurationStats;
}

/* ------------------------------------------------------ analysis/top-types */

export interface ResearchItem {
  rank: number;
  /** 诉求类型编码（往年 TOP3 用；点击「查看证据」按该类型过滤明细；其他研报项可缺省） */
  typeId?: string;
  /** 研判主题，例如「水压不足 × 网格投诉 可能属于同诉求」 */
  title: string;
  typeName: string;
  count: number;
  share: number;
  hint: string;
  relatedEventNo: string | null;
  severity: 'HIGH' | 'MID' | 'LOW';
}

export interface TopTypesData {
  meta: ScreenMeta;
  period: PeriodKey;
  industry: IndustryFilter;
  items: ResearchItem[];
  /** 空列表时的解释文案 */
  emptyReason: string | null;
}

/* -------------------------------------------------------- warning/list */

export type WarningLevel = 'RED' | 'ORANGE' | 'YELLOW';

export type WarningCategory =
  | 'SAME_EVENT'
  | 'DEMAND_SPIKE'
  | 'REGION_ANOMALY'
  | 'SATISFACTION_DROP'
  | 'UNLOCATED'
  | 'DATA_QUALITY';

export interface AffectedGrid {
  gridCode: string;
  gridName: string;
  communityName: string;
  demandCount: number;
}

export interface WarningItem {
  warningId: string;
  level: WarningLevel;
  category: WarningCategory;
  title: string;
  description: string;
  /** 关联停供事件号；null 表示非事件类预警 */
  eventNo: string | null;
  affectedGrids: AffectedGrid[];
  timeRange: [string, string];
  relatedDemandCount: number;
  detectedAt: string;
  suggestion: string;
}

export interface WarningListData {
  meta: ScreenMeta;
  items: WarningItem[];
}

/* ----------------------------------------------------- analysis/research */

export interface ResearchTop6Row {
  rank: number;
  subjectType: 'GRID' | 'COMMUNITY';
  name: string;
  gridName: string;
  districtName: string;
  demandCount: number;
  satisfactionRate: Computable<number>;
  topType: string;
  /** 近 6 期诉求量，用于表格内迷你趋势 */
  trend: number[];
}

export interface ResearchTopData {
  meta: ScreenMeta;
  period: PeriodKey;
  industry: IndustryFilter;
  items: ResearchTop6Row[];
  emptyReason: string | null;
}

/* --------------------------------------------------- dashboard/demands 下钻 */

export interface DemandItem {
  caseNo: string;
  industry: Industry;
  typeName: string;
  communityName: string;
  gridName: string;
  intakeTime: string;
  status: '已办结' | '处理中' | '待核验';
  relatedEvent: boolean;
  eventNo: string | null;
  satisfaction: '满意' | '不满意' | '未评价';
}

/** 下钻条件：所有面板点击都会落到这个结构，接口参数一一对应 */
export interface DrillQuery {
  /** 触发来源，仅用于抽屉标题展示 */
  source: string;
  title: string;
  period: PeriodKey;
  industry: IndustryFilter;
  typeId?: string;
  districtCode?: string;
  communityName?: string;
  enterpriseId?: string;
  bucket?: DurationBucketKey;
  metricKey?: MetricKey;
  eventNo?: string;
  /** 地图下钻：网格编码 */
  gridCode?: string | null;
  /** 高频小区点击：小区编码（/screen/demands 的 communityCode；中文名不参与过滤） */
  communityCode?: string | null;
  /** 月度趋势点击：指定月份（1-12），用于同月明细（真实接口按 month 过滤 MVT/明细） */
  month?: number;
  page?: number;
  pageSize?: number;
}

export interface DemandListData {
  meta: ScreenMeta;
  condition: DrillQuery;
  page: number;
  pageSize: number;
  total: number;
  items: DemandItem[];
}

/* ---------------------------------------------------------------- 工具类型 */

export interface TabDef {
  key: 'cockpit' | 'supply' | 'dynamic';
  label: string;
  caption: string;
}

export const TABS: TabDef[] = [
  { key: 'cockpit', label: '统计驾驶舱', caption: 'A25 · 诉求总量 / 办结 / 满意 / 未定位' },
  { key: 'supply', label: '供气/供水四维', caption: 'A26 · 类型 / 万户 / 月度 / 区域 / 高频小区' },
  { key: 'dynamic', label: '诉求动态', caption: 'A27 · 满意 / 时长 / 高峰 / 周变化' },
];


