<script setup lang="ts">
/**
 * 验收大屏 #/accept（前半）
 *
 * 风格来源：8002 道路「住新局 · 燃气入户安检」large-screen（只借鉴风格/版式，不复制业务代码）。
 * 内容来源：现有 stats 数据层（useStatScreen + 真实接口映射 + 组件），主屏只留「诉求总览 / 问题类型分布 /
 * 企业每万户」三卡；满意度/时长/周变化/高峰、研判 Top6、预警列表等收进底部按钮打开的抽屉。
 * 地图：内联三维 CIM 白模（超图 Cesium + S3M；本机 drs 网关不可达时如实显示「底图不可达」，不伪造三维）。
 * 瓦片鉴权当前 401 → 自动回退深色降级网格，状态条如实说明，不伪造影像/白模。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import InlineCesiumView from '@/components/Map/InlineCesiumView.vue';
import Map2DView, {
  type Map2DStatus,
  type Map2DPoint,
  type GridMetric,
  type PipelinePickPayload,
  type ShutdownPickPayload,
} from '@/components/Map/map2d/Map2DView.vue';
import PipelinePanel from './panels/PipelinePanel.vue';
import ShutdownEventPanel from './panels/ShutdownEventPanel.vue';
import { useStatScreen } from '@/stats/useStatScreen';
import {
  CATEGORY_OPTIONS,
  ENTERPRISE_OPTIONS,
  hasRealSession,
  currentRealWindow,
  fetchBundle,
  invalidateBundleCache,
  pickIndustryBundle,
  realAdminGridOptions,
  realCommunityOptions,
  realLogin,
  setRealAsOf,
  type ShutdownStatsSnapshot,
} from '@/stats/realSource';
import type { PeriodMeta } from '@/stats/types';
import { hashQuery, useDesignScale } from '@/stats/useDesignScale';
import {
  type DrillQuery,
  type ForcedState,
  type IndustryFilter,
  type MetricKey,
  type PeriodKey,
} from '@/stats/types';
import OverviewCard from './OverviewCard.vue';
import TypeDistributionCard from './TypeDistributionCard.vue';
import EnterpriseRatioCard from './EnterpriseRatioCard.vue';
import MonthlyTrendCard from './MonthlyTrendCard.vue';
import DistrictDistributionCard from './DistrictDistributionCard.vue';
import CommunityTopCard from './CommunityTopCard.vue';
import MapPickPanel, { type MapPickDetail, type MapAnchor } from './MapPickPanel.vue';
import SatisfactionCard from './SatisfactionCard.vue';
import HourlyPeakCard from './HourlyPeakCard.vue';
import WeekdayTrendCard from './WeekdayTrendCard.vue';
import DurationBucketsCard from './DurationBucketsCard.vue';
import AcceptTicker from './AcceptTicker.vue';
import AcceptDrawer from './AcceptDrawer.vue';
import type { AcceptDrawerKey } from './types';
import { REAL_GAP } from './gaps';
import { useIndustryMonthly } from './useIndustryMonthly';
import DrilldownDrawer from '@/stats/components/DrilldownDrawer.vue';
import { findScene } from '@/components/Map/cim3d/scenes';
import { fetchGridBoundaries } from '@/components/Map/map2d/gridLayer';
import type { AdministrativeHeat } from '@/components/Map/map2d/administrativeHeat';
import '@/stats/stat-screen.css';
import './accept.css';

/* ------------------------------------------------------------------ 路由参数 */

const q = hashQuery();
const initPeriod = (q.get('period') as PeriodKey | null) ?? '30d';
const initState = (q.get('state') as ForcedState | null) ?? 'normal';
const initGrid = q.get('grid');
const initDistrict = q.get('district');
const initMonth = Math.min(12, Math.max(0, Number(q.get('month') ?? 0))) || null;
const initDrill = q.get('drill');
const noMotion = q.get('noanim') === '1';

/**
 * ===== 地图视图模式（二维 / 三维）=====
 *
 * 背景：三维白模在大屏上的实际体验差（加载慢、点位被楼栋遮挡、状态色无从表达），
 * 而标书 1.2 节对诉求大屏的要求本就是「图表 + 网格 + 地图联动」（热力分布、社区网格图层、
 * 管线图层、逐级下钻），并未要求三维。因此新增二维视图并**默认使用二维**，
 * 三维保留为可切换视图，逻辑与数据完全同构（同点位、同筛选、同拾取回调）。
 *
 * URL：`?view=2d`（默认）/ `?view=3d` 可直达指定视图，便于验收时对比。
 */
type MapViewMode = '2d' | '3d';
const initView = (q.get('view') as MapViewMode | null) === '3d' ? '3d' : '2d';
const viewMode = ref<MapViewMode>(initView);
const map2dRef = ref<InstanceType<typeof Map2DView> | null>(null);
const map2dStatus = ref<Map2DStatus | null>(null);
const map2dKey = ref(0);

/** 切换二维/三维：同步 URL，同时释放另一种视图占用的资源（v-if 互斥） */
function setViewMode(mode: MapViewMode) {
  if (viewMode.value === mode) return;
  if (mode === '3d') {
    closePipelinePick();
    closeShutdownPick();
  }
  viewMode.value = mode;
  const url = new URL(location.href);
  url.hash = url.hash.replace(/([?&])view=(2d|3d)/, `$1view=${mode}`).replace(/[?&]$/, '');
  if (!/[?&]view=/.test(url.hash)) {
    url.hash = `${url.hash}${url.hash.includes('?') ? '&' : '?'}view=${mode}`;
  }
  history.replaceState(null, '', url);
  // 切到三维：复用原有懒加载（只挂一次）
  if (mode === '3d' && !show3d.value) show3d.value = true;
  // 切回二维：重建实例，确保尺寸正确（三维卸载后 DOM 尺寸会变）
  if (mode === '2d') {
    map2dKey.value += 1;
    map2dStatus.value = null;
  }
  refreshMapSize();
}

/**
 * 二维视图底图加载场景：`?scene=<区县场景|all>` 选三维加载范围（默认城区 chengqu_jitter）。
 * 三维视图保留原语义；二维视图不用该参数（固定 4490 全量影像网格）。
 */
const initScene = q.get('scene') ?? 'chengqu_jitter';
/** 内联三维状态（由 InlineCesiumView 按真实加载结果回报，不伪造） */
interface Inline3dStatusView {
  phase: 'boot' | 'loading' | 'ready' | 'error';
  text: string;
  detail: string;
  engine: string;
  scenes: number;
  tiles: number;
  canvas: string;
  /** 底图方案（真实结果；off/失败都要能看见原因） */
  basemap: string;
  /** 底图一句话摘要（3D 状态卡「底图」行用，含调色生效值） */
  basemapShort: string;
  /** 底图诊断：cim.json 读到什么 + 走了哪个分支（浮层里看） */
  basemapDiag: string;
  /** S3M 楼栋属性核查结论 */
  schema: string;
  /** 底图调色生效值（brightness/contrast/saturation/gamma） */
  tuning: string;
  /** 小区三维点位加载情况（3D 状态卡「小区点位」行用） */
  community: string;
}

/**
 * 真实数据源（gqxq 诉求平台 `/api/v1`）
 * - 客户要求：**演示数据全部去掉**，页面默认只展示真实数据；
 * - 打开页面若未登录则自动弹出登录框；token 只存 sessionStorage（不写死密码、不进 URL）；
 * - `?asOf=YYYY-MM-DD` 仅用于评审时对齐真实库最新数据日（可选，不影响默认“今天”锚点）。
 */
const initAsOf = q.get('asOf');
if (initAsOf) setRealAsOf(initAsOf);

type TabKey = 'gas' | 'water' | 'dynamic';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'gas', label: '供气服务' },
  { key: 'water', label: '供水服务' },
  { key: 'dynamic', label: '诉求动态' },
];
const initTab: TabKey = (q.get('tab') as TabKey | null) ?? 'dynamic';
const industryOf = (tab: TabKey): IndustryFilter => (tab === 'gas' ? 'GAS' : tab === 'water' ? 'WATER' : 'ALL');

/* ------------------------------------------------------------------ 数据层（复用统计大屏唯一入口） */

const screen = useStatScreen({
  initialPeriod: initPeriod,
  initialIndustry: industryOf(initTab),
  initialState: initState,
  initialGrid: initGrid,
  initialDistrict: initDistrict,
});

const {
  period,
  periodMeta,
  appliedWindow,
  selectedWindow,
  appliedFilters,
  industry,
  forcedState,
  gridCode,
  districtCode,
  meta,
  refreshing,
  overview,
  supply,
  dynamic,
  topTypes,
  warnings,
  research,
  drill,
  openDrill,
  closeDrill,
  goDrillPage,
  pageSize,
  reload,
  setGrid,
  setDistrict,
  enterpriseCode,
  setEnterprise,
  communityCode,
  setCommunity,
  categoryCode,
  setCategory,
} = screen;

const { scale } = useDesignScale();

/** 真实接口的统计窗口（不是静态期间表）；卡片/抽屉/筛选条都显示真实 from~to */
const displayPeriodMeta = computed<PeriodMeta>(() => {
  const w = appliedWindow.value;
  return { ...periodMeta.value, range: `${w.from} ~ ${w.to}` };
});

