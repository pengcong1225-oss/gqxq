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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import InlineCesiumView from '@/components/map/InlineCesiumView.vue';
import { useStatScreen } from '@/stats/useStatScreen';
import {
  CATEGORY_OPTIONS,
  ENTERPRISE_OPTIONS,
  hasRealSession,
  currentRealWindow,
  realAdminGridOptions,
  realCommunityOptions,
  realCommunityPoints,
  realLogin,
  setRealAsOf,
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
import { findScene } from '@/components/map/cim3d/scenes';
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
 * 三维加载场景：`?scene=<区县场景|all>` 选三维加载范围（默认城区 chengqu_jitter）。
 * 客户已明确「只保留 3D 不要二维」，页面固定内联 Cesium 三维，不再有 2D 视图。
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
  const w = currentRealWindow(period.value);
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
  tab.value = key;
  industry.value = industryOf(key);
  if (key === 'dynamic') {
    showToast('诉求动态：满意度 / 时长 / 周变化 / 高峰已收至「更多分析」抽屉，主屏只保留三张核心卡');
  }
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
/** 区域选项只来自真实接口（真实库有 14 个区县码；后端无数据时不补默认区划） */
const districtOptions = computed(() => supply.value.data?.district.items ?? []);
/** 企业选项：企业主数据 12 家（enterpriseCode） */
const enterpriseOptions = computed(() => ENTERPRISE_OPTIONS);
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
/** 分类选项：字典小类 g01…w08（已排除 g09 停用） */
const categoryOptions = computed(() => CATEGORY_OPTIONS);

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

function applyQuery() {
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
  void reload();
}

function resetFilters() {
  const [f, t] = rangeOf('30d');
  fromDate.value = f;
  toDate.value = t;
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
  showToast('已重置筛选：统计窗口 近30天 · 全域');
}

/* ------------------------------------------------------------------ 三维地图（唯一地图视图） */

const inline3dKey = ref(0);
/** 三维懒加载：先渲染左右面板与筛选条，再挂 Cesium（?fast3d=1 立即挂载） */
const show3d = ref(false);
const inline3dStatus = ref<Inline3dStatusView | null>(null);
const inline3dRef = ref<InstanceType<typeof InlineCesiumView> | null>(null);

/** 传给三维组件的小区点位：真实 bootstrap 到达后重算（依赖 meta/supply 触发响应式重绘） */
const inline3dPoints = computed(() => {
  // 依赖两个真实数据 ref，保证 bootstrap 晚到时 computed 会重新求值，组件 watch 随之重绘点位
  void meta.value?.snapshotId;
  void supply.value.data;
  return realCommunityPoints();
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

/** 相机复位：三维唯一地图视图的「地图复位」能力 */
function resetCamera() {
  inline3dRef.value?.resetCamera?.();
  showToast('三维相机已复位到当前场景视角');
}

/* ------------------------------------------------ 中间地图区收敛：三维图层胶囊 + 浮层 */
/**
 * 客户要求「中间尽量干净」：三维底图/诊断/图层信息收进一个默认收起的胶囊浮层；
 * 三维模式只保留左上角 3 行小状态卡（已渲染 / 底图 / 小区点位）。2D 图例/图层开关已随二维视图一并移除。
 */
const layersOpen = ref(false);
const layersCapsuleText = computed(() => `三维 · ${inline3dLabel.value}`);
const layersCapsuleTone = computed(() => inline3dTone.value);
const inline3dCommunity = computed(() => inline3dStatus.value?.community ?? '未上报（引擎未就绪）');
const inline3dTuning = computed(() => inline3dStatus.value?.tuning ?? '未生效（底图未加载）');
const inline3dBasemapShort = computed(() => inline3dStatus.value?.basemapShort ?? '未上报（引擎未就绪）');

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && layersOpen.value) layersOpen.value = false;
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
  /** 数据项点击 → 三维相机联动（坐标来自后端 spatial.communities，平台脱敏抖动坐标，仅近似定位） */
  const pts = realCommunityPoints() as any[];
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
  focusForQuery(query);
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
  // 三维懒加载：面板数据先渲染，再挂 Cesium（首屏更快；?fast3d=1 可立即挂载）
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
      <div class="stat-root accept-root is-3d" :class="{ 'no-motion': noMotion }">
        <!-- 唯一地图视图：内联三维白模（客户要求只保留 3D，不再挂载二维 OpenLayers） -->
        <InlineCesiumView
          v-if="show3d"
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

        <!-- 筛选条 -->
        <div class="accept-filters">
          <label>开始 <input v-model="fromDate" type="date" /></label>
          <label>结束 <input v-model="toDate" type="date" /></label>
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
              <option v-for="g in adminGridOptions" :key="g.code" :value="g.code">{{ g.code }}</option>
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
          <label title="分类筛选按字典小类（g01…w08，已排除停用项）">
            分类
            <select v-model="categoryFilter">
              <option value="">全部分类</option>
              <option v-for="c in categoryOptions" :key="c.code" :value="c.code">{{ c.name }}</option>
            </select>
          </label>
          <button type="button" class="is-primary" @click="applyQuery">查询</button>
          <button type="button" @click="resetFilters">重置</button>
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
            :empty-title="REAL_GAP.communityTitle"
            :empty-text="REAL_GAP.communityText"
            @retry="reload"
            @drill="handleDrill"
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

        <!-- 三维状态：左上角 3 行小状态卡（已渲染 / 底图 / 小区点位），详细诊断收进上面的浮层 -->
        <section class="accept-3dmini" aria-label="三维白模状态">
          <div class="accept-3dmini__head">
            <span class="accept-3dmini__title">三维白模</span>
            <span class="accept-cim__pill" :class="inline3dTone">{{ inline3dLabel }}</span>
            <button type="button" class="accept-cim__retry" title="销毁并重建三维视图" @click="reloadInline3d">重载</button>
          </div>
          <p class="accept-3dmini__main">{{ inline3dStatus?.text ?? '三维引擎加载中（超图 Cesium / S3M）…' }}</p>
          <p class="accept-3dmini__line">底图：{{ inline3dBasemapShort }}</p>
          <p class="accept-3dmini__line">小区点位：{{ inline3dCommunity }}</p>
        </section>

        <!-- 底部 7 按钮条 -->
        <div class="accept-actions" aria-label="三维地图与分析入口">
          <button type="button" @click="resetCamera">相机复位</button>
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










