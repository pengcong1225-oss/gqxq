/**
 * 验收大屏 · 右①月度变化趋势的数据装配（水/气双线）
 *
 * 复用 stats 数据层（fetchSupply → 真实接口 `/api/v1/screen/bootstrap` 的 monthly 序列），
 * 不新建数据源；与主面板共用同一 snapshot/period/gridCode/districtCode，同时取供水+供气两份序列，
 * 由卡片按 Tab 决定显示双线还是单行业。
 *
 * 缺数规则：MonthSeries 的 value=null 表示「未到月/统计窗口未覆盖」，UI 断点不补 0；
 * 整条序列 reason 非空 → 卡片显示「不可计算：原因」。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { SNAPSHOT_ID, ScreenApiError, fetchSupply } from '@/stats/api';
import type { ForcedState, Industry, MonthSeries, PeriodKey } from '@/stats/types';

export interface MonthlyState {
  status: 'loading' | 'ready' | 'empty' | 'error';
  data: MonthSeries | null;
  error: { code: number; message: string; traceId: string } | null;
}

const initial = (): MonthlyState => ({ status: 'loading', data: null, error: null });

export interface UseIndustryMonthlyOptions {
  period: Ref<PeriodKey>;
  gridCode: Ref<string | null>;
  districtCode: Ref<string | null>;
  forcedState: Ref<ForcedState>;
  /** 与主面板同一个筛选口径（企业/小区/分类） */
  enterpriseCode?: Ref<string | null>;
  communityCode?: Ref<string | null>;
  /** 顶部「分类」筛选条选中的小类 */
  categoryCode?: Ref<string | null>;
  /**
   * 图内点击选中的诉求类型（TypeDistributionCard 点击 / 区域环联动状态）。
   * 标书 1.2.2 ③：月度折线按「选取的诉求统计类型」统计；顶部筛选条未选分类时用它作为 categoryCode，
   * 顶部筛选条主动选了分类时以筛选条为准（不改筛选条语义）。
   */
  activeTypeCode?: Ref<string | null>;
}

export function useIndustryMonthly(opts: UseIndustryMonthlyOptions) {
  const water = ref<MonthlyState>(initial());
  const gas = ref<MonthlyState>(initial());
  let seq = 0;

  async function fetchOne(industry: Industry) {
    return fetchSupply({
      // 月度趋势固定取「年度」窗口，保证 12 个月序列完整；空间/企业/小区/分类筛选仍与主屏一致
      period: 'year',
      industry,
      snapshotId: SNAPSHOT_ID,
      gridCode: opts.gridCode.value,
      districtCode: opts.districtCode.value,
      enterpriseCode: opts.enterpriseCode?.value ?? null,
      communityCode: opts.communityCode?.value ?? null,
      // 筛选条分类优先；未选时跟随图内点击的类型（标书 1.2.2 ③「按选中类型分别统计」）
      categoryCode: opts.categoryCode?.value ?? opts.activeTypeCode?.value ?? null,
    } as any);
  }

  async function reload() {
    const token = ++seq;
    water.value = { ...water.value, status: 'loading', error: null };
    gas.value = { ...gas.value, status: 'loading', error: null };

    try {
      const [w, g] = await Promise.all([fetchOne('WATER'), fetchOne('GAS')]);
      if (token !== seq) return;
      water.value = { status: 'ready', data: w.data.monthly, error: null };
      gas.value = { status: 'ready', data: g.data.monthly, error: null };
    } catch (e) {
      if (token !== seq) return;
      const err =
        e instanceof ScreenApiError
          ? { code: e.code, message: e.message, traceId: e.traceId }
          : { code: 2002, message: e instanceof Error ? e.message : String(e), traceId: 'accept-monthly' };
      water.value = { status: 'error', data: null, error: err };
      gas.value = { status: 'error', data: null, error: err };
    }
  }

  watch(
    [
      opts.period,
      opts.gridCode,
      opts.districtCode,
      opts.forcedState,
      opts.enterpriseCode ?? ref(null),
      opts.communityCode ?? ref(null),
      opts.categoryCode ?? ref(null),
      opts.activeTypeCode ?? ref(null),
    ],
    () => void reload(),
    { immediate: true }
  );

  onBeforeUnmount(() => {
    seq += 1;
  });

  return { water, gas, reload };
}
