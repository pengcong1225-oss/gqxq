<script setup lang="ts">
/**
 * 标书 1.2.3 · 周变化
 * 周一~周日柱状图（供气/供水双系列），数据来自同一 bootstrap 的 charts.weekly。
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
const points = computed(() => data.value?.weekdaySplit ?? []);
const loading = computed(() => props.dynamic.status === 'loading' || props.dynamic.status === 'idle');
const error = computed(() => (props.dynamic.status === 'error' ? props.dynamic.error : null));
const empty = computed(() => props.dynamic.status === 'empty' || (props.dynamic.status === 'ready' && !points.value.length));

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
    data: points.value.map((p) => p.label),
    axisLabel: { color: TEAL.sub, fontSize: 10 },
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
      barMaxWidth: 12,
      itemStyle: { color: '#f5a623' },
      data: points.value.map((p) => p.gas),
    },
    {
      name: '供水',
      type: 'bar',
      barMaxWidth: 12,
      itemStyle: { color: '#19d3f0' },
      data: points.value.map((p) => p.water),
    },
  ],
}));
</script>

<template>
  <section class="acc-card wd">
    <header class="acc-card__head">
      <h2>周变化</h2>
      <small>周一=1 … 周日=7 · 供气/供水</small>
    </header>
    <div class="acc-card__body wd__body">
      <div v-if="loading" class="acc-card__loading">加载中…</div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>周变化加载失败</b>
        <span>{{ error.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="empty" class="acc-empty">
        <b>当前筛选暂无周变化数据</b>
        <span>空态不代表 0：所选窗口 / 行业 / 网格未命中任何工单</span>
      </div>
      <div v-else class="wd__chart"><EChart :option="option" /></div>
    </div>
  </section>
</template>

<style scoped>
.wd__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.wd__chart {
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
