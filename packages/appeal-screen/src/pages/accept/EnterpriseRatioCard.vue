<script setup lang="ts">
/**
 * 验收大屏 · 左栏「企业每万户诉求量」（8002 版式）
 * 柱状 = 件/万户；缺户数 / 基期为零的企业**不画 0 柱**，单独列「不可计算：缺户数 / 基期为零」。
 */
import { computed } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import {
  UNCOMPUTABLE_TEXT,
  type DrillQuery,
  type EnterpriseRatio,
  type IndustryFilter,
  type PanelState,
  type PeriodMeta,
  type SupplyData,
} from '@/stats/types';
import CardFooter from './CardFooter.vue';
import { TEAL, TEAL_FONT, tealBarGradient, tealTooltip } from './tealChart';

const props = defineProps<{
  supply: PanelState<SupplyData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
  /** 真实数据缺企业户数主数据时的不可计算标题/原因（由页面按真实缺项传入） */
  naTitle?: string;
  naText?: string;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const data = computed(() => props.supply.data);
const state = computed(() => props.supply.status);
const allRows = computed<EnterpriseRatio[]>(() => data.value?.enterpriseRatio ?? []);
const computable = computed(() => allRows.value.filter((r) => r.ratio.value !== null));
const uncomputable = computed(() => allRows.value.filter((r) => r.ratio.value === null));
/**
 * 悬停展示的完整口径说明。
 *
 * 卡片下方原来铺两段长文（口径 + meta.missingNote，后者可达数百字），
 * 1080 高的大屏上会把卡片下半截塞满小字 —— 用户反馈「说明文字太多」。
 * 现在界面只留一行短口径 + 一个「有数据缺项」标记，完整内容放 title 悬停。
 */
const hintFullText = computed(() => {
  const parts = ['万户占比 = 诉求件数 ÷ 企业服务户数 × 10000；缺户数 / 基期为零不画 0 柱'];
  const note = data.value?.meta?.missingNote;
  if (note) parts.push('数据缺项：' + note);
  return parts.join('\n');
});


/** 可计算企业只有 1~2 家时，柱状图会把两根柱子摊在整张卡上（客户反馈「留空太多」）：
 *  改用紧凑行 + 细分隔线，行高固定、宽度按最大比值归一；企业多（>6）时仍用原柱状图。 */
const useChart = computed(() => computable.value.length > 12);
/** 每万户口径整体不可算（缺服务户数）时的兜底口径：按「企业诉求量」展示件数，不画 0 */
const countMode = computed(() => computable.value.length === 0 && allRows.value.some((r) => r.demandCount > 0));
const countRows = computed(() => [...allRows.value].filter((r) => r.demandCount > 0).sort((a, b) => b.demandCount - a.demandCount));
const maxCount = computed(() => Math.max(...countRows.value.map((r) => r.demandCount), 0));
function countBarWidth(row: EnterpriseRatio): string {
  if (maxCount.value <= 0) return '0%';
  return `${Math.max(6, Math.round((row.demandCount / maxCount.value) * 100))}%`;
}
const maxRatio = computed(() => Math.max(...computable.value.map((r) => Number(r.ratio.value ?? 0)), 0));
function barWidth(row: EnterpriseRatio): string {
  const v = row.ratio.value;
  if (v == null || maxRatio.value <= 0) return '0%';
  return `${Math.max(6, Math.round((Number(v) / maxRatio.value) * 100))}%`;
}

/** 不可计算原因摘要（缺户数 / 基期为零 / 无样本），底部信息带直接展示，不另造数 */
const reasonSummary = computed(() => {
  const labels = uncomputable.value
    .map((r) => (r.ratio.value === null ? UNCOMPUTABLE_TEXT[r.ratio.reason] : ''))
    .filter((label): label is string => !!label);
  return Array.from(new Set(labels)).join('、');
});

const footItems = computed(() => {
  const ready = state.value === 'ready' && allRows.value.length > 0;
  const naCount = uncomputable.value.length;
  if (countMode.value) {
    const sum = countRows.value.reduce((s, r) => s + r.demandCount, 0);
    return [
      { label: '口径', value: '企业诉求件数', title: '所选期间缺可用的服务户数分母，按诉求件数展示' },
      { label: '企业数', value: `${countRows.value.length} 家`, title: '本期有诉求记录的企业数' },
      { label: '合计', value: `${sum} 件`, title: '所选窗口内这些企业的诉求件数合计' },
    ];
  }
  return [
    {
      label: '分母日期',
      value: ready ? data.value?.denominatorDate ?? '—' : '—',
      title: '企业服务户数分母日期（后台维护）；缺户数 / 基期为零的企业不参与万户占比',
    },
    {
      label: '可用企业',
      value: ready ? `${computable.value.length} 家` : '—',
      title: ready ? '有服务户数且基期非零、占比可计算的企业数' : '真实库缺企业户数主数据，可用企业数不可用',
    },
    {
      label: '不可计算',
      value: ready ? (naCount === 0 ? '0 家' : `${naCount} 家${reasonSummary.value ? `（${reasonSummary.value}）` : ''}`) : '—',
      warn: ready && naCount > 0,
      title: '不可计算企业不画 0 柱，单独列在卡内清单；原因含缺户数 / 基期为零 / 无样本',
    },
  ];
});

function drillAll() {
  emit('drill', {
    source: '验收大屏 · 企业每万户',
    title: '企业每万户诉求明细',
    period: props.periodMeta.key,
    industry: props.industry,
  });
}

const option = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 4, right: 58, top: 4, bottom: 2, containLabel: true },
  tooltip: {
    ...tealTooltip(),
    formatter: (p: unknown) => {
      const row = (p as { dataIndex: number }[])[0];
      const item = computable.value[row?.dataIndex ?? 0];
      if (!item || item.ratio.value === null) return '';
      return `<b>${item.name}</b><br/>${item.ratio.value.toFixed(2)} 件/万户<br/>诉求 ${item.demandCount} 件 · 服务户数 ${item.households?.toLocaleString('zh-CN') ?? '—'}`;
    },
  },
  xAxis: { type: 'value', show: false },
  yAxis: {
    type: 'category',
    inverse: true,
    data: computable.value.map((r) => r.name),
    axisTick: { show: false },
    axisLine: { show: false },
    axisLabel: { color: TEAL.text, fontSize: 11, fontFamily: TEAL_FONT, width: 62, overflow: 'truncate' },
  },
  series: [
    {
      type: 'bar',
      data: computable.value.map((r) => Number(r.ratio.value)),
      barMaxWidth: 12,
      itemStyle: { color: tealBarGradient(), borderRadius: [0, 2, 2, 0] },
      label: {
        show: true,
        position: 'right',
        color: TEAL.bright,
        fontSize: 10,
        fontFamily: TEAL_FONT,
        formatter: (p: { value: number }) => `${p.value.toFixed(2)}`,
      },
      emphasis: { itemStyle: { color: '#b9fff3' } },
    },
  ],
}));