/** 当前区域环联动的问题类型（类型分布点击 / 分类筛选）；需先于月度趋势 hook 声明（其 watch 立即执行） */
const activeTypeCode = ref<string | null>(null);
const activeTypeName = computed(() => {
  if (!activeTypeCode.value) return null;
  return CATEGORY_OPTIONS.find((c) => c.code === activeTypeCode.value)?.name ?? activeTypeCode.value;
});
/** 右①点击月份后的展示口径（1-12，null=未选） */
const selectedMonth = ref<number | null>(null);

/** 右①月度趋势：同时取供水/供气两份 MonthSeries（与主面板同 snapshot/period/空间范围） */
const { water: monthlyWater, gas: monthlyGas, reload: reloadMonthly } = useIndustryMonthly({
  period,
  gridCode,
  districtCode,
  forcedState,
  enterpriseCode,
  communityCode,
  categoryCode,
  // 标书 1.2.2 ③：图内点击的类型作为月度折线的 categoryCode（顶部筛选条未选分类时生效）
  activeTypeCode,
});

/* ------------------------------------------------------------------ 顶部 / Tab / 筛选 */

const tab = ref<TabKey>(initTab);

function setTab(key: TabKey) {
  if (tab.value === key) return;
  tab.value = key;
  industry.value = industryOf(key);
  if (key === 'dynamic') {
    showToast('诉求动态：满意度 / 时长 / 周变化 / 高峰已收至「更多分析」抽屉，主屏只保留三张核心卡');
  }
  /*
   * 关键修复：切 tab 等于换「行业口径」（供气 / 供水 / 全部），必须重新拉数。
   *
   * 历史 bug：本函数只改了两个 ref，没有触发任何请求 ——
   * 数据卡看着「变了」是因为卡片内部按 industry 做客户端过滤，
   * 但地图空间数据（spatialPoints / spatialGridCounts）是挂载时拉一次的，
   * 于是出现客户反馈的「切 tab 只有数据窗体变，地图完全没动」。
   *
   * 三份数据都要重拉：
   *   reload()        左右统计卡
   *   loadSpatial()   地图点位 + 网格件数 + 小区热力圆盘
   *   reloadMonthly() 月度折线
   */
  void reload();
  void loadSpatial();
  void reloadMonthly();
}

const today = new Date();
const todayText = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
const cutoffText = computed(() => {
  const iso = meta.value?.dataCutoffTime;
  if (!iso || iso === '—') return '数据截止 —（等待真实数据）';
  const m = iso.match(/^(\d{4})-(\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return `数据截止 ${m[2]} ${m[3]}（真实）`;
  return `数据截止 ${iso}（真实）`;
});

/** 固定真实数据模式（客户要求演示数据全部去掉） */
/** 未登录自动弹登录框；token 只在 sessionStorage */
const loginOpen = ref(!hasRealSession());
const loginUser = ref('');
const loginPw = ref('');
const loginBusy = ref(false);
const loginError = ref('');
const toastText = ref('');
let toastTimer: number | null = null;
function showToast(msg: string) {
  toastText.value = msg;
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastText.value = ''), 3600);
}
onBeforeUnmount(() => {
  if (toastTimer != null) window.clearTimeout(toastTimer);
  window.removeEventListener('keydown', onKeydown);
});

/* ------------------------------------------------------------------ 筛选条 */

function rangeOf(key: PeriodKey): [string, string] {
  const w = currentRealWindow(key);
  return [w.from, w.to];
}
const [initFrom, initTo] = rangeOf(period.value);
const fromDate = ref(initFrom);
const toDate = ref(initTo);
const districtFilter = ref(initDistrict ?? '');
/** 企业 / 网格 / 小区 / 分类筛选（真实库主数据已配置，点「查询」统一下发后端） */
const enterpriseFilter = ref('');
const adminGridFilter = ref('');
const communityFilter = ref('');
const categoryFilter = ref('');

/**
 * 「更多筛选」折叠状态 + 已生效条件计数。
 *
 * 标书 1.2.2 / 1.2.9 只依赖「时间范围 + 诉求类型」，区域/企业/网格/小区属增强项。
 * 折叠后必须让用户知道"现在有没有额外的筛选在生效"，否则会被误认为全量数据，
 * 所以按钮上带计数徽标（例如「更多筛选（2）」）。
 */
const moreFiltersOpen = ref(false);
const moreFilterBadge = computed(
  () => [districtFilter.value, enterpriseFilter.value, adminGridFilter.value, communityFilter.value].filter(Boolean).length
);
/** 区域选项只来自真实接口（真实库有 14 个区县码；后端无数据时不补默认区划） */
const districtOptions = computed(() => supply.value.data?.district.items ?? []);
/** 企业选项：企业主数据 12 家（enterpriseCode） */
const enterpriseOptions = computed(() => ENTERPRISE_OPTIONS);
/**
 * 网格编码 → 名称。
 *
 * 后端 charts.adminGrid 只回 code/count，不带名称；而客户要求下拉里能"名称＋编码"
 * 一起看，方便和社区编码对照核对（小区用 C-xxxx 编码、网格用 9 位行政编码）。
 * 名称从 admin-boundaries 接口取（服务端 12h/30min 缓存，一次请求即可）。
 * 取不到就退回只显示编码，不编造名称。
 */
const gridNameByCode = ref<Record<string, string>>({});
async function loadGridNames() {
  try {
    const res = await fetchGridBoundaries();
    const map: Record<string, string> = {};
    for (const b of res.boundaries) {
      if (b?.code && b?.name) map[String(b.code)] = String(b.name);
    }
    gridNameByCode.value = map;
  } catch {
    // 名称拿不到不影响功能：下拉退回显示纯编码
  }
}
/** 网格下拉的展示文本：有名称就「名称（编码）」，否则只有编码 */
function gridOptionLabel(code: string): string {
  const name = gridNameByCode.value[String(code)];
  return name ? `${name}（${code}）` : String(code);
}

/** 网格选项：真实 charts.adminGrid（首次无筛选结果缓存全量，避免筛选后下拉缩水） */
const adminGridOptions = computed(() => {
  void meta.value?.snapshotId;
  void supply.value.data;
  return realAdminGridOptions();
});
/** 小区选项：真实 spatial.communities，最多展示前 200 个（其余提示后续补搜索） */
const communityOptions = computed(() => {
  void meta.value?.snapshotId;
  void supply.value.data;
  return realCommunityOptions().slice(0, 200);
});
const communityOptionTotal = computed(() => {
  void meta.value?.snapshotId;
  void supply.value.data;
  return realCommunityOptions().length;
});
const heatCategories = ref<AdministrativeHeat['data']['categories']>([]);
const categoryOptions = computed(() => heatCategories.value.length
  ? heatCategories.value.map(c => ({code:c.code,name:c.parentCode?c.name:`${c.name}（大类）`}))
  : CATEGORY_OPTIONS);

