<script setup lang="ts">
/**
 * 标书 1.2.3 · 满意度分析（第一、二项合并）
 * 主指标：满意率 / 不满意率（分母=有效评价 rated，基本满意计入满意）
 * 副指标：供气/供水不满意占比（各自 rated 分母）
 * 暂无回复、未评价单列，不进入分母（真实数据 satisfaction_code）。
 */
import { computed } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import type { DemandDynamicData, PanelState, PeriodMeta } from '@/stats/types';
import { TEAL, TEAL_FONT, tealTooltip } from './tealChart';

const props = defineProps<{
  dynamic: PanelState<DemandDynamicData>;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{ (e: 'retry'): void }>();

const data = computed(() => props.dynamic.data);
const sat = computed(() => data.value?.satisfactionStats);
const loading = computed(() => props.dynamic.status === 'loading' || props.dynamic.status === 'idle');
const error = computed(() => (props.dynamic.status === 'error' ? props.dynamic.error : null));
const available = computed(() => sat.value?.rated != null && sat.value.rated > 0 && sat.value.satisfiedRate.value != null);

const satisfiedPct = computed(() => (available.value ? (sat.value!.satisfiedRate.value as number) * 100 : 0));
const dissatisfiedPct = computed(() => (available.value ? 100 - satisfiedPct.value : 0));

const option = computed<EChartsCoreOption>(() => ({
  animation: false,
  tooltip: { ...tealTooltip(), trigger: 'item', formatter: '{b}: {c} 件（{d}%）' },
  series: [
    {
      type: 'pie',
      radius: ['44%', '66%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: 'rgba(6, 29, 30, 0.9)', borderWidth: 2 },
      data: [
        { name: '满意（含基本满意）', value: sat.value?.satisfied ?? 0, itemStyle: { color: '#54d5bc' } },
        { name: '不满意', value: sat.value?.unsatisfied ?? 0, itemStyle: { color: '#ec9161' } },
      ],
    },
  ],
}));

/**
 * 标书 1.2.3「供水供气不满意占比」是**构成比**：分母 = 两行业不满意件之和，
 * 回答「不满意诉求里供水/供气各占多少」。与下面的「行业不满意率」（分母=该行业有效评价）是两个口径，
 * 后者保留为副指标并改标签，避免歧义。
 */
const dissatisfactionComposition = computed(() => {
  const by = sat.value?.byIndustry;
  if (!by) return null;
  const gas = Number(by.gas?.unsatisfied ?? 0);
  const water = Number(by.water?.unsatisfied ?? 0);
  const total = gas + water;
  if (!total) return null;
  return { gas, water, total, gasPct: +((gas / total) * 100).toFixed(1), waterPct: +((water / total) * 100).toFixed(1) };
});

const industryRows = computed(() => {
  const list: { key: 'gas' | 'water'; label: string; rated: number; unsatisfied: number; pct: number }[] = [];
  const by = sat.value?.byIndustry;
  for (const [key, label] of [
    ['gas', '供气'],
    ['water', '供水'],
  ] as const) {
    const s = by?.[key];
    const rated = s?.rated ?? 0;
    const unsat = s?.unsatisfied ?? 0;
    list.push({ key, label, rated, unsatisfied: unsat, pct: rated ? +((unsat / rated) * 100).toFixed(1) : 0 });
  }
  return list;
});
</script>

<template>
  <section class="acc-card ss">
    <header class="acc-card__head">
      <h2>满意度分析</h2>
      <small>满意率 / 不满意率 · 分母=有效评价；供水供气不满意占比为构成比</small>
    </header>
    <div class="acc-card__body ss__body">
      <div v-if="loading" class="acc-card__loading">加载中…</div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>满意度加载失败</b>
        <span>{{ error.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="!available" class="acc-empty">
        <b>数据不可计算：无有效评价</b>
        <span>{{ sat?.satisfiedRate.reason || 'rated=0，暂无有效评价' }}</span>
      </div>
      <template v-else>
        <div class="ss__main">
          <div class="ss__donut">
            <EChart :option="option" />
            <div class="ss__center">
              <b>{{ (sat?.rated ?? 0).toLocaleString('zh-CN') }}</b>
              <span>有评价 / 件</span>
            </div>
          </div>
          <div class="ss__rates">
            <div class="ss__rate">
              <b class="is-sat">{{ satisfiedPct.toFixed(1) }}%</b>
              <span>满意率（含基本满意 {{ (sat?.basically ?? 0).toLocaleString('zh-CN') }} 件）</span>
            </div>
            <div class="ss__rate">
              <b class="is-unsat">{{ dissatisfiedPct.toFixed(1) }}%</b>
              <span>不满意率（{{ (sat?.unsatisfied ?? 0).toLocaleString('zh-CN') }} 件）</span>
            </div>
          </div>
        </div>
        <!-- 标书 1.2.3：不满意构成比（分母=两行业不满意之和） -->
        <div class="ss__composition">
          <span class="ss__complabel">不满意构成</span>
          <template v-if="dissatisfactionComposition">
            <span class="ss__compitem">
              供气 <b>{{ dissatisfactionComposition.gasPct.toFixed(1) }}%</b>
              <em>{{ dissatisfactionComposition.gas }} 件</em>
            </span>
            <span class="ss__compsep">/</span>
            <span class="ss__compitem">
              供水 <b>{{ dissatisfactionComposition.waterPct.toFixed(1) }}%</b>
              <em>{{ dissatisfactionComposition.water }} 件</em>
            </span>
            <span class="ss__compnote">分母 = 两行业不满意合计 {{ dissatisfactionComposition.total }} 件</span>
          </template>
          <span v-else class="st-uncomputable ss__compna">不可计算：两行业均无不满意评价（分母为 0）</span>
        </div>
        <!-- 副指标：各行业不满意率（分母=该行业有效评价），不是构成比 -->
        <div class="ss__industry">
          <div v-for="row in industryRows" :key="row.key" class="ss__irow">
            <span class="ss__ilabel">{{ row.label }}不满意率</span>
            <span class="ss__ibar"><i :style="{ width: `${Math.max(3, row.pct)}%` }"></i></span>
            <span class="ss__ivalue">{{ row.pct.toFixed(1) }}%</span>
            <span class="ss__iden" :title="`${row.label}：${row.unsatisfied} 件不满意 / ${row.rated} 件有效评价`">{{ row.unsatisfied }}/{{ row.rated }}</span>
          </div>
        </div>
        <div class="ss__foot">
          分母=有评价诉求 {{ (sat?.rated ?? 0).toLocaleString('zh-CN') }} 条；基本满意计入满意；暂无回复
          {{ sat?.noReply ?? 0 }} 条、未评价 {{ sat?.unrated ?? 0 }} 条单列，不计入分母
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.ss__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 2px;
}
.ss__main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 10px;
}
.ss__donut {
  position: relative;
  min-height: 118px;
  height: 100%;
}
.ss__center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  white-space: nowrap;
}
.ss__center b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 20px;
  color: #8fffe8;
  line-height: 1.1;
}
.ss__center span {
  font-size: 9px;
  color: #7fa9a0;
}
.ss__rates {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  min-width: 0;
}
.ss__rate {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss__rate b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 23px;
  line-height: 1.1;
}
.ss__rate b.is-sat {
  color: #54d5bc;
}
.ss__rate b.is-unsat {
  color: #ec9161;
}
.ss__rate span {
  font-size: 10px;
  color: #8ab9b0;
}
.ss__composition {
  flex: none;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
  padding: 3px 4px;
  font-size: 10.5px;
  background: rgba(12, 54, 50, 0.45);
  border: 1px solid rgba(52, 139, 124, 0.25);
}
.ss__complabel {
  flex: none;
  padding: 0 5px;
  font-size: 10px;
  color: #041d1e;
  background: #ec9161;
}
.ss__compitem {
  color: #d6f6ef;
}
.ss__compitem b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 14px;
  color: #ec9161;
}
.ss__compitem em {
  margin-left: 2px;
  font-style: normal;
  font-size: 9.5px;
  color: #8ab9b0;
}
.ss__compsep {
  color: #7fa9a0;
}
.ss__compnote {
  margin-left: auto;
  font-size: 9.5px;
  color: #8ab9b0;
  white-space: nowrap;
}
.ss__industry {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss__irow {
  display: grid;
  grid-template-columns: 74px 1fr 42px 52px;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.ss__ilabel {
  color: #d6f6ef;
}
.ss__ibar {
  height: 7px;
  background: rgba(12, 54, 50, 0.7);
  border: 1px solid rgba(52, 139, 124, 0.25);
}
.ss__ibar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #8c4f34, #ec9161);
}
.ss__ivalue {
  color: #ec9161;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ss__iden {
  color: #8ab9b0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ss__foot {
  flex: none;
  font-size: 10px;
  color: #8ab9b0;
  line-height: 1.35;
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
