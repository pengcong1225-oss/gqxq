<script setup lang="ts">
/**
 * 验收大屏 · 左栏「诉求总览」（8002 版式）
 * 四张指标（年度/季度/月度/昨日）+ 所选窗口总量 + 查看明细入口。
 * 数值一律走 ComputableValue：null + reason 显示「不可计算：原因」，绝不拿 0 冒充。
 */
import { computed } from 'vue';
import ComputableValue from '@/stats/components/ComputableValue.vue';
import {
  UNCOMPUTABLE_TEXT,
  type Computable,
  type IndustryFilter,
  type IndustryOverview,
  type MetricCard,
  type MetricKey,
  type OverviewData,
  type PanelState,
  type PeriodMeta,
} from '@/stats/types';

const props = defineProps<{
  overview: PanelState<OverviewData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', payload: { metricKey?: MetricKey; title: string; source: string; industry: IndustryFilter }): void;
}>();

const SHORT_LABEL: Record<MetricKey, string> = {
  year: '年度',
  quarter: '季度',
  month: '月度',
  yesterday: '昨日',
};

const data = computed(() => props.overview.data);
const industries = computed<IndustryOverview[]>(() => data.value?.industries ?? []);
const state = computed(() => props.overview.status);
const summaryTotal = computed<Computable<number>>(
  () => data.value?.summary.total ?? { value: null, reason: 'NO_SAMPLE' }
);

/** 面板下部质量条：真实取 summary/meta，缺项显示 — 而不是 0 */
const summaryText = computed(() => {
  const t = summaryTotal.value;
  return t.value === null ? '—' : `${t.value} 件`;
});
const unlocated = computed(() => data.value?.summary.unlocated ?? 0);
const missingEval = computed(() => data.value?.meta?.missingEvaluationCount ?? 0);
const missingHouseholds = computed(() => data.value?.meta?.missingEnterpriseDenominatorCount ?? 0);

/** 单行业直接取指标；ALL（诉求动态 Tab）按同一口径把供气+供水相加，算不出来就返回 null + reason */
const rows = computed(() => {
  if (!data.value) return [] as { key: MetricKey; label: string; caption: string; value: Computable<number>; delta: Computable<number> | null }[];
  if (props.industry !== 'ALL') {
    const hit = industries.value.find((i) => i.industry === props.industry) ?? industries.value[0];
    if (!hit) return [];
    return hit.metrics.map((m) => ({
      key: m.key,
      label: SHORT_LABEL[m.key],
      caption: m.caption,
      value: m.value,
      delta: m.delta,
    }));
  }
  const gas = industries.value.find((i) => i.industry === 'GAS');
  const water = industries.value.find((i) => i.industry === 'WATER');
  if (!gas || !water) return [];
  return gas.metrics.map((m, idx) => {
    const other = water.metrics[idx];
    let value: Computable<number>;
    if (m.value.value === null) value = { value: null, reason: m.value.reason };
    else if (other?.value.value === null) value = { value: null, reason: other.value.reason };
    else value = { value: m.value.value + other.value.value };
    return {
      key: m.key,
      label: SHORT_LABEL[m.key],
      caption: '供水+供气合计',
      value,
      delta: null,
    };
  });
});

function deltaText(delta: Computable<number> | null): string {
  if (!delta) return '';
  if (delta.value === null) return `不可计算：${UNCOMPUTABLE_TEXT[delta.reason]}`;
  if (delta.value === 0) return '持平 0.0%';
  return `${delta.value > 0 ? '▲' : '▼'} ${Math.abs(delta.value).toFixed(1)}%`;
}

function deltaClass(delta: Computable<number> | null): string {
  if (!delta || delta.value === null) return 'is-na';
  return delta.value > 0 ? 'is-up' : delta.value < 0 ? 'is-down' : 'is-flat';
}

function drillMetric(row: { key: MetricKey; label: string }) {
  emit('drill', {
    metricKey: row.key,
    title: `${row.label}诉求明细`,
    source: '验收大屏 · 诉求总览',
    industry: props.industry,
  });
}

function drillTotal() {
  emit('drill', {
    title: '所选窗口诉求明细',
    source: '验收大屏 · 诉求总览',
    industry: props.industry,
  });
}
</script>