function periodFromDates(): PeriodKey {
  const start = Date.parse(`${fromDate.value}T00:00:00`);
  const end = Date.parse(`${toDate.value}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '30d';
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days <= 1) return 'today';
  if (days <= 7) return '7d';
  if (days <= 31) return '30d';
  if (days <= 92) return 'quarter';
  return 'year';
}

/**
 * 「高频诉求小区」空态文案 —— 按**真实原因**生成，不再套用静态的「主数据未配置」。
 *
 * 背景：原实现固定传 REAL_GAP.communityText（"小区/网格主数据未配置…"），
 * 但主数据其实配好了（946 个小区都有坐标）。
 * 真实原因多半是：当前筛选窗口内那几条诉求**没有定位到小区**（社区编码为空），
 * 自然排不出 Top10。写清真实原因，比甩一句"主数据未配置"可信得多。
 */
const communityEmptyTitle = computed(() => {
  const st = (supply.value as { status?: string } | undefined)?.status;
  if (st === 'loading' || st === 'idle') return '高频小区加载中…';
  return '当前窗口无小区排名';
});
const communityEmptyText = computed(() => {
  const s = supply.value as { communities?: unknown[] } | undefined;
  const rows = Array.isArray(s?.communities) ? s!.communities!.length : 0;
  if (rows > 0) return '';
  return '所选窗口 / 行业 / 分类下的诉求未定位到小区（社区编码为空），无法生成小区排名 —— 缺失不补 0、不凑数。';
});

function applyQuery() {
  if (!fromDate.value || !toDate.value || fromDate.value > toDate.value) {
    showToast('请选择有效的起止日期，开始日期不能晚于结束日期');
    return;
  }
  selectedWindow.value = { from: fromDate.value, to: toDate.value };
  period.value = periodFromDates();
  // 网格（charts.adminGrid 的 code）优先；与区县互斥（setGrid 会清区县）
  if (adminGridFilter.value) {
    districtFilter.value = '';
    setDistrict(null);
    setGrid(adminGridFilter.value);
  } else if (districtFilter.value) {
    setGrid(null);
    setDistrict(districtFilter.value);
  } else {
    setGrid(null);
    setDistrict(null);
  }
  setEnterprise(enterpriseFilter.value || null);
  setCommunity(communityFilter.value || null);
  setCategory(categoryFilter.value || null);
  activeTypeCode.value = categoryFilter.value || null;
  selectedMonth.value = null;
  invalidateBundleCache(appliedFilters.value);
  void reload();
  /**
   * 关键：筛选后必须重新拉取**地图空间数据**。
   *
   * 历史 bug：本函数只调了 reload()（刷新左右统计卡），从未调 loadSpatial()，
   * 而 loadSpatial() 只在 onMounted 跑一次 ——
   * 于是用户改完筛选点「查询」，左右卡片数字变了，**地图点位与网格着色纹丝不动**。
   * 这正是「筛选后地图数据没变化」的真实原因。
   */
  void loadSpatial();
}

function resetFilters() {
  const [f, t] = rangeOf('30d');
  fromDate.value = f;
  toDate.value = t;
  selectedWindow.value = { from: f, to: t };
  districtFilter.value = '';
  enterpriseFilter.value = '';
  adminGridFilter.value = '';
  communityFilter.value = '';
  categoryFilter.value = '';
  selectedMonth.value = null;
  period.value = '30d';
  setGrid(null);
  setDistrict(null);
  setEnterprise(null);
  setCommunity(null);
  setCategory(null);
  activeTypeCode.value = null;
  void reload();
  void loadSpatial();
  showToast('已重置筛选：统计窗口 近30天 · 全域');
}

/* ------------------------------------------------------------------ 三维地图（可切换视图） */

const inline3dKey = ref(0);
/** 三维懒加载：先渲染左右面板与筛选条，再挂 Cesium（?fast3d=1 立即挂载；默认二维视图下不挂） */
const show3d = ref(false);
const inline3dStatus = ref<Inline3dStatusView | null>(null);
const inline3dRef = ref<InstanceType<typeof InlineCesiumView> | null>(null);

/** 传给三维组件的小区点位：真实 bootstrap 到达后重算（依赖 meta/supply 触发响应式重绘） */
const inline3dPoints = computed(() => {
  // 与二维共享同一份空间点位（spatialPoints 由 loadSpatial 拉取并保持响应式）
  return spatialPoints.value;
});

/* ------------------------------------------------------------------ 二维地图（默认视图） */

/**
 * 二维视图小区点位：直接调 `fetchBundle` 取 `spatial.communities`（抖动坐标 EPSG:4326）。
 *
 * 为什么不复用 `realCommunityPoints()`：它读的是模块级 `lastAllBundle`，只在 `fetchBundle`
 * 成功后才赋值；而大屏页面用的是 `useStatScreen`（6 个统计接口），**从不调用 fetchBundle**，
 * 所以那个缓存恒为空 —— 三维视图「小区点位：未加载」正是这个原因。
 * 这里自己取一次 bundle，结果放进响应式 ref，二维/三维共用（三维也改为读同一份）。
 */
const spatialPoints = ref<Map2DPoint[]>([]);
const spatialGridCounts = ref<GridMetric[]>([]);
const spatialHeat = ref<AdministrativeHeat | null>(null);
const spatialState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const spatialError = ref('');
let spatialRequest = 0;
let spatialRequestFilters: typeof appliedFilters.value | null = null;
const spatialSnapshot = shallowRef<(ShutdownStatsSnapshot & { filters: typeof appliedFilters.value }) | null>(null);
const shutdownSnapshot = computed(() =>
  spatialSnapshot.value?.filters === appliedFilters.value ? spatialSnapshot.value : null,
);

/** 拉取空间点位与网格件数（与筛选同步；失败如实记录，不伪造数据） */
async function loadSpatial() {
  const request = ++spatialRequest;
  const filters = appliedFilters.value;
  spatialRequestFilters = filters;
  spatialSnapshot.value = null;
  spatialState.value = 'loading';
  spatialError.value = '';
  spatialHeat.value = null;
  try {
    const picked = pickIndustryBundle(await fetchBundle(filters), filters.industry);
    if (request !== spatialRequest) return;
    spatialSnapshot.value = {
      filters, contextId: picked.contextId, expiresAt: picked.expiresAt,
      from: picked.window.from, to: picked.window.to,
    };
    spatialHeat.value = picked.heat ?? null;
    heatCategories.value = picked.heat?.data?.categories ?? [];
    const communities = picked?.spatial?.data?.communities ?? [];
    const rows: any[] = picked?.charts?.adminGrid ?? [];

    spatialPoints.value = (Array.isArray(communities) ? communities : [])
      .filter((c: any) => Number.isFinite(Number(c?.longitude)) && Number.isFinite(Number(c?.latitude)))
      .map((c: any) => ({
        id: String(c.id ?? c.code ?? ''),
        name: String(c.name ?? c.id ?? ''),
        longitude: Number(c.longitude),
        latitude: Number(c.latitude),
        gridId: c.gridId ? String(c.gridId) : undefined,
      }));

    /*
     * 区县件数必须用 charts.district 的口径，不能直接取 charts.adminGrid 的 6 位行。
     *
     * 为什么：adminGrid 是按「诉求自带的网格字段」分组的 ——
     * 一条诉求如果填到街道（9 位码），它就只出现在 9 位行里；
     * 只有没填到街道、只填到区县的诉求才落到 6 位行。
     * 所以 6 位行的数字是「只管到区县粒度的诉求数」，**不是该区县的总数**。
     *
     * 实测（2026-10-25~11-23）：西陵区 6 位行只有 8，但该区下属 10 个街道合计 75，
     * charts.district 给出正确总数 220 —— 之前用地图形色只看到 8，几乎不着色，
     * 客户问「怎么看不出热力」的根因就在这里。
     */
    const districtRows: any[] = Array.isArray(picked?.charts?.district) ? picked.charts.district : [];
    const districtCount = new Map<string, number>();
    for (const d of districtRows) {
      const code = String(d?.code ?? "");
      if (!code || code === "__missing__") continue;
      districtCount.set(code, Number(d?.count ?? 0));
    }

    const streetRows = (Array.isArray(rows) ? rows : [])
      .filter((r: any) => r?.code && r.code !== "__missing__" && String(r.code).length === 9)
      .map((r: any) => ({ code: String(r.code), count: Number(r.count ?? 0) }));

    /*
     * 合并成一张 code → count 表：
     *   9 位（街道）→ 用 adminGrid 的值
     *   6 位（区县）→ 用 charts.district 的**总数**（含下属街道）
     * 区县即使没有 6 位行、只要 charts.district 里有，也要补进来 ——
     * 否则那个区县的面永远不着色（如秭归县、枝江市、宜都市）。
     */
    const merged = new Map<string, number>();
    for (const r of streetRows) merged.set(r.code, r.count);
    for (const [code, count] of districtCount) merged.set(code, count);

    spatialGridCounts.value = Array.from(merged, ([code, count]) => ({ code, count }));

    spatialState.value = 'ready';
  } catch (e) {
    if (request !== spatialRequest) return;
    spatialState.value = 'error';
    spatialError.value = e instanceof Error ? e.message : String(e);
    spatialPoints.value = [];
    spatialGridCounts.value = [];
  }
}

/** 二维视图点位（有空间数据就用；否则为空，状态条会说明） */
const map2dPoints = computed<Map2DPoint[]>(() => spatialPoints.value);

/** 二维视图网格着色数据（标书 1.2.4 热力分布 + 1.2.8 网格对比的空间表达）：
 * 件数来自真实 bootstrap 的 charts.adminGrid（与网格筛选下拉同源，保证口径一致）。
 */
const map2dGridMetrics = computed<GridMetric[]>(() => spatialGridCounts.value);

/* ---------------------------------------------- 管线改造事件（标书 1.2.7） */
/**
 * 点击二维地图上的改造项目网格 → 打开改造事件详情面板。
 * 面板是独立浮层（不占用底部抽屉），因为标书要求「点击网格即可查看」，交互要短平快。
 */
const pipelinePick = ref<PipelinePickPayload | null>(null);
function onPipelinePick(payload: PipelinePickPayload) {
  closeShutdownPick();
  pipelinePick.value = payload;
}
function closePipelinePick() {
  pipelinePick.value = null;
  map2dRef.value?.clearPipelineSelection();
}

/**
 * 点击二维地图上的停水停气打点标识（标书 1.2.6）→ 打开事件详情浮层。
 *
 * 联动高亮由 Map2DView 内部按 eventId 处理（同一事件全部标识一起高亮），
 * 这里只负责把事件载荷交给面板。关闭时通知地图清掉选中态。
 */
const shutdownPick = ref<ShutdownPickPayload | null>(null);
function onShutdownPick(payload: ShutdownPickPayload) {
  shutdownPick.value = payload;
  ensureShutdownSnapshot();
}

function ensureShutdownSnapshot() {
  const snapshot = shutdownSnapshot.value;
  if (snapshot && Date.parse(snapshot.expiresAt) > Date.now()) return;
  if (spatialState.value === 'loading' && spatialRequestFilters === appliedFilters.value) return;
  invalidateBundleCache(appliedFilters.value);
  void loadSpatial();
}

watch(appliedFilters, () => {
  if (shutdownPick.value) ensureShutdownSnapshot();
});

function closeShutdownPick() {
  shutdownPick.value = null;
  map2dRef.value?.clearShutdownSelection?.();
}

function refreshShutdownSources() {
  closeShutdownPick();
  invalidateBundleCache(appliedFilters.value);
  void loadSpatial();
  void map2dRef.value?.loadShutdown();
}

/** 二维状态回报（底图是否 CIM 真实影像、边界来源、落图数量），父组件如实展示 */
function onMap2dStatus(payload: Map2DStatus) {
  map2dStatus.value = payload;
}

/** 二维地图拾取：与三维「点地图 → 设筛选 → 刷新 → 打开明细」语义一致 */
/**
 * 地图点击（小区点位 / 网格面）→ 定位与高亮。
 *
 * ===== 为什么不再直接筛选 =====
 * 旧实现点小区/网格就写 communityFilter / adminGridFilter 并 applyQuery()，
 * 结果是「点一下地图，整屏数字清零」—— 因为被点中的那个小区/网格在当前时间窗内
 * 很可能只有 0~1 条工单（实测 C-420507-0044「恒信中央公园小区」窗口内仅 1 条，
 * 切到指定 30 天窗口即为 0）。用户看到 10,626 → 0，会直接判定"数据不加载了"。
 *
 * 现在的口径（与「高频诉求小区」保持一致）：
 *   · 点击 = **只定位 + 高亮**，筛选条件与全部面板数字**保持不变**
 *   · 想按该小区/网格收窄统计 → 用筛选条的下拉框（显式操作），或点提示条里的「按此筛选」
 *   · 这样即使命中 0 条工单，也只是提示"该范围当前窗口无工单"，不会把整屏拖成 0
 */
/** 地图点击浮层：被点中对象的概况+明细（独立于左右列表，不改筛选） */
const mapPickDetail = ref<MapPickDetail | null>(null);
const mapPickQuery = computed<DrillQuery | null>(() => {
  const detail = mapPickDetail.value;
  if (!detail) return null;
  const filters = appliedFilters.value;
  return {
    source: '地图点位',
    title: `${detail.name} · 诉求明细`,
    period: filters.period,
    industry: filters.industry,
    filters,
    communityCode: detail.communityCode,
    communityName: detail.kind === 'community' ? detail.name : undefined,
    gridCode: detail.adminGridCode,
    formalHeatGrid: detail.formalHeatGrid,
  };
});
/** 定位锚点：由 Map2DView 回报的「点位在地图容器内的像素坐标」，浮层据此贴点显示 */
const mapAnchor = ref<MapAnchor | null>(null);
/** 地图容器相对页面左上角的偏移，用于把容器内坐标换算成页面坐标 */
const mapOffset = ref({ x: 0, y: 0 });

/** 读取地图容器的页面偏移（布局变化后重新取） */
function syncMapOffset() {
  const el = document.querySelector('.map2d__canvas');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  // 防御：容器未布局时 rect 可能是异常值，保持原值不覆盖
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 5000 || Math.abs(y) > 5000) return;
  mapOffset.value = { x, y };
}
function closeMapPick() {
  mapPickDetail.value = null;
  mapAnchor.value = null;
}

function openMapPickDrawer() {
  const query = mapPickQuery.value;
  if (!query) return;
  openDrill(query);
  closeMapPick();
}

/**
 * 浮层里「按此筛选」= 用户**显式**要求收窄主屏统计时才改筛选。
 * 这与"点地图就自动筛选"不同：默认只出浮层，列表不动。
 */
function applyMapPickFilter(payload: { communityCode?: string; adminGridCode?: string }) {
  const d = mapPickDetail.value;
  if (payload.communityCode) {
    communityFilter.value = payload.communityCode;
    adminGridFilter.value = '';
  } else if (payload.adminGridCode) {
    adminGridFilter.value = payload.adminGridCode;
    districtFilter.value = '';
  }
  closeMapPick();
  applyQuery();
  showToast(`已按${payload.communityCode ? '小区' : '网格'}收窄统计：${d?.name ?? payload.communityCode ?? payload.adminGridCode}`);
}

/**
 * 地图点击（小区点位 / 网格面）→ 弹出概况+明细浮层。
 *
 * 用户要求：「点击地图出东西啊，从这里看概况和明细，列表不要动」。
 *   · 点击 → 定位高亮 + 右侧浮层（概况 + 前 10 条明细）
 *   · 左右两侧列表、筛选条、所有面板数字**完全不动**
 *   · 浮层里点「按此筛选」才显式收窄统计（applyMapPickFilter）
 *   · 浮层与完整明细使用同一份统计上下文
 */
/** Map2DView 回报锚点 → 浮层跟随 */
function onMapAnchor(payload: MapAnchor | null) {
  // 防御：丢弃异常锚点，避免浮层飞到屏幕外
  if (payload) {
    const bad = !Number.isFinite(payload.x) || !Number.isFinite(payload.y) || Math.abs(payload.x) > 5000 || Math.abs(payload.y) > 5000;
    if (bad) {
      return;
    }
  }
  mapAnchor.value = payload;
}

function onMap2dPick(payload: {
  type: 'community' | 'grid';
  items: Map2DPoint[];
  code?: string;
  name?: string;
  formalHeatGrid?: boolean;
}) {
  if (payload.type === 'community' && payload.items.length) {
    const first = payload.items[0];
    syncMapOffset();
    // 定位高亮（不改筛选）
    map2dRef.value?.locateCommunity?.(first.id, first.name);
    mapPickDetail.value = {
      kind: 'community',
      communityCode: first.id,
      gridCode: first.gridId ?? null,
      name: first.name,
      overlaps: payload.items.slice(1).map((p) => p.name).filter(Boolean),
    };
    return;
  }
  if (payload.type === 'grid' && payload.code) {
    map2dRef.value?.locateGrid?.(payload.code);
    mapPickDetail.value = {
      kind: 'grid',
      adminGridCode: payload.code,
      name: payload.name || payload.code,
      formalHeatGrid: payload.formalHeatGrid,
    };
  }
}

/** 二维视图状态条文案：底图是否真实 CIM、边界来源，全部如实呈现 */
const map2dBasemapText = computed(() => {
  const s = map2dStatus.value;
  if (!s) return '底图探测中…';
  return s.basemap;
});
const map2dBoundaryText = computed(() => map2dStatus.value?.boundary ?? '边界加载中…');
const map2dTone = computed(() => {
  const s = map2dStatus.value;
  if (!s) return 'is-off';
  return s.cimOk ? 'is-loaded' : 'is-unreachable';
});

/** 3D 底图模式：`?basemap=proxy|native|stitch|arcgis|off`（默认 proxy=第三方 CIM 网关；?basemap=native 仍可强制官方路由） */
const basemapOn = (() => {
  const m = /[?&]basemap=(proxy|native|stitch|arcgis|off)/.exec(location.hash);
  return (m?.[1] as 'proxy' | 'native' | 'stitch' | 'arcgis' | 'off') ?? 'proxy';
})();
/** 最近一次点击拾取到的楼栋信息（真实 S3M 属性；未命中则为空） */
const pickInfo = ref('');

function onInline3dPick(payload: any) {
  const a = payload?.attributes as Record<string, unknown> | null | undefined;
  if (!a) {
    pickInfo.value = payload?.reason ? `未取到属性（${payload.reason}）` : '';
    return;
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = a[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return '';
  };
  const name = pick('fwjzmc', 'bmid') || '未命名建筑';
  const addr = pick('tybzdz');
  const floors = pick('dscs');
  const height = pick('jzgd');
  const kind = pick('jzlb');
  pickInfo.value = [
    name,
    addr ? `地址 ${addr}` : '',
    floors ? `地上 ${floors} 层` : '',
    height ? `高 ${height}m` : '',
    kind ? `类别 ${kind}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
function onInline3dStatus(payload: Inline3dStatusView) {
  inline3dStatus.value = payload;
}

const inline3dLabel = computed(() => {
  switch (inline3dStatus.value?.phase) {
    case 'ready':
      return '已渲染';
    case 'error':
      return '加载失败';
    case 'loading':
      return '加载中';
    default:
      return '引擎加载中';
  }
});
const inline3dTone = computed(() =>
  inline3dStatus.value?.phase === 'ready' ? 'is-loaded' : inline3dStatus.value?.phase === 'error' ? 'is-unreachable' : 'is-off'
);

/** 三维当前场景中文名（与 #/cim3d 的 10 个区县口径一致） */
const inlineSceneLabel = computed(() =>
  initScene === 'all' ? '全部区县' : findScene(initScene)?.district ?? initScene
);

/** 重新加载三维（销毁旧 viewer → 重建；用于瓦片/引擎偶发失败后的重试） */
function reloadInline3d() {
  inline3dStatus.value = null;
  inline3dKey.value += 1;
  showToast('已重建三维视图（旧 viewer 已销毁）');
}

/** 相机复位：按当前视图分别复位（二维回到城区默认视野、三维回到场景视角） */
function resetCamera() {
  if (viewMode.value === '2d') {
    map2dRef.value?.resetCamera?.();
    showToast('二维地图已复位到宜昌城区视野');
    return;
  }
  inline3dRef.value?.resetCamera?.();
  showToast('三维相机已复位到当前场景视角');
}

/* ------------------------------------------------ 中间地图区收敛：图层胶囊 + 浮层 */
/**
 * 中间地图区尽量干净：底图/诊断/图层信息收进一个默认收起的胶囊浮层。
 * 二维/三维各自保留左上角小状态卡（三维：已渲染/底图/小区点位；二维：底图/边界/落图数量）。
 */
const layersOpen = ref(false);
const layersCapsuleText = computed(() =>
  viewMode.value === '2d' ? `二维 · ${map2dStatus.value ? (map2dStatus.value.cimOk ? 'CIM 影像' : '影像不可达') : '加载中'}` : `三维 · ${inline3dLabel.value}`
);
const layersCapsuleTone = computed(() => (viewMode.value === '2d' ? map2dTone.value : inline3dTone.value));
const inline3dCommunity = computed(() => inline3dStatus.value?.community ?? '未上报（引擎未就绪）');
const inline3dTuning = computed(() => inline3dStatus.value?.tuning ?? '未生效（底图未加载）');
const inline3dBasemapShort = computed(() => inline3dStatus.value?.basemapShort ?? '未上报（引擎未就绪）');

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  // Esc 逐层关闭：先关最上层的停水停气/改造详情，再关图层浮层
  if (shutdownPick.value) {
    closeShutdownPick();
    return;
  }
  if (pipelinePick.value) {
    closePipelinePick();
    return;
  }
  if (layersOpen.value) layersOpen.value = false;
}

/* ------------------------------------------------ 左右两栏收起（localStorage 记忆） */

type SideKey = 'left' | 'right';
const SIDE_STORAGE: Record<SideKey, string> = {
  left: 'accept.side.left.collapsed',
  right: 'accept.side.right.collapsed',
};

function readSideCollapsed(side: SideKey): boolean {
  try {
    return localStorage.getItem(SIDE_STORAGE[side]) === '1';
  } catch {
    return false;
  }
}

function writeSideCollapsed(side: SideKey, collapsed: boolean) {
  try {
    localStorage.setItem(SIDE_STORAGE[side], collapsed ? '1' : '0');
  } catch {
    /* 隐私模式/无 localStorage 时忽略，仅本会话生效 */
  }
}

/** 演示直达：?collapse=both|left|right（截图/评审用）；否则读 localStorage */
const initCollapse = q.get('collapse');
const leftCollapsed = ref(
  initCollapse === 'both' || initCollapse === 'left' ? true : readSideCollapsed('left')
);
const rightCollapsed = ref(
  initCollapse === 'both' || initCollapse === 'right' ? true : readSideCollapsed('right')
);

/**
 * 收起/展开后刷新地图视口。
 * OpenLayers 的 canvas 尺寸不会自动跟随 DOM 布局变化，必须显式 map.updateSize()，
 * 否则底图/热力瓦片会错位；等 180ms 收起动效结束再调用，避免拿到中间态尺寸。
 */
function refreshMapSize() {
  void nextTick(() => {
    window.setTimeout(() => {
      inline3dRef.value?.resize?.();
    }, 200);
  });
}

function toggleSide(side: SideKey) {
  if (side === 'left') {
    leftCollapsed.value = !leftCollapsed.value;
    writeSideCollapsed('left', leftCollapsed.value);
  } else {
    rightCollapsed.value = !rightCollapsed.value;
    writeSideCollapsed('right', rightCollapsed.value);
  }
  refreshMapSize();
}

function focusForQuery(query: DrillQuery) {
  /**
   * 数据项点击 → 地图联动。
   * 二维视图：把区县/网格/小区筛选落到筛选条，由 Map2DView 内部 watch 完成 flyTo 与高亮。
   * 三维视图：调 InlineCesiumView 暴露的相机飞行方法（flyToLonLat / flyToPoints）。
   * 两侧共用同一份 spatialPoints（抖动坐标），因此定位到的位置完全一致。
   */
  if (viewMode.value === '2d') {
    // ② 网格：直接把网格筛选落到地图，组件 watch 会飞到该网格
    if (query.gridCode) {
      adminGridFilter.value = query.gridCode;
      districtFilter.value = '';
      applyQuery();
      return;
    }
    // ③ 区县：按区县筛选，组件 watch 飞到该区县范围
    if (query.districtCode) {
      adminGridFilter.value = '';
      districtFilter.value = query.districtCode;
      applyQuery();
      return;
    }
    /**
     * ① 小区：**只定位、不筛选**。
     *
     * 用户明确反馈：「高频诉求小区效果不对，不是筛选，应该是到具体的位置，
     * 需要看明细才展开明细」。原实现点一个小区就写 communityFilter + applyQuery()，
     * 整屏数据被收窄成一个小区 —— 那不是「定位」，是「过滤」。
     *
     * 现在改为调用地图的 locateCommunity()：只飞视野 + 打光环高亮，
     * 筛选条件与面板数据完全不变；明细由调用方按需（用户点「明细」）再打开。
     */
    const ok2d = (map2dRef.value as { locateCommunity?: (c?: string | null, n?: string | null) => boolean } | null)
      ?.locateCommunity?.(query.communityCode, query.communityName);
    if (ok2d) return;
    // 该小区在当前数据里没有点位（可能被区县/网格筛选掉）：如实提示，不假装定位成功
    if (query.communityCode || query.communityName) {
      showToast(`未在当前数据中找到「${query.communityName ?? query.communityCode}」的点位，无法定位`);
    }
    // ④ 类型/指标类无空间锚点：保持当前视角，不虚构位置
    return;
  }

  const pts = spatialPoints.value as any[];
  const view = inline3dRef.value as any;
  if (!pts.length || !view) return;
  // ① 小区：编码或名称命中
  const hit = pts.find((p) => (query.communityCode && p.id === query.communityCode) || (query.communityName && (p.name === query.communityName || p.id === query.communityName)));
  if (hit) { view.flyToLonLat?.(hit.longitude, hit.latitude, 1800); return; }
  // ② 网格：同网格小区质心
  if (query.gridCode) {
    const g = pts.filter((p) => p.gridId === query.gridCode);
    if (g.length) { view.flyToPoints?.(g, 2400); return; }
  }
  // ③ 区县：网格码前 6 位 = 区县码
  if (query.districtCode) {
    const d = pts.filter((p) => String(p.gridId ?? "").startsWith(query.districtCode as string));
    if (d.length) { view.flyToPoints?.(d, 3200); return; }
  }
  // ④ 类型/指标类无空间锚点：保持当前视角，不虚构位置
}

function handleDrill(query: DrillQuery) {
  drawerKey.value = null;
  // 类型分布点击 → 区域环按该类型过滤（不改变全局分类筛选）
  if (query.typeId) activeTypeCode.value = query.typeId;

  /**
   * 小区类点击（带 communityCode / communityName）与其它类型区分处理：
   *
   *   小区 → **只定位**：地图飞过去 + 光环高亮，**不打开明细抽屉**。
   *          用户要看明细时，点卡片底部「明细」或地图点位悬停详情自行展开。
   *   其它 → 原有行为：地图联动 + 打开明细抽屉。
   *
   * 依据用户反馈：「高频诉求小区…不是筛选应该是到具体的位置，需要看明细才展开明细」。
   */
  const isCommunity = Boolean(query.communityCode || query.communityName);
  focusForQuery(query);
  if (isCommunity) {
    showToast(`已定位小区：${query.communityName ?? query.communityCode}`);
    return;
  }
  openDrill(query);
}

/**
 * 小区点击 → 只定位（卡片行主体的 @locate 事件）。
 *
 * 与 handleDrill 的区别：**绝不开启明细抽屉**，只做地图定位。
 * 明细由 openCommunityDrill 单独处理（卡片行尾「明细」按钮触发）。
 */
/**
 * 高频小区列表点击 → **飞到该小区 + 自动弹出详情浮层**。
 *
 * 用户要求：「点击高频小区应该飞过去然后自动展示窗体」。
 *   ① 地图飞到该小区点位并打光环（locateCommunity 内部完成）
 *   ② 同时把浮层数据填好，等地图动画结束、锚点回报后浮层自动出现在点位旁边
 *   ③ 全程不改筛选、不动左右列表数字
 */
function handleCommunityLocate(query: DrillQuery) {
  drawerKey.value = null;
  syncMapOffset();

  if (viewMode.value === '2d') {
    const code = query.communityCode ?? query.communityName ?? '';
    // 先在当前点位数据里找该小区所属网格，用于浮层展示
    const hit = (map2dPoints.value as Map2DPoint[]).find(
      (p) =>
        (query.communityCode && String(p.id) === String(query.communityCode)) ||
        (query.communityName && String(p.name) === String(query.communityName)),
    );

    // ① 飞过去（地图内部同时打高亮、回报锚点）
    const ok = map2dRef.value?.locateCommunity?.(
      query.communityCode ?? hit?.id,
      query.communityName ?? hit?.name,
    );

    // ② 弹出浮层（无论定位是否命中都弹：命中则贴点位，未命中则落在安全位并如实说明）
    mapPickDetail.value = {
      kind: 'community',
      communityCode: query.communityCode ?? hit?.id ?? null,
      gridCode: hit?.gridId ?? null,
      name: query.communityName ?? hit?.name ?? code,
      overlaps: [],
    };
    if (!ok) {
      mapAnchor.value = null;
      showToast(`未在当前数据中找到「${query.communityName ?? code}」的点位，已显示该小区的诉求数据`);
    }
    return;
  }

  // 三维视图：沿用原有相机飞行逻辑
  focusForQuery(query);
}

/**
 * 小区的「看明细」显式入口（卡片行尾「明细」按钮触发）。
 *
 * 与「点一下小区就定位」分开：只有用户明确要看明细时才展开，避免误操作把整屏数据收窄。
 */
function openCommunityDrill(query: DrillQuery) {
  drawerKey.value = null;
  openDrill(query);
}

/** 抽屉内「定位」类点击：三维模式下只打开同条件明细（不做二维网格定位） */
function handleDrawerLocate(payload: { gridCode: string; query: DrillQuery }) {
  drawerKey.value = null;
  selectedMonth.value = null;
  openDrill(payload.query);
  showToast('需网格空间数据，当前以三维展示：已打开同条件明细（不做网格定位）');
}

function handleOverviewDrill(payload: { metricKey?: MetricKey; title: string; source: string; industry: IndustryFilter }) {
  focusForQuery({ source: payload.source, title: payload.title, period: period.value, industry: payload.industry, metricKey: payload.metricKey });
  openDrill({ ...payload, period: period.value });
  showToast(`已打开明细：${payload.title}`);
}

/* ---------------------------------------------------------------- 右栏三卡联动 */

/** 右②点区：统计面板收窄（三维地图不叠加二维区县高亮） */
function onDistrictSelect(payload: { districtCode: string; name: string }) {
  districtFilter.value = payload.districtCode;
  selectedMonth.value = null;
  setDistrict(payload.districtCode);
  focusForQuery({ source: '区域分布', title: payload.name, period: period.value, industry: industry.value, districtCode: payload.districtCode });
  showToast(`统计已收窄到 ${payload.name || '该区'}：左/右面板同步收窄（三维视图保持白模浏览）`);
}

function clearDistrictScope() {
  districtFilter.value = '';
  setDistrict(null);
  showToast('已清除区收窄：恢复全域统计');
}

/** 右②点「未定位」：只打开明细，不在图上定位（不虚构坐标） */
function drillUnlocated() {
  drawerKey.value = null;
  openDrill({
    source: '验收大屏 · 区域分布 · 未定位（不定位地图）',
    title: '未定位件明细（单列，不参与六区着色）',
    period: period.value,
    industry: industry.value,
  });
  showToast('未定位件：只打开明细，不在地图上定位（不虚构坐标）');
}

/** 右①点月：同月明细（真实接口按 month 过滤明细；三维白模不做网格热力联动） */
function onMonthDrill(query: DrillQuery) {
  selectedMonth.value = query.month ?? null;
  handleDrill(query);
  showToast(`已按 2026 年 ${query.month ?? 1} 月筛选明细（真实接口按 month 过滤；三维白模仅浏览）`);
}

// 演示直达：?month=8 打开 8 月同月明细；?drill=unlocated 打开未定位明细（不定位地图）
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  // 空间点位与网格件数：大屏统计走 useStatScreen，空间数据需单独取一次
  void loadSpatial();
  // 网格名称（下拉里显示「名称（编码）」，便于和社区编码对照）；失败退回纯编码
  void loadGridNames();
  /**
   * 三维懒加载：仅在三维视图下才挂 Cesium（默认二维视图下完全不加载三维引擎，
   * 这是二维视图「加载快」的关键 —— 首屏不拉 iClient3D/S3M/瓦片拼接那一整套）。
   * 切到三维时由 setViewMode 触发；`?fast3d=1` 可跳过延迟立即挂载。
   */
  if (viewMode.value === '3d') {
    const fast3d = /[?&]fast3d=1/.test(location.hash);
    if (fast3d) {
      show3d.value = true;
    } else {
      const start = () => window.setTimeout(() => {
        show3d.value = true;
      }, 120);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(start));
      else start();
    }
  }
  if (initMonth) {
    window.setTimeout(() => {
      onMonthDrill({
        source: 'URL 演示 · 月度趋势',
        title: `2026 年 ${initMonth} 月 · 同月诉求明细`,
        period: period.value,
        industry: industry.value,
        month: initMonth,
      });
    }, 600);
  } else if (initDrill === 'unlocated') {
    window.setTimeout(() => drillUnlocated(), 600);
  }
});

