<script setup lang="ts">
/**
 * 验收大屏 · 右①月度变化趋势
 * 供水/供气双折线（可切单行业；Tab 切换时自动跟随），缺月断点不补 0，
 * 点击某月 → 同月明细抽屉 + 地图联动（真实接口按 month 过滤 MVT 同月明细）。
 */
import { computed, ref, watch } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import {
  UNCOMPUTABLE_TEXT,
  type DrillQuery,
  type Industry,
  type IndustryFilter,
  type MonthSeries,
  type PeriodMeta,
  type UncomputableReason,
} from '@/stats/types';
import { TEAL, TEAL_FONT, tealTooltip } from './tealChart';
import CardFooter from './CardFooter.vue';
import type { MonthlyState } from './useIndustryMonthly';

const props = defineProps<{
  water: MonthlyState;
  gas: MonthlyState;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
  /** 真实数据无月度序列时的空态标题与原因 */
  emptyTitle?: string;
  emptyText?: string;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

type Mode = 'ALL' | Industry;
const mode = ref<Mode>(props.industry === 'ALL' ? 'ALL' : props.industry);
watch(
  () => props.industry,
  (ind) => {
    mode.value = ind === 'ALL' ? 'ALL' : ind;
  }
);

const MODES: { key: Mode; label: string; color: string }[] = [
  { key: 'ALL', label: '双线', color: TEAL.bright },
  { key: 'WATER', label: '供水', color: '#19d3f0' },
  { key: 'GAS', label: '供气', color: '#ffd67c' },
];

const needWater = computed(() => mode.value === 'ALL' || mode.value === 'WATER');
const needGas = computed(() => mode.value === 'ALL' || mode.value === 'GAS');

const activeStates = computed<MonthlyState[]>(() => {
  const list: MonthlyState[] = [];
  if (needWater.value) list.push(props.water);
  if (needGas.value) list.push(props.gas);
  return list;
});

const loading = computed(() => activeStates.value.some((s) => s.status === 'loading'));
const error = computed(() => activeStates.value.find((s) => s.status === 'error')?.error ?? null);
const empty = computed(() => activeStates.value.every((s) => s.status === 'empty'));

const seriesList = computed(() => {
  const list: { key: Industry; name: string; color: string; data: (number | null)[]; reason: UncomputableReason | null }[] = [];
  if (needWater.value) {
    list.push({
      key: 'WATER',
      name: '供水',
      color: '#19d3f0',
      data: props.water.data?.points.map((p) => p.value) ?? [],
      reason: props.water.data?.reason ?? null,
    });
  }
  if (needGas.value) {
    list.push({
      key: 'GAS',
      name: '供气',
      color: '#ffd67c',
      data: props.gas.data?.points.map((p) => p.value) ?? [],
      reason: props.gas.data?.reason ?? null,
    });
  }
  return list;
});

const monthLabels = computed(() => props.water.data?.points.map((p) => p.label) ?? props.gas.data?.points.map((p) => p.label) ?? []);
const hasAnyValue = computed(() => seriesList.value.some((s) => s.data.some((v) => v !== null)));
/** 整条序列不可计算：无任何值且有 reason（历史上强制不可计算态） */
const uncomputableReason = computed<UncomputableReason | null>(() => {
  if (hasAnyValue.value) return null;
  const reason = seriesList.value.find((s) => s.reason)?.reason ?? null;
  return reason;
});

/** 缺月（断点）= 所选序列全部为 null 的月份数；整条序列不可计算时不计数（显示「—」） */
const missingMonths = computed<number | null>(() => {
  if (uncomputableReason.value) return null;
  const labels = monthLabels.value;
  if (!labels.length) return null;
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (seriesList.value.every((s) => s.data[i] == null)) count += 1;
  }
  return count;
});

/** 数据截止：优先取 MonthSeries.note 里注明的「截至 MM-DD HH:mm」，否则退回 periodMeta.range 的结束日（都是既有 props，不自造时间） */
const cutoffText = computed(() => {
  const note = props.water.data?.note || props.gas.data?.note || '';
  const hit = note.match(/截至\s*([0-9]{1,2}-[0-9]{1,2}(?:\s+[0-9]{1,2}:[0-9]{2})?)/);
  if (hit) return hit[1];
  const dates = props.periodMeta.range.match(/\d{4}-\d{2}-\d{2}/g);
  return dates?.length ? dates[dates.length - 1] : '—';
});

const footItems = computed(() => {
  const missing = missingMonths.value;
  return [
    { label: '口径', value: '来源受理时间', title: '月度序列按诉求受理时间归月，不按浏览器当前时间重算' },
    {
      label: '缺月',
      value: missing == null ? '—' : `${missing} 个月`,
      warn: missing != null && missing > 0,
      title:
        uncomputableReason.value != null
          ? `不可计算：${UNCOMPUTABLE_TEXT[uncomputableReason.value]}；缺月数不可计算`
          : '缺月 = 未到月 / 统计窗口未覆盖的断点，不补 0',
    },
    { label: '数据截止', value: cutoffText.value, title: '取月度序列注明的最新截止日；快照与同步时间见大屏顶部' },
  ];
});

/** 正常态与不可计算态都出底部信息带（与诉求总览一致）；loading / 空态 / 错误态不出 */
const showFoot = computed(() => !loading.value && !error.value && !empty.value);

