/**
 * 统计大屏 · 数据装配（唯一的数据入口）
 *
 * - 所有面板共用同一份筛选状态（period / industry / snapshotId），与 04 文档 §6「全局只保留一份筛选状态」一致；
 * - 切换筛选 → 6 个接口并行重取 → 每个面板各自进入 loading / ready / empty / error；
 * - 请求带序号 token，快速切换时旧响应不会覆盖新状态；
 * - 下钻（dashboard/demands）单独一套状态，分页可切换。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
  SNAPSHOT_ID,
  ScreenApiError,
  fetchDemandDynamic,
  fetchDemands,
  fetchOverview,
  fetchResearchTop,
  fetchSupply,
  fetchTopTypes,
  fetchWarningList,
  setForcedState,
} from './api';
import { currentRealWindow } from './realSource';
import {
  PERIODS,
  type ApiResponse,
  type DemandDynamicData,
  type DemandListData,
  type DrillQuery,
  type ForcedState,
  type IndustryFilter,
  type OverviewData,
  type PanelState,
  type PeriodKey,
  type ResearchTopData,
  type ScreenFilters,
  type ScreenMeta,
  type ScopeGrid,
  type SupplyData,
  type TopTypesData,
  type WarningListData,
} from './types';

export interface DrillState {
  open: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: DemandListData | null;
  error: { code: number; message: string; traceId: string } | null;
  query: DrillQuery | null;
}

const PAGE_SIZE = 8;

const loadingState = <T>(prev: PanelState<T>): PanelState<T> => ({
  status: 'loading',
  data: prev.data,
  error: null,
});

const emptyOverview = (_d: OverviewData) => false;
const emptySupply = (d: SupplyData) => d.typeStats.length === 0 && d.communityTop.items.length === 0 && d.total.value === null;
const emptyDynamic = (_d: DemandDynamicData) => false;
const emptyTopTypes = (d: TopTypesData) => d.items.length === 0;
const emptyWarnings = (d: WarningListData) => d.items.length === 0;
const emptyResearch = (d: ResearchTopData) => d.items.length === 0;

function toApiError(reason: unknown): ScreenApiError {
  if (reason instanceof ScreenApiError) return reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  return new ScreenApiError(2002, `外部服务不可用：${message}`);
}

export interface UseStatScreenOptions {
  initialPeriod?: PeriodKey;
  initialIndustry?: IndustryFilter;
  initialState?: ForcedState;
  initialGrid?: string | null;
  initialDistrict?: string | null;
  initialEnterprise?: string | null;
  initialCommunity?: string | null;
  initialCategory?: string | null;
}

export function useStatScreen(options: UseStatScreenOptions = {}) {
  const period = ref<PeriodKey>(options.initialPeriod ?? '30d');
  const industry = ref<IndustryFilter>(options.initialIndustry ?? 'ALL');
  const forcedState = ref<ForcedState>(options.initialState ?? 'normal');
  /** 地图下钻范围：null = 全域；选中网格后所有面板收窄并共用同一 snapshotId */
  const gridCode = ref<string | null>(options.initialGrid ?? null);
  /** 区县收窄：点击区域分布/筛选条区域后面板收窄到该区（与 gridCode 互斥） */
  const districtCode = ref<string | null>(options.initialDistrict ?? null);
  /** 企业筛选（enterpriseCode，企业主数据 12 家） */
  const enterpriseCode = ref<string | null>(options.initialEnterprise ?? null);
  /** 小区筛选（communityCode，spatial.communities 的 id） */
  const communityCode = ref<string | null>(options.initialCommunity ?? null);
  /** 分类筛选（categoryCode，字典小类 g01…w08） */
  const categoryCode = ref<string | null>(options.initialCategory ?? null);
  const selectedWindow = ref<ScreenFilters['window']>(undefined);
  const appliedWindow = computed(() => selectedWindow.value ?? currentRealWindow(period.value));
  const appliedFilters = computed<ScreenFilters>(() => ({
    period: period.value,
    industry: industry.value,
    snapshotId: SNAPSHOT_ID,
    window: appliedWindow.value,
    gridCode: gridCode.value,
    districtCode: districtCode.value,
    enterpriseCode: enterpriseCode.value,
    communityCode: communityCode.value,
    categoryCode: categoryCode.value,
  }));
  /** 真实库缺行政网格主数据：网格范围元数据不可用，selectedGrid 恒为 null（不再依赖演示网格表） */
  const selectedGrid = computed<ScopeGrid | null>(() => null);

  const overview = ref<PanelState<OverviewData>>({ status: 'loading', data: null, error: null });
  const supply = ref<PanelState<SupplyData>>({ status: 'loading', data: null, error: null });
  const dynamic = ref<PanelState<DemandDynamicData>>({ status: 'loading', data: null, error: null });
  const topTypes = ref<PanelState<TopTypesData>>({ status: 'loading', data: null, error: null });
  const warnings = ref<PanelState<WarningListData>>({ status: 'loading', data: null, error: null });
  const research = ref<PanelState<ResearchTopData>>({ status: 'loading', data: null, error: null });

  const drill = ref<DrillState>({ open: false, status: 'idle', data: null, error: null, query: null });
  const lastLoadedAt = ref<Date | null>(null);

  const meta = computed<ScreenMeta | null>(
    () => overview.value.data?.meta ?? supply.value.data?.meta ?? dynamic.value.data?.meta ?? null
  );

  const periodMeta = computed(() => PERIODS.find((p) => p.key === period.value) ?? PERIODS[2]);

  /** 任一核心面板在 loading → 顶部「刷新中」态 */
  const refreshing = computed(
    () =>
      overview.value.status === 'loading' ||
      supply.value.status === 'loading' ||
      dynamic.value.status === 'loading' ||
      topTypes.value.status === 'loading' ||
      warnings.value.status === 'loading' ||
      research.value.status === 'loading'
  );

  let seq = 0;
  let drillSeq = 0;

  function applyPanel<T>(state: Ref<PanelState<T>>, result: PromiseSettledResult<ApiResponse<T>>, isEmpty: (d: T) => boolean) {
    if (result.status === 'fulfilled') {
      const data = result.value.data;
      const isEmptyData = forcedState.value === 'empty' || isEmpty(data);
      state.value = { status: isEmptyData ? 'empty' : 'ready', data, error: null };
      return;
    }
    const err = toApiError(result.reason);
    state.value = {
      status: 'error',
      data: state.value.data,
      error: { code: err.code, message: err.message, traceId: err.traceId },
    };
  }

  async function reload() {
    const token = ++seq;
    setForcedState(forcedState.value);
    const filters = appliedFilters.value;

    overview.value = loadingState(overview.value);
    supply.value = loadingState(supply.value);
    dynamic.value = loadingState(dynamic.value);
    topTypes.value = loadingState(topTypes.value);
    warnings.value = loadingState(warnings.value);
    research.value = loadingState(research.value);

    const [o, s, d, t3, w, r] = await Promise.allSettled([
      fetchOverview(filters),
      fetchSupply(filters),
      fetchDemandDynamic(filters),
      fetchTopTypes(filters),
      fetchWarningList(filters),
      fetchResearchTop(filters),
    ]);

    if (token !== seq) return; // 快速切换筛选：丢弃过期响应

    applyPanel(overview, o, emptyOverview);
    applyPanel(supply, s, emptySupply);
    applyPanel(dynamic, d, emptyDynamic);
    applyPanel(topTypes, t3, emptyTopTypes);
    applyPanel(warnings, w, emptyWarnings);
    applyPanel(research, r, emptyResearch);
    lastLoadedAt.value = new Date();
  }

  /* ------------------------------------------------------------------ 下钻 */

  async function loadDrillPage(page: number) {
    const query = drill.value.query;
    if (!query) return;
    const token = ++drillSeq;
    drill.value = { ...drill.value, open: true, status: 'loading', error: null, query: { ...query, page, pageSize: PAGE_SIZE } };
    try {
      const res = await fetchDemands({ ...query, page, pageSize: PAGE_SIZE });
      if (token !== drillSeq) return;
      drill.value = { open: true, status: 'ready', data: res.data, error: null, query: { ...query, page, pageSize: PAGE_SIZE } };
    } catch (e) {
      if (token !== drillSeq) return;
      const err = toApiError(e);
      drill.value = {
        open: true,
        status: 'error',
        data: drill.value.data,
        error: { code: err.code, message: err.message, traceId: err.traceId },
        query: { ...query, page, pageSize: PAGE_SIZE },
      };
    }
  }

  function openDrill(query: DrillQuery) {
    const merged: DrillQuery = {
      ...query,
      filters: query.filters ?? appliedFilters.value,
    };
    drill.value = {
      open: true,
      status: 'loading',
      data: null,
      error: null,
      query: { ...merged, page: 1, pageSize: PAGE_SIZE },
    };
    void loadDrillPage(1);
  }

  function closeDrill() {
    drillSeq += 1;
    drill.value = { ...drill.value, open: false };
  }

  function goDrillPage(page: number) {
    const total = drill.value.data?.total ?? 0;
    const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    void loadDrillPage(Math.min(Math.max(1, page), maxPage));
  }

  /* ------------------------------------------------------------------ 联动 */

  function setGrid(code: string | null) {
    if (gridCode.value === code && !districtCode.value) return;
    districtCode.value = null;
    gridCode.value = code;
  }

  /** 区县收窄：与网格收窄互斥（同一时间只保留一个空间范围） */
  function setDistrict(code: string | null) {
    if (districtCode.value === code && !gridCode.value) return;
    gridCode.value = null;
    districtCode.value = code;
  }

  function setEnterprise(code: string | null) {
    enterpriseCode.value = code || null;
  }
  function setCommunity(code: string | null) {
    communityCode.value = code || null;
  }
  function setCategory(code: string | null) {
    categoryCode.value = code || null;
  }

  watch(
    [appliedFilters, forcedState],
    () => {
      if (drill.value.open) closeDrill();
      void reload();
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    seq += 1;
    drillSeq += 1;
  });

  return {
    // 筛选
    period,
    industry,
    forcedState,
    periodMeta,
    appliedWindow,
    selectedWindow,
    appliedFilters,
    gridCode,
    selectedGrid,
    setGrid,
    districtCode,
    setDistrict,
    enterpriseCode,
    setEnterprise,
    communityCode,
    setCommunity,
    categoryCode,
    setCategory,
    // 状态
    meta,
    refreshing,
    lastLoadedAt,
    // 面板
    overview,
    supply,
    dynamic,
    topTypes,
    warnings,
    research,
    // 下钻
    drill,
    openDrill,
    closeDrill,
    goDrillPage,
    pageSize: PAGE_SIZE,
    // 手动
    reload,
  };
}

export type StatScreenState = ReturnType<typeof useStatScreen>;