/* ------------------------------------------------------------------ 底部按钮条 / 抽屉 */

const drawerKey = ref<AcceptDrawerKey | null>(((q.get('drawer') as AcceptDrawerKey | null) ?? null));
function openDrawer(key: AcceptDrawerKey) {
  drawerKey.value = key;
}

/** 网格对比/冬夏研判按标书接真实主账接口（面板内自行取数），这里只负责打开抽屉 */
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      // 作用于三维地图容器（不是整页；面板仍按大屏布局）
      const mapEl = document.querySelector('.inline3d') as HTMLElement | null;
      await (mapEl ?? document.documentElement).requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    showToast('当前环境不允许全屏（headless/权限受限）');
  }
}

/* --------------------------------------------------- 头部按钮（真实数据源） */


function onLogin() {
  loginError.value = '';
  loginOpen.value = true;
}

async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  loginError.value = '';
  try {
    await realLogin(loginUser.value.trim(), loginPw.value);
    loginOpen.value = false;
    loginPw.value = '';
    void map2dRef.value?.refreshCimBoundary();
    showToast('已登录：加载真实诉求数据（token 仅保存在 sessionStorage）');
    await reload();
    void reloadMonthly();
  } catch (e) {
    // 后端 401/403 的原始 message 直接展示，不掩盖真实错误
    loginError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loginBusy.value = false;
  }
}
</script>

