<script setup lang="ts">
/**
 * 验收大屏 · 左栏「问题类型分布」（8002 版式）
 * 八类诉求横向柱状（ECharts 按需引入），点击柱子 → 地图定位 + 同条件明细。
 */
import { computed } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import type { DrillQuery, IndustryFilter, PanelState, PeriodMeta, SupplyData, TypeStat } from '@/stats/types';
import CardFooter from './CardFooter.vue';
import { TEAL, TEAL_FONT, tealBarGradient, tealTooltip } from './tealChart';

const props = defineProps<{
  supply: PanelState<SupplyData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
  /** 真实数据缺主数据时的空态标题/原因（由页面按真实缺项传入，不伪造分类） */
  emptyTitle?: string;
  emptyText?: string;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const data = computed(() => props.supply.data);
const types = computed<TypeStat[]>(() => data.value?.typeStats ?? []);
const state = computed(() => props.supply.status);

/** 紧凑行列表（本屏空间有限）：前 5 类逐行显示，其余合并为「其他 N 类」 */
const visibleTypes = computed(() => types.value.slice(0, 5));
const restTypes = computed(() => types.value.slice(5));
const restCount = computed(() => restTypes.value.reduce((a, t) => a + t.count, 0));
const maxType = computed(() => Math.max(1, ...visibleTypes.value.map((t) => t.count), restCount.value));
function typeBarWidth(row: { count: number }): string {
  return `${Math.max(6, Math.round((row.count / maxType.value) * 100))}%`;
}

function drillType(row: TypeStat) {
  emit('drill', {
    source: '验收大屏 · 问题类型分布',
    title: `${row.name} · 同类型诉求明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    typeId: row.typeId,
  });
}

/** 已分类合计 = 各类型件数之和（与下方柱状图同源，不另造数） */
const typeSum = computed(() => types.value.reduce((a, t) => a + t.count, 0));
/** 未映射 = 诉求总量 − 已分类合计；总量不可计算（null + reason）时为 null → 底部条显示「—」 */
const unmapped = computed<number | null>(() => {
  const total = data.value?.total.value;
  if (total == null) return null;
  return Math.max(0, total - typeSum.value);
});

/** 底部信息带：只在有真实分类数据时出示真实值；分类缺映射 / 空态时一律「—」，不拿 0 冒充 */
const footItems = computed(() => {
  const ready = state.value === 'ready' && types.value.length > 0;
  const unmappedCount = ready ? unmapped.value : null;
  return [
    { label: '合计', value: ready ? `${typeSum.value} 件` : '—', title: ready ? '已分类件数合计（各类型件数之和）' : '分类映射未配置，已分类合计不可用' },
    { label: '类型数', value: ready ? `${types.value.length} 类` : '—', title: ready ? '本窗口命中的诉求分类数' : '真实库缺诉求类型→标准分类对照' },
    {
      label: '未映射',
      value: unmappedCount == null ? '—' : `${unmappedCount} 件`,
      warn: unmappedCount != null && unmappedCount > 0,
      title:
        unmappedCount == null
          ? '分类映射未配置：无法计算已分类/未映射件数（不补 0）'
          : '未映射 = 诉求总量 − 已分类合计；点击右侧「明细」查看同条件全部类型明细',
    },
  ];
});

function drillAll() {
  emit('drill', {
    source: '验收大屏 · 问题类型分布',
    title: '所选窗口问题类型明细',
    period: props.periodMeta.key,
    industry: props.industry,
  });
}

const option = computed<EChartsCoreOption>(() => {
  const items = types.value;
  return {
    animation: false,
    grid: { left: 4, right: 40, top: 4, bottom: 2, containLabel: true },
    tooltip: {
      ...tealTooltip(),
      formatter: (p: unknown) => {
        const row = (p as { dataIndex: number }[])[0];
        const item = items[row?.dataIndex ?? 0];
        return item ? `<b>${item.name}</b><br/>诉求 ${item.count} 件 · 占比 ${item.share.toFixed(1)}%` : '';
      },
    },
    xAxis: { type: 'value', show: false },
    yAxis: {
      type: 'category',
      inverse: true,
      data: items.map((t) => t.name),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: TEAL.text, fontSize: 11, fontFamily: TEAL_FONT, width: 66, overflow: 'truncate' },
    },
    series: [
      {
        type: 'bar',
        data: items.map((t) => t.count),
        barMaxWidth: 11,
        itemStyle: { color: tealBarGradient(), borderRadius: [0, 2, 2, 0] },
        label: {
          show: true,
          position: 'right',
          color: TEAL.bright,
          fontSize: 10,
          fontFamily: TEAL_FONT,
          formatter: (p: { value: number }) => `${p.value}`,
        },
        emphasis: { itemStyle: { color: '#b9fff3' } },
      },
    ],
  };
});

function onChartClick(params: { name?: string; dataIndex?: number }) {
  const idx = params.dataIndex;
  if (idx == null) return;
  const hit = types.value[idx];
  if (!hit) return;
  emit('drill', {
    source: '验收大屏 · 问题类型分布',
    title: `${hit.name} · 同类型诉求明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    typeId: hit.typeId,
  });
}
</script>

<template>
  <section class="acc-card">
    <header class="acc-card__head">
      <h2>问题类型分布</h2>
      <small>{{ industry === 'ALL' ? '供水+供气' : industry === 'WATER' ? '供水' : '供气' }} · {{ periodMeta.label }}</small>
    </header>
    <div class="acc-card__body">
      <div v-if="!data || state === 'loading' || state === 'idle'" class="type-skeleton" aria-busy="true">
        <i v-for="n in 8" :key="n" :style="{ width: `${96 - n * 7}%` }"></i>
      </div>
      <div v-else-if="state === 'empty'" class="acc-empty">
        <b>{{ emptyTitle ?? '当前筛选无类型数据' }}</b>
        <span>{{ emptyText ?? '空态不代表 0 件：所选窗口未命中任何诉求分类' }}</span>
      </div>
      <div v-else-if="state === 'error'" class="acc-empty acc-empty--error">
        <b>问题类型加载失败</b>
        <span>{{ supply.error?.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="!types.length" class="acc-empty">
        <b>{{ emptyTitle ?? '暂无类型分布' }}</b>
        <span>{{ emptyText ?? '接口返回的分类列表为空' }}</span>
      </div>
      <div v-else class="type-rows">
          <button
            v-for="t in visibleTypes"
            :key="t.typeId"
            type="button"
            class="type-row"
            :title="`${t.name}：${t.count} 件（${t.share.toFixed(1)}%）；点击查看该类型明细`"
            @click="drillType(t)"
          >
            <span class="type-row__name">{{ t.name }}</span>
            <span class="type-row__bar"><i :style="{ width: typeBarWidth(t) }"></i></span>
            <span class="type-row__val">{{ t.count }}</span>
          </button>
          <button v-if="restTypes.length" type="button" class="type-row type-row--rest" :title="`其余 ${restTypes.length} 类合计 ${restCount} 件`" @click="drillAll">
            <span class="type-row__name">其他 {{ restTypes.length }} 类</span>
            <span class="type-row__bar"><i :style="{ width: typeBarWidth({ count: restCount } as any) }"></i></span>
            <span class="type-row__val">{{ restCount }}</span>
          </button>
        </div>
    </div>
    <CardFooter v-if="state === 'ready'" :items="footItems" drill-label="明细" @drill="drillAll" />
  </section>
</template>

<style scoped>
/* 类型多时的紧凑行列表：name | bar | count，避免轴标签竖排 */
.type-rows {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}
.type-row {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 6px;
  padding: 1px 2px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.12);
  color: #d6f6ef;
  font-family: inherit;
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
}
.type-row:last-child { border-bottom: 0; }
.type-row:hover { background: rgba(31, 143, 129, 0.16); }
.type-row__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #cfe9e3;
}
.type-row__bar {
  position: relative;
  height: 8px;
  border-radius: 2px;
  background: rgba(12, 65, 59, 0.6);
  overflow: hidden;
}
.type-row__bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #0f7d6c, #6ff0ff);
}
.type-row__val {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: #8fffe8;
}
.type-row--rest .type-row__name { color: #9db8ca; }
.type-chart {
  height: 100%;
}
.type-skeleton {
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  height: 100%;
  gap: 5px;
}
.type-skeleton i {
  display: block;
  height: 10px;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.18), rgba(134, 251, 231, 0.42));
  animation: type-pulse 1.2s ease-in-out infinite alternate;
}
@keyframes type-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
.no-motion .type-skeleton i {
  animation: none;
}
</style>