<template>
  <section class="acc-card ov">
    <header class="acc-card__head">
      <h2>诉求总览</h2>
      <small>{{ industry === 'ALL' ? '供水+供气' : industry === 'WATER' ? '供水' : '供气' }} · {{ periodMeta.label }}</small>
    </header>
    <div class="acc-card__body ov__body">
      <!-- 加载中 -->
      <div v-if="!data || state === 'loading' || state === 'idle'" class="ov__skeleton" aria-busy="true">
        <i v-for="n in 4" :key="n"></i>
        <span></span>
      </div>

      <!-- 空态 -->
      <div v-else-if="state === 'empty'" class="acc-empty">
        <b>当前筛选无诉求数据</b>
        <span>空态不代表 0 件：所选窗口 / 行业 / 网格未命中任何工单</span>
      </div>

      <!-- 错误态 -->
      <div v-else-if="state === 'error'" class="acc-empty acc-empty--error">
        <b>诉求总览加载失败</b>
        <span>{{ overview.error?.message }}</span>
        <span class="acc-empty__trace">code={{ overview.error?.code }} · traceId={{ overview.error?.traceId }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>

      <!-- 正常 -->
      <template v-else>
        <div class="ov__metrics">
          <button
            v-for="row in rows"
            :key="row.key"
            type="button"
            class="ov__metric"
            :class="{ 'is-today': row.key === 'yesterday' }"
            :title="`${row.caption}；点击查看${row.label}明细`"
            @click="drillMetric(row)"
          >
            <span class="ov__value"><ComputableValue :value="row.value" size="lg" /></span>
            <span class="ov__label">{{ row.label }}<em class="ov__unit">件</em></span>
            <span class="ov__delta" v-if="deltaText(row.delta)" :class="deltaClass(row.delta)">{{ deltaText(row.delta) }}</span>
          </button>

          <!-- 面板下部：数据质量条（把空白填成有用信息，不是装饰） -->
          <div class="ov__quality">
            <span class="ov__q-item">
              <em>所选窗口</em>{{ periodMeta.range }}
            </span>
            <span class="ov__q-item">
              <em>合计</em><b>{{ summaryText }}</b>
            </span>
            <span class="ov__q-item" :class="{ 'is-warn': unlocated > 0 }">
              <em>未定位</em><b>{{ unlocated }}</b>
            </span>
            <span class="ov__q-item" :class="{ 'is-warn': missingEval > 0 }">
              <em>缺评价</em><b>{{ missingEval }}</b>
            </span>
            <span class="ov__q-item" :class="{ 'is-warn': missingHouseholds > 0 }">
              <em>缺户数</em><b>{{ missingHouseholds }}</b>
            </span>
            <button type="button" class="ov__more" @click="drillTotal">明细 ›</button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.ov__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ov__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  flex: 1;
  min-height: 0;
  /* 一整块面板 + 细分隔线，比四个各自带边框的盒子干净 */
  background: linear-gradient(160deg, rgba(9, 52, 48, 0.55), rgba(6, 33, 32, 0.42));
  border: 1px solid rgba(43, 112, 100, 0.55);
  border-radius: 2px;
  overflow: hidden;
}
.ov__metric {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  padding: 6px 4px 5px;
  font-family: inherit;
  text-align: center;
  color: #d6f6ef;
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background 0.15s ease;
}
/* 列间细分隔线（首列不加） */
.ov__metric + .ov__metric::before {
  content: '';
  position: absolute;
  left: 0;
  top: 18%;
  bottom: 18%;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(83, 191, 173, 0.34) 22%, rgba(83, 191, 173, 0.34) 78%, transparent);
  pointer-events: none;
}
.ov__metric:hover {
  background: linear-gradient(180deg, rgba(31, 143, 129, 0.22), rgba(31, 143, 129, 0.06));
}
.ov__metric:hover .ov__value :deep(.cv) {
  color: #c4fff2;
}
/* 昨日：用一点暖色区分「当日」 */
.ov__metric.is-today .ov__value :deep(.cv) {
  color: #ffe08a;
}
.ov__metric.is-today:hover .ov__value :deep(.cv) {
  color: #fff2c2;
}
.ov__value {
  display: flex;
  justify-content: center;
  align-items: baseline;
  width: 100%;
  min-height: 30px;
}
.ov__value :deep(.cv) {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  color: #8fffe8;
  letter-spacing: 0;
  line-height: 1.05;
  white-space: nowrap;
  /* 等宽数字，4 位数也不会把列撑歪 */
  font-variant-numeric: tabular-nums;
}
.ov__value :deep(.cv--lg) {
  font-size: clamp(20px, 1.45vw, 26px);
}
.ov__value :deep(.st-uncomputable) {
  font-family: 'Bahnschrift', 'Microsoft YaHei', sans-serif;
  font-size: 10px;
  max-height: 30px;
  overflow: hidden;
  line-height: 1.25;
  white-space: normal;
  padding: 0 3px;
  color: #9db8ca;
}
.ov__label {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  font-size: 12px;
  font-weight: 600;
  color: #cfe9e3;
  letter-spacing: 1.5px;
}
.ov__unit {
  font-size: 10px;
  font-style: normal;
  font-weight: 400;
  letter-spacing: 0;
  color: #7fa8a2;
}
.ov__delta {
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  color: #8ab9b0;
  font-variant-numeric: tabular-nums;
}
.ov__delta.is-up {
  color: #ff8f8f;
}
.ov__delta.is-down {
  color: #4ee08a;
}
.ov__delta.is-na {
  color: #9db8ca;
}
.ov__caption {
  max-width: 100%;
  font-size: 9px;
  line-height: 1.15;
  color: #7fa9a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding-top: 6px;
  border-top: 1px dashed rgba(52, 139, 124, 0.4);
  font-size: 11px;
  color: #8fbcb4;
}
.ov__window {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov__foot :deep(.cv--sm) {
  color: #8fffe8;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
}
.ov__more {
  margin-left: auto;
  flex: none;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 11px;
  color: #86fbe7;
  background: transparent;
  border: 1px solid rgba(52, 139, 124, 0.5);
  cursor: pointer;
  white-space: nowrap;
}
.ov__more:hover {
  background: #1b7466;
  color: #fff;
}
.ov__skeleton {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  flex: 1;
}
.ov__skeleton i {
  display: block;
  min-height: 90px;
  background: linear-gradient(90deg, rgba(134, 251, 231, 0.05), rgba(134, 251, 231, 0.16), rgba(134, 251, 231, 0.05));
  background-size: 220% 100%;
  animation: ov-shimmer 1.2s linear infinite;
}
.ov__skeleton span {
  grid-column: 1 / -1;
  height: 16px;
  background: linear-gradient(90deg, rgba(134, 251, 231, 0.05), rgba(134, 251, 231, 0.16), rgba(134, 251, 231, 0.05));
  background-size: 220% 100%;
  animation: ov-shimmer 1.2s linear infinite;
}
@keyframes ov-shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}
/* 面板下部质量条：横向铺满，把原空白变成可用信息 */
.ov__quality {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 2px;
  padding: 6px 8px 0;
  border-top: 1px solid rgba(83, 191, 173, 0.22);
  font-size: 10.5px;
  line-height: 1.3;
  color: #86a8a3;
}
.ov__q-item {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  white-space: nowrap;
}
.ov__q-item em {
  font-style: normal;
  color: #6f928d;
}
.ov__q-item b {
  font-weight: 600;
  color: #b9e8e0;
  font-variant-numeric: tabular-nums;
}
.ov__q-item.is-warn b {
  color: #ffd67c;
}
.ov__quality .ov__more {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  color: #8fffe8;
  background: rgba(18, 84, 76, 0.5);
  border: 1px solid rgba(83, 191, 173, 0.45);
  border-radius: 2px;
  cursor: pointer;
}
.ov__quality .ov__more:hover {
  color: #04121f;
  background: linear-gradient(180deg, #6ff0ff, #1fb9d9);
  border-color: #6ff0ff;
}
/* 指标区改为「4 列 + 底部质量条」，数字吃掉多余高度 */
.ov__metrics {
  grid-template-rows: 1fr auto;
}
.ov__value :deep(.cv--lg) {
  font-size: clamp(20px, 1.45vw, 26px);
}
</style>