<template>
  <div class="stat-viewport">
    <div class="stat-canvas" :style="{ transform: `scale(${scale})` }">
      <div class="stat-root accept-root" :class="{ 'no-motion': noMotion, 'is-2d': viewMode === '2d', 'is-3d': viewMode === '3d' }">
        <!--
          地图区：二维 / 三维互斥挂载（v-if），保证同一时刻只跑一个引擎。
          二维（默认）：CIM 2D 影像 + 小区点位 + 网格着色，标书 1.2 节要求的「网格图层 + 地图联动」。
          三维（可切换）：内联 Cesium 白模，逻辑与二维同构（同点位/同筛选/同拾取回调）。
        -->
        <Map2DView
          v-if="viewMode === '2d'"
          :key="map2dKey"
          ref="map2dRef"
          :points="map2dPoints"
          :grid-metrics="map2dGridMetrics"
          :heat="spatialHeat"
          :heat-loading="spatialState === 'loading'"
          :district-code="districtCode ?? ''"
          :grid-code="gridCode ?? ''"
          :community-code="communityCode"
          @status="onMap2dStatus"
          @pick="onMap2dPick"
          @anchor="onMapAnchor"
          @pipeline-pick="onPipelinePick"
          @pipeline-clear="closePipelinePick"
          @shutdown-pick="onShutdownPick"
          @shutdown-clear="closeShutdownPick"
        />
        <InlineCesiumView
          v-else-if="show3d"
          :key="inline3dKey"
          ref="inline3dRef"
          :scene="initScene"
          :basemap="basemapOn"
          :points="inline3dPoints"
          @status="onInline3dStatus"
          @pick="onInline3dPick"
        />
        <div v-else class="accept-3d-loading"><i></i><span>三维白模加载中…</span></div>

        <div class="accept-bg accept-bg--top"></div>
        <div class="accept-bg accept-bg--bottom"></div>

        <!-- 顶部标题栏 -->
        <header class="accept-header">
          <div class="accept-header__side">
            <span class="accept-header__date">{{ todayText }}</span>
            <span class="accept-header__cutoff">{{ cutoffText }}</span>
          </div>
          <div class="accept-header__center">
            <h1>宜昌市供气供水行业诉求一张图</h1>
          </div>
          <div class="accept-header__side accept-header__side--right">
            <!-- 地图视图切换：二维（默认）/ 三维 -->
            <div class="accept-viewswitch" role="group" aria-label="地图视图切换">
              <button
                type="button"
                :class="{ 'is-active': viewMode === '2d' }"
                title="二维：CIM 影像 + 网格着色 + 小区点位（默认）"
                @click="setViewMode('2d')"
              >
                二维
              </button>
              <button
                type="button"
                :class="{ 'is-active': viewMode === '3d' }"
                title="三维：CIM 影像 + S3M 白模"
                @click="setViewMode('3d')"
              >
                三维
              </button>
            </div>
            <button type="button" @click="onLogin">登录</button>
          </div>
        </header>

        <!-- 三板块 Tab -->
        <nav class="accept-tabs" aria-label="业务板块切换">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            :class="{ 'is-active': tab === t.key }"
            @click="setTab(t.key)"
          >
            {{ t.label }}
          </button>
        </nav>

        <!--
          筛选条（按标书口径分层）
          标书 1.2.2 / 1.2.9 明确依赖的只有两项：
            · 时间范围 —— 1.2.2「当前选取时间段」、1.2.9「以时间维度查询往年数据」
            · 诉求类型 —— 1.2.2「根据选取的诉求统计类型 / 根据选取诉求类型」
          区域 / 企业 / 网格 / 小区 是标书未要求、实现方增加的增强项，
          它们本来就能在地图上点选（点区县、点网格、点高频小区都会联动），
          因此收进「更多筛选」，默认收起，避免挤压地图与控制区。
        -->
        <div class="accept-filters">
          <label>开始 <input v-model="fromDate" type="date" /></label>
          <label>结束 <input v-model="toDate" type="date" /></label>
          <label title="分类筛选按字典小类（g01…w08，已排除停用项）；标书 1.2.2 依赖「选取诉求类型」口径">
            分类
            <select v-model="categoryFilter">
              <option value="">全部分类</option>
              <option v-for="c in categoryOptions" :key="c.code" :value="c.code">{{ c.name }}</option>
            </select>
          </label>
          <button type="button" class="is-primary" @click="applyQuery">查询</button>
          <button type="button" @click="resetFilters">重置</button>
          <button
            type="button"
            class="accept-filters__more"
            :aria-expanded="moreFiltersOpen"
            :title="moreFiltersOpen ? '收起更多筛选' : '展开更多筛选（区域 / 企业 / 网格 / 小区）'"
            @click="moreFiltersOpen = !moreFiltersOpen"
          >
            更多筛选{{ moreFilterBadge ? `（${moreFilterBadge}）` : '' }}
            <span class="accept-filters__caret" :class="{ 'is-open': moreFiltersOpen }">▾</span>
          </button>
        </div>

        <!-- 更多筛选（标书未要求，属增强项；默认收起） -->
        <div v-if="moreFiltersOpen" class="accept-filters accept-filters--more">
          <label>
            区域
            <select v-model="districtFilter">
              <option value="">全部区划</option>
              <option v-for="d in districtOptions" :key="d.districtCode" :value="d.districtCode">{{ d.name }}</option>
            </select>
          </label>
          <label title="企业筛选按企业编码，来自企业主数据（12 家）">
            企业
            <select v-model="enterpriseFilter">
              <option value="">全部企业</option>
              <option v-for="e in enterpriseOptions" :key="e.code" :value="e.code">{{ e.name }}</option>
            </select>
          </label>
          <label title="网格筛选按 charts.adminGrid 的网格编码">
            网格
            <select v-model="adminGridFilter">
              <option value="">全部网格</option>
              <option v-for="g in adminGridOptions" :key="g.code" :value="g.code">{{ gridOptionLabel(g.code) }}</option>
            </select>
          </label>
          <label title="小区筛选按 spatial.communities 的小区 id（名称展示）">
            小区
            <select v-model="communityFilter">
              <option value="">全部小区</option>
              <option v-for="c in communityOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
              <option v-if="communityOptionTotal > communityOptions.length" disabled>
                其余 {{ communityOptionTotal - communityOptions.length }} 个小区后续用搜索补
              </option>
            </select>
          </label>
        </div>

        <!-- 左栏三卡（可收起；收起后地图区露出、不留空白） -->
        <aside class="accept-side accept-side--left" :class="{ 'is-collapsed': leftCollapsed }" aria-label="左栏统计卡片">
          <button
            type="button"
            class="accept-side__toggle accept-side__toggle--left"
            :title="leftCollapsed ? '展开左栏' : '收起左栏'"
            :aria-expanded="!leftCollapsed"
            @click="toggleSide('left')"
          >
            {{ leftCollapsed ? '›' : '‹' }}
          </button>
          <OverviewCard :overview="overview" :industry="industry" :period-meta="displayPeriodMeta" @retry="reload" @drill="handleOverviewDrill" />
          <TypeDistributionCard
            :supply="supply"
            :industry="industry"
            :period-meta="displayPeriodMeta"
            :empty-title="REAL_GAP.typeTitle"
            :empty-text="REAL_GAP.typeText"
            @retry="reload"
            @drill="handleDrill"
          />
          <EnterpriseRatioCard
            :supply="supply"
            :industry="industry"
            :period-meta="displayPeriodMeta"
            :na-title="REAL_GAP.entTitle"
            :na-text="REAL_GAP.entText"
            @retry="reload"
            @drill="handleDrill"
          />
        </aside>

        <!-- 右栏三卡：月度趋势 / 区域分布 / 高频小区（可收起） -->
        <aside class="accept-side accept-side--right" :class="{ 'is-collapsed': rightCollapsed }" aria-label="右栏统计卡片">
          <button
            type="button"
            class="accept-side__toggle accept-side__toggle--right"
            :title="rightCollapsed ? '展开右栏' : '收起右栏'"
            :aria-expanded="!rightCollapsed"
            @click="toggleSide('right')"
          >
            {{ rightCollapsed ? '‹' : '›' }}
          </button>
          <MonthlyTrendCard
            :water="monthlyWater"
            :gas="monthlyGas"
            :industry="industry"
            :period-meta="displayPeriodMeta"
            :empty-title="REAL_GAP.monthlyTitle"
            :empty-text="REAL_GAP.monthlyText"
            @retry="reloadMonthly"
            @drill="onMonthDrill"
          />
          <DistrictDistributionCard
            :supply="supply"
            :industry="industry"
            :period-meta="displayPeriodMeta"
            :selected-district="districtCode"
            :selected-type-id="activeTypeCode"
            :selected-type-name="activeTypeName"
            @retry="reload"
            @select-district="onDistrictSelect"
            @clear-district="clearDistrictScope"
            @drill-unlocated="drillUnlocated"
          />
          <CommunityTopCard
            :supply="supply"
            :industry="industry"
            :period-meta="displayPeriodMeta"
            :empty-title="communityEmptyTitle"
            :empty-text="communityEmptyText"
            @retry="reload"
            @drill="handleDrill"
            @locate="handleCommunityLocate"
            @detail="openCommunityDrill"
          />
        </aside>

        <!-- 地图区收敛：底图/图例/图层说明/图层开关 → 一个默认收起的胶囊（点开才是浮层） -->
        <div class="accept-layersbar">
          <button
            type="button"
            class="accept-layersbar__btn"
            :class="{ 'is-open': layersOpen }"
            :aria-expanded="layersOpen"
            title="三维图层诊断（默认收起，点开看详情；Esc 关闭）"
            @click="layersOpen = !layersOpen"
          >
            <i class="accept-layersbar__dot" :class="layersCapsuleTone"></i>
            <span>图层 · {{ layersCapsuleText }}</span>
            <em>{{ layersOpen ? '▴' : '▾' }}</em>
          </button>
        </div>

        <div v-if="layersOpen" class="accept-layerpop" role="dialog" aria-label="三维图层诊断">
          <header class="accept-layerpop__head">
            <b>三维图层诊断</b>
            <span class="accept-layerpop__sub">三维白模 · 纯浏览</span>
            <button type="button" class="accept-layerpop__close" title="收起（Esc）" @click="layersOpen = false">×</button>
          </header>

          <!-- 底图 / 三维状态详情（仅 3D） -->
          <section class="accept-layerpop__block">
            <div class="accept-layerpop__row">
              <span class="accept-layerpop__label">三维白模</span>
              <span class="accept-cim__pill" :class="inline3dTone">{{ inline3dLabel }}</span>
              <button type="button" class="accept-cim__retry" title="销毁并重建三维视图" @click="reloadInline3d">重新加载</button>
            </div>
            <p class="accept-cim__main">{{ inline3dStatus?.text ?? '三维引擎加载中（超图 Cesium / S3M）…' }}</p>
            <p v-if="inline3dStatus?.detail" class="accept-cim__line">{{ inline3dStatus.detail }}</p>
            <p class="accept-cim__line accept-cim__line--basemap">{{ inline3dStatus?.basemap ?? '未上报（引擎未就绪）' }}</p>
            <p class="accept-cim__line">调色生效值：{{ inline3dTuning }}</p>
            <p v-if="inline3dStatus?.basemapDiag" class="accept-cim__line accept-cim__line--diag">底图诊断：{{ inline3dStatus.basemapDiag }}</p>
            <p v-if="inline3dStatus?.schema" class="accept-cim__line">{{ inline3dStatus.schema }}</p>
            <p v-if="pickInfo" class="accept-cim__line accept-cim__line--pick">已拾取：{{ pickInfo }}</p>
          </section>

          <!-- 三维交互与场景 -->
          <section class="accept-layerpop__block">
            <div class="accept-layerpop__row">
              <span class="accept-layerpop__label">三维交互</span>
              <span class="accept-layerpop__meta">场景 {{ inlineSceneLabel }}</span>
            </div>
            <p class="accept-cim__line">小区点位：{{ inline3dCommunity }}</p>
            <p class="accept-cim__line">操作：拖动旋转 / 滚轮缩放；点击小区点位 → 相机 flyTo 到该点；点击白模楼栋 → 读取 S3M 属性。</p>
            <p class="accept-cim__line accept-cim__line--wmts">
              白模为抖动几何（jitter 有意偏移），业务点位为平台脱敏偏移坐标，仅作近似定位。
            </p>
          </section>

          <!-- 数据与快照 -->
          <section class="accept-layerpop__block">
            <div class="accept-layerpop__row">
              <span class="accept-layerpop__label">数据与快照</span>
            </div>
            <span v-if="meta?.missingNote" class="accept-mapmeta__state accept-mapmeta__gap">{{ meta.missingNote }}</span>
            <span class="accept-mapmeta__state">快照 {{ meta?.snapshotId ?? '—' }}<template v-if="refreshing"> · 刷新中…</template></span>
            <span v-if="selectedMonth" class="accept-mapmeta__state">
              月份筛选：2026 年 {{ selectedMonth }} 月（明细口径；三维白模仅浏览）
              <button type="button" class="accept-cim__retry" @click="selectedMonth = null">清除</button>
            </span>
          </section>
        </div>

        <!--
          二维/三维技术状态卡已按客户要求移除。
          原卡展示「CIM 网关地址 / 边界 N / 落图 N 小区 · N 网格 / 业务主表 / 详情」，
          这些是实现侧的诊断信息，对业务使用者和甲方验收都没有意义，
          而且数据异常时会显示「边界 0 · 落图 0 小区」反而像系统坏了。
          底图不可达、坐标偏移等**真正需要用户知道**的提示，仍由地图上的
          警告条（.map2d__coordwarn / 边界缺失提示）承担，不丢信息。
        -->
        <section v-if="viewMode === '3d'" class="accept-3dmini" aria-label="三维白模状态">
          <div class="accept-3dmini__head">
            <span class="accept-3dmini__title">三维白模</span>
            <span class="accept-cim__pill" :class="inline3dTone">{{ inline3dLabel }}</span>
            <button type="button" class="accept-cim__retry" title="销毁并重建三维视图" @click="reloadInline3d">重载</button>
          </div>
          <p class="accept-3dmini__main">{{ inline3dStatus?.text ?? '三维引擎加载中（超图 Cesium / S3M）…' }}</p>
          <p class="accept-3dmini__line">底图：{{ inline3dBasemapShort }}</p>
          <p class="accept-3dmini__line">小区点位：{{ inline3dCommunity }}</p>
        </section>

        <!-- 管线改造事件详情（标书 1.2.7）：点击地图上的改造网格后弹出，浮在地图下方避免被顶栏压住 -->
        <section v-if="pipelinePick" class="accept-pipeline" role="dialog" aria-modal="false" aria-label="管线改造事件">
          <header class="accept-pipeline__head">
            <b>管线改造事件</b>
            <span class="accept-pipeline__sub">标书 1.2.7 管线图层对接 · 点击网格查看改造事件</span>
            <button type="button" class="accept-pipeline__close" title="关闭（Esc）" @click="closePipelinePick">×</button>
          </header>
          <div class="accept-pipeline__body">
            <PipelinePanel
              :key="pipelinePick.gridCode"
              :grid-code="pipelinePick.gridCode"
              :grid-name="pipelinePick.gridName"
              :projects="pipelinePick.cell.projects"
              :by-business-type="pipelinePick.byBusinessType"
            />
          </div>
        </section>

        <!-- 停水停气事件详情（标书 1.2.6）：点击地图标识后弹出 -->
        <section v-if="shutdownPick" class="accept-shutdown" role="dialog" aria-modal="false" aria-label="停水停气事件">
          <header class="accept-shutdown__head">
            <b>停水停气事件</b>
            <span class="accept-shutdown__sub">标书 1.2.6 停水停气图层 · 点击标识查看事件</span>
            <button type="button" class="accept-shutdown__close" title="关闭（Esc）" @click="closeShutdownPick">×</button>
          </header>
          <div class="accept-shutdown__body">
            <ShutdownEventPanel
              :marker="shutdownPick.marker"
              :event="shutdownPick.event"
              :grid-total="shutdownPick.gridTotal"
              :highlighted-count="map2dRef?.shutdownHighlightedCount ?? 0"
              :grid-history="shutdownPick.gridHistory"
              :data-source="shutdownPick.dataSource"
              :data-source-note="shutdownPick.dataSourceNote"
              :snapshot="shutdownSnapshot"
              :snapshot-loading="spatialState === 'loading'"
              :snapshot-error="spatialError"
              @refresh="refreshShutdownSources"
            />
          </div>
        </section>

        <!-- 底部 7 按钮条 -->
        <div class="accept-actions" aria-label="地图与分析入口">
          <button type="button" @click="resetCamera">{{ viewMode === '2d' ? '地图复位' : '相机复位' }}</button>
          <button type="button" @click="toggleFullscreen">全屏</button>
          <button type="button" @click="openDrawer('compare')">网格对比</button>
          <button type="button" @click="openDrawer('warnings')">数据预警</button>
          <button type="button" @click="openDrawer('research')">冬夏研判</button>
          <button type="button" @click="openDrawer('events')">停供与施工</button>
          <button type="button" @click="openDrawer('analysis')">更多分析</button>
        </div>

        <!-- TOP3 跑马灯 -->
        <div class="accept-ticker-wrap">
          <AcceptTicker
            :top-types="topTypes"
            :period-meta="displayPeriodMeta"
            :industry="industry"
            :no-motion="noMotion"
            @retry="reload"
            @drill="handleDrill"
          />
        </div>

        <!-- 诉求动态（标书 1.2.3）：复用「更多分析」入口打开，三块均为同一次 bootstrap 数据 -->
        <div v-if="drawerKey === 'analysis'" class="accept-activity" role="dialog" aria-modal="true" aria-label="诉求动态">
          <div class="accept-activity__mask" @click="drawerKey = null"></div>
          <aside class="accept-activity__panel">
            <header class="accept-activity__head">
              <b>诉求动态</b>
              <span>标书 1.2.3 · 满意度 / 高峰时段 / 周变化 / 处理时长</span>
              <button type="button" @click="drawerKey = null">关闭 ×</button>
            </header>
            <div class="accept-activity__body">
              <SatisfactionCard :dynamic="dynamic" :period-meta="displayPeriodMeta" @retry="reload" />
              <HourlyPeakCard
                :dynamic="dynamic"
                :industry="industry"
                :period-meta="displayPeriodMeta"
                @retry="reload"
              />
              <WeekdayTrendCard
                :dynamic="dynamic"
                :industry="industry"
                :period-meta="displayPeriodMeta"
                @retry="reload"
              />
              <DurationBucketsCard :dynamic="dynamic" :period-meta="displayPeriodMeta" @retry="reload" />
            </div>
          </aside>
        </div>

        <!-- 抽屉：底部按钮打开（内容精简收纳，复用现有面板，不删原代码） -->
        <AcceptDrawer
          v-if="drawerKey && drawerKey !== 'analysis'"
          :drawer-key="drawerKey"
          :supply="supply"
          :dynamic="dynamic"
          :warnings="warnings"
          :research="research"
          :period-meta="displayPeriodMeta"
          :industry="industry"
          :forced-state="forcedState"
          :from-date="fromDate"
          :to-date="toDate"
          @close="drawerKey = null"
          @retry="reload"
          @drill="handleDrill"
          @locate="handleDrawerLocate"
        />

        <!-- 同条件诉求明细下钻（复用现有组件） -->
        <DrilldownDrawer
          :drill="drill"
          :period-meta="displayPeriodMeta"
          :page-size="pageSize"
          @close="closeDrill"
          @page="goDrillPage"
          @retry="() => goDrillPage(drill.data?.page ?? 1)"
        />

        <!--
    地图点击浮层：概况 + 前 10 条明细。
    独立于左右列表，点击地图不会改动任何筛选或面板数字。
  -->
  <MapPickPanel
    :anchor="mapAnchor"
    :map-offset="mapOffset"
    :detail="mapPickDetail"
    :query="mapPickQuery"
    @close="closeMapPick"
    @apply-filter="applyMapPickFilter"
    @open-drawer="openMapPickDrawer"
  />

  <div v-if="toastText" class="accept-toast" role="status">{{ toastText }}</div>

        <!-- 真实数据登录：打开页面若未登录自动弹出；token 只存 sessionStorage -->
        <div v-if="loginOpen" class="accept-login-shade" role="dialog" aria-label="真实数据登录">
          <form class="accept-login" @submit.prevent="submitLogin">
            <h2>登录诉求平台</h2>
            <p class="accept-login__hint">真实数据来自诉求平台（/api/v1），需登录后加载；未登录不展示任何数据。登录凭证只保存在 sessionStorage，不写死密码、不进 URL。</p>
            <label>
              <span>用户名</span>
              <input v-model="loginUser" autocomplete="username" placeholder="请输入用户名" required />
            </label>
            <label>
              <span>密码</span>
              <input v-model="loginPw" type="password" autocomplete="current-password" placeholder="请输入密码" required />
            </label>
            <p v-if="loginError" class="accept-login__err">{{ loginError }}</p>
            <div class="accept-login__actions">
              <button type="submit" :disabled="loginBusy">{{ loginBusy ? '登录中…' : '登录并加载真实数据' }}</button>
              <button type="button" @click="loginOpen = false; loginPw = ''">取消</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>