function onChartClick(params: { dataIndex?: number }) {
  const idx = params.dataIndex;
  if (idx == null) return;
  const hit = computable.value[idx];
  if (hit) drillEnterprise(hit);
}

function drillEnterprise(row: EnterpriseRatio) {
  emit('drill', {
    source: '验收大屏 · 企业每万户',
    title: `${row.name} · 企业诉求明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    enterpriseId: row.enterpriseId,
  });
}
</script>

<template>
  <section class="acc-card">
    <header class="acc-card__head">
      <h2>{{ countMode ? '企业诉求量' : '企业万户诉求占比' }}</h2>
      <small>{{ countMode ? '件 · 缺少可用的每万户分母' : '件/万户' }} · {{ periodMeta.label }}</small>
    </header>
    <div class="acc-card__body ent">
      <div v-if="!data || state === 'loading' || state === 'idle'" class="ent-skeleton" aria-busy="true">
        <i v-for="n in 3" :key="n"></i>
      </div>
      <div v-else-if="state === 'empty'" class="acc-empty">
        <b>当前筛选无企业数据</b>
        <span>空态不代表 0：所选窗口未命中企业诉求</span>
      </div>
      <div v-else-if="state === 'error'" class="acc-empty acc-empty--error">
        <b>企业指标加载失败</b>
        <span>{{ supply.error?.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>

      <template v-else>
        <!-- 每万户不可算（缺服务户数）→ 按企业诉求件数展示，明确标注口径 -->
        <div v-if="countMode" class="ent-rows">
          <button
            v-for="row in countRows"
            :key="row.enterpriseId"
            type="button"
            class="ent-row"
            :title="`诉求 ${row.demandCount} 件；点击查看该企业明细`"
            @click="drillEnterprise(row)"
          >
            <span class="ent-row__name">{{ row.name }}</span>
            <span class="ent-row__bar"><i :style="{ width: countBarWidth(row) }"></i></span>
            <span class="ent-row__val">{{ row.demandCount }}</span>
          </button>
          <span class="ent-row__unit">单位：件 · 点击企业行查看明细</span>
        </div>
        <!-- 全部不可计算：不画 0，直接给原因 -->
        <div v-else-if="!computable.length" class="acc-empty ent__all-na">
          <b>{{ naTitle ?? `不可计算：${reasonSummary || '缺户数'}` }}</b>
          <span>{{ naText ?? `${uncomputable.length} 家企业未维护服务户数或基期为零，按口径不画 0 柱` }}</span>
        </div>

        <!-- 企业少：紧凑行（宽度按最大比值归一），避免两根柱子摊满整卡 -->
        <div v-else-if="!useChart" class="ent-rows">
          <button
            v-for="row in computable"
            :key="row.enterpriseId"
            type="button"
            class="ent-row"
            :title="`诉求 ${row.demandCount} 件 · 服务户数 ${row.households?.toLocaleString('zh-CN') ?? '—'}；点击查看该企业明细`"
            @click="drillEnterprise(row)"
          >
            <span class="ent-row__name">{{ row.name }}</span>
            <span class="ent-row__bar"><i :style="{ width: barWidth(row) }"></i></span>
            <span class="ent-row__val">{{ row.ratio.value?.toFixed(2) }}</span>
          </button>
          <span class="ent-row__unit">单位：件/万户 · 点击企业行查看明细</span>
        </div>

        <EChart
          v-else
          class="ent-chart"
          :option="option"
          :style="{ flex: uncomputable.length ? '1 1 48%' : '1 1 100%' }"
          @chart-click="onChartClick"
        />

        <!-- 不可计算企业单列（缺户数 / 基期为零），禁止 0 冒充 -->
        <div v-if="uncomputable.length" class="ent-na">
          <div class="ent-na__title">不可计算清单（{{ uncomputable.length }}）</div>
          <button
            v-for="row in uncomputable"
            :key="row.enterpriseId"
            type="button"
            class="ent-na__row"
            :title="`诉求 ${row.demandCount} 件；点击查看该企业明细`"
            @click="drillEnterprise(row)"
          >
            <span class="ent-na__name">{{ row.name }}</span>
            <span class="st-uncomputable">不可计算：{{ row.reasonText ?? UNCOMPUTABLE_TEXT[row.ratio.reason] }}</span>
            <span class="ent-na__cnt">{{ row.demandCount }} 件</span>
          </button>
        </div>

        <!-- 说明收成一行，完整内容见悬停提示（原两段长文会把卡片下半截塞满小字） -->
        <div
          v-if="!useChart && countRows.length < 8"
          class="ent__hint ent__hint--compact"
          :title="hintFullText"
        >
          <b>口径</b>诉求 ÷ 服务户数 × 10000
          <span v-if="data?.meta.missingNote" class="ent__hint-tag">· 有数据缺项</span>
        </div>
      </template>
    </div>
    <CardFooter v-if="state === 'ready'" :items="footItems" drill-label="明细" @drill="drillAll" />
  </section>
</template>

<style scoped>
/* 压缩版口径说明：单行，不占半张卡片；完整说明走 title 悬停 */
.ent__hint--compact {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: #7ea8a0;
  cursor: help;
}
.ent__hint-tag {
  color: #ffd67c;
}
.ent {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
}
.ent-chart {
  flex: 1;
  min-height: 0;
  width: 100%;
}
/* 企业少时的紧凑行：整块面板 + 行间细分隔线，不再一行一个带边框的小盒子 */
.ent-rows {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 1px;
}
.ent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 2px;
  font-family: inherit;
  text-align: left;
  color: #d6f6ef;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.16);
  cursor: pointer;
}
.ent-row:hover {
  background: linear-gradient(90deg, rgba(31, 143, 129, 0.18), transparent);
}
.ent-row:hover .ent-row__val {
  color: #c4fff2;
}
.ent-row__name {
  flex: none;
  width: 64px;
  font-size: 10.5px;
  color: #cfeee7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ent-row__bar {
  position: relative;
  flex: 1;
  min-width: 24px;
  height: 9px;
  overflow: hidden;
  background: rgba(84, 213, 188, 0.08);
  border-radius: 0 2px 2px 0;
}
.ent-row__bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.45), #8fffe8);
  border-radius: 0 2px 2px 0;
}
.ent-row__val {
  flex: none;
  width: 42px;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 13px;
  text-align: right;
  color: #8fffe8;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ent-row__unit {
  padding: 2px 2px 0;
  font-size: 9px;
  color: #7fa9a0;
}
/* 剩余高度放口径 / 数据质量说明：贴合并把空白变成有用信息 */
.ent__hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  padding: 2px 2px 0;
  font-size: 9.5px;
  line-height: 1.45;
  color: #7fa9a0;
}
.ent__hint b {
  margin-right: 4px;
  font-weight: 600;
  color: #9bc9c5;
}
.ent-na {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 4px;
  border-top: 1px dashed rgba(52, 139, 124, 0.3);
}
.ent-na__title {
  font-size: 9.5px;
  color: #ffd67c;
  letter-spacing: 0.5px;
}
.ent-na__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 2px;
  font-family: inherit;
  font-size: 10.5px;
  text-align: left;
  color: #d6f6ef;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.14);
  cursor: pointer;
}
.ent-na__row:hover {
  background: linear-gradient(90deg, rgba(31, 143, 129, 0.18), transparent);
}
.ent-na__name {
  color: #cfeee7;
  white-space: nowrap;
}
.ent-na__row :deep(.st-uncomputable) {
  font-size: 10px;
  padding: 0 4px;
  border-color: rgba(157, 184, 202, 0.45);
  background: rgba(157, 184, 202, 0.06);
}
.ent-na__cnt {
  margin-left: auto;
  color: #8ab9b0;
  white-space: nowrap;
}
.ent-skeleton i {
  display: block;
  height: 16px;
  margin-bottom: 10px;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.18), rgba(134, 251, 231, 0.42));
  animation: ent-pulse 1.2s ease-in-out infinite alternate;
}
@keyframes ent-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
</style>






