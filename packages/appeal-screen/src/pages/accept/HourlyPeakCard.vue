<script setup lang="ts">
/**
 * 标书 1.2.3 · 高峰时段
 * 24 小时柱状图（供气/供水双系列），顶部标注峰值时段与行业占比。
 * 数据来自同一次 /screen/bootstrap 的 charts.hourly（不新增请求）。
 */
import { computed } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import type { DemandDynamicData, IndustryFilter, PanelState, PeriodMeta } from '@/stats/types';
import { TEAL, TEAL_FONT, tealTooltip } from './tealChart';

const props = defineProps<{
  dynamic: PanelState<DemandDynamicData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{ (e: 'retry'): void }>();

const data = computed(() => props.dynamic.data);
const points = computed(() => data.value?.hourlySplit ?? []);
const loading = computed(() => props.dynamic.status === 'loading' || props.dynamic.status === 'idle');
const error = computed(() => (props.dynamic.status === 'error' ? props.dynamic.error : null));
const empty = computed(() => props.dynamic.status === 'empty' || (props.dynamic.status === 'ready' && !points.value.length));

const totalGas = computed(() => points.value.reduce((a, p) => a + p.gas, 0));
const totalWater = computed(() => points.value.reduce((a, p) => a + p.water, 0));

const peak = computed(() => {
  if (!points.value.length) return null;
  const top = points.value.reduce((best, p) => (p.count > best.count ? p : best), points.value[0]);
  const gasShare = totalGas.value ? +((top.gas / totalGas.value) * 100).toFixed(1) : 0;
  const waterShare = totalWater.value ? +((top.water / totalWater.value) * 100).toFixed(1) : 0;
  const start = `${String(top.hour).padStart(2, '0')}:00`;
  const end = `${String((top.hour + 1) % 24).padStart(2, '0')}:00`;
  const parts: string[] = [];
  if (props.industry !== 'WATER') parts.push(`供气 ${gasShare}%`);
  if (props.industry !== 'GAS') parts.push(`供水 ${waterShare}%`);
  return { label: `${start}–${end}`, shareText: parts.join(' / '), gasShare, waterShare, count: top.count };
});

const peakText = computed(() => {
  if (!peak.value) return '无峰值数据';
  if (props.industry === 'GAS') return `峰值 ${peak.value.label} · 占供气诉求 ${peak.value.gasShare}%`;
  if (props.industry === 'WATER') return `峰值 ${peak.value.label} · 占供水诉求 ${peak.value.waterShare}%`;
  return `峰值 ${peak.value.label} · 供气占 ${peak.value.gasShare}% / 供水占 ${peak.value.waterShare}%`;
});

const option = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 4, right: 8, top: 24, bottom: 2, containLabel: true },
  legend: {
    top: 0,
    right: 0,
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: TEAL.text, fontSize: 10, fontFamily: TEAL_FONT },
  },
  tooltip: { ...tealTooltip(), trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: points.value.map((p) => `${String(p.hour).padStart(2, '0')}:00`),
    axisLabel: { color: TEAL.sub, fontSize: 9, interval: 2 },
    axisLine: { lineStyle: { color: TEAL.border } },
    axisTick: { show: false },
  },
  yAxis: {
    type: 'value',
    name: '件',
    nameTextStyle: { color: TEAL.sub, fontSize: 9 },
    axisLabel: { color: TEAL.sub, fontSize: 9 },
    splitLine: { lineStyle: { color: 'rgba(52,139,124,0.16)' } },
  },
  series: [
    {
      name: '供气',
      type: 'bar',
      barMaxWidth: 9,
      itemStyle: { color: '#f5a623' },
      data: points.value.map((p) => p.gas),
    },
    {
      name: '供水',
      type: 'bar',
      barMaxWidth: 9,
      itemStyle: { color: '#19d3f0' },
      data: points.value.map((p) => p.water),
    },
  ],
}));
</script>

<template>
  <section class="acc-card hp">
    <header class="acc-card__head">
      <h2>高峰时段</h2>
      <small>24 小时 · 供气/供水双系列</small>
    </header>
    <div class="acc-card__body hp__body">
      <div v-if="loading" class="acc-card__loading">加载中…</div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>高峰时段加载失败</b>
        <span>{{ error.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="empty" class="acc-empty">
        <b>当前筛选暂无高峰时段数据</b>
        <span>空态不代表 0：所选窗口 / 行业 / 网格未命中任何工单</span>
      </div>
      <template v-else>
        <div class="hp__peak" :title="`峰值小时件数 ${peak?.count ?? 0}；占比分母为该行业全天诉求量`">{{ peakText }}</div>
        <div class="hp__chart"><EChart :option="option" /></div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.hp__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
}
.hp__peak {
  flex: none;
  font-size: 11px;
  color: #ffd67c;
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hp__chart {
  flex: 1;
  min-height: 0;
  width: 100%;
}
.acc-card__loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8ab9b0;
  font-size: 11px;
}
</style>