const option = computed<EChartsCoreOption>(() => {
  const labels = monthLabels.value;
  const tooltip = {
    ...tealTooltip(),
    formatter: (params: unknown) => {
      const arr = (Array.isArray(params) ? params : [params]) as { dataIndex?: number; axisValue?: string }[];
      const idx = arr[0]?.dataIndex ?? 0;
      const month = labels[idx] ?? arr[0]?.axisValue ?? '';
      const lines: string[] = [`<b>2026 ${month}</b>`];
      for (const s of seriesList.value) {
        const v = s.data[idx];
        lines.push(v !== null && v !== undefined ? `${s.name}：${v} 件` : `${s.name}：不可计算：统计窗口不足`);
      }
      return lines.join('<br/>');
    },
  };
  return {
    animation: false,
    grid: { left: 4, right: 8, top: 10, bottom: 2, containLabel: true },
    legend: {
      show: false,
    },
    tooltip,
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: TEAL.border } },
      axisLabel: { color: TEAL.sub, fontSize: 10, fontFamily: TEAL_FONT, interval: 0, margin: 4 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: TEAL.sub, fontSize: 10, fontFamily: TEAL_FONT },
      splitLine: { lineStyle: { color: TEAL.grid, type: 'dashed' as const } },
    },
    series: seriesList.value.map((s) => ({
      type: 'line',
      name: s.name,
      data: s.data,
      connectNulls: false,
      showSymbol: true,
      symbolSize: 3,
      smooth: false,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: 'series' },
      areaStyle: {
        opacity: 0.1,
        color: s.color,
      },
    })),
  };
});

function monthOf(label: string): number {
  return Number(label.replace(/[^\d]/g, '')) || 1;
}

function onChartClick(params: { name?: string; dataIndex?: number }) {
  const idx = params.dataIndex;
  const labels = monthLabels.value;
  if (idx == null || !labels[idx]) return;
  const month = monthOf(labels[idx]);
  const hasValue = seriesList.value.some((s) => s.data[idx] !== null);
  emit('drill', {
    source: '验收大屏 · 月度变化趋势',
    title: hasValue ? `2026 年 ${month} 月 · 同月诉求明细` : `2026 年 ${month} 月 · 该月暂无有效数据（不补 0）`,
    period: props.periodMeta.key,
    industry: mode.value,
    month,
  });
}
</script>

<template>
  <section class="acc-card mt">
    <header class="acc-card__head">
      <h2>月度变化趋势</h2>
      <small>水/气双线 · 缺月断点不补 0</small>
    </header>
    <div class="acc-card__body mt__body">
      <!-- 模式切换（Tab 也会跟随） -->
      <div class="mt__modes" role="group" aria-label="月度趋势行业切换">
        <button
          v-for="m in MODES"
          :key="m.key"
          type="button"
          class="mt__mode"
          :class="{ 'is-active': mode === m.key }"
          :style="{ '--mode-color': m.color }"
          @click="mode = m.key"
        >
          {{ m.label }}
        </button>
        <span class="mt__unit">单位：件</span>
      </div>

      <div v-if="loading" class="mt__skeleton" aria-busy="true">
        <i v-for="n in 3" :key="n"></i>
      </div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>月度趋势加载失败</b>
        <span>{{ error.message }}</span>
        <span class="acc-empty__trace">code={{ error.code }} · traceId={{ error.traceId }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="empty" class="acc-empty">
        <b>{{ emptyTitle ?? '当前筛选无月度数据' }}</b>
        <span>{{ emptyText ?? '空态不代表 0：所选窗口 / 行业 / 网格未命中任何工单' }}</span>
      </div>
      <div v-else-if="uncomputableReason" class="acc-empty">
        <b>不可计算：{{ UNCOMPUTABLE_TEXT[uncomputableReason] }}</b>
        <span>月度序列当前不可计算（不补 0），请切换窗口或重试</span>
      </div>
      <template v-else>
        <EChart class="mt__chart" :option="option" @chart-click="onChartClick" />
      </template>
    </div>
    <CardFooter v-if="showFoot" :items="footItems" />
  </section>
</template>

<style scoped>
.mt__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 3px;
}
.mt__modes {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.mt__mode {
  padding: 1px 8px;
  font-family: inherit;
  font-size: 10.5px;
  color: #a8d8ce;
  background: rgba(10, 54, 50, 0.55);
  border: 1px solid rgba(52, 139, 124, 0.4);
  cursor: pointer;
}
.mt__mode:hover {
  border-color: #86fbe7;
  color: #eafffa;
}
.mt__mode.is-active {
  color: #041d1e;
  background: var(--mode-color, #86fbe7);
  border-color: var(--mode-color, #86fbe7);
  font-weight: 600;
}
.mt__unit {
  margin-left: auto;
  font-size: 9.5px;
  color: #7fa9a0;
  white-space: nowrap;
}
.mt__chart {
  flex: 1;
  min-height: 0;
  width: 100%;
}
.mt__skeleton {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 10px 2px 4px;
}
.mt__skeleton i {
  flex: 1;
  display: block;
  height: 62%;
  background: linear-gradient(180deg, rgba(84, 213, 188, 0.4), rgba(84, 213, 188, 0.08));
  animation: mt-pulse 1.2s ease-in-out infinite alternate;
}
.mt__skeleton i:nth-child(2) {
  height: 78%;
}
.mt__skeleton i:nth-child(3) {
  height: 55%;
}
@keyframes mt-pulse {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 1;
  }
}
</style>
