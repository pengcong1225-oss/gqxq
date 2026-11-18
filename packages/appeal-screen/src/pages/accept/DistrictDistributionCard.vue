<script setup lang="ts">
/**
 * 验收大屏 · 右②区域分布
 * 六区环状图（环心总量）+ 未定位单列（不在环内、不参与六区着色）。
 * 点区 → 地图 fit 该区并高亮、统计面板收窄；点未定位 → 只开明细，不定位地图。
 */
import { computed } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import {
  UNCOMPUTABLE_TEXT,
  type DistrictStat,
  type IndustryFilter,
  type PanelState,
  type PeriodMeta,
  type SupplyData,
} from '@/stats/types';
import { TEAL, TEAL_FONT, tealTooltip } from './tealChart';
import CardFooter from './CardFooter.vue';

const props = defineProps<{
  supply: PanelState<SupplyData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
  selectedDistrict?: string | null;
  /** 当前选中类型（类型分布点击 / 分类筛选）；用于区县环按类型过滤 */
  selectedTypeId?: string | null;
  selectedTypeName?: string | null;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'select-district', payload: { districtCode: string; name: string }): void;
  (e: 'clear-district'): void;
  (e: 'drill-unlocated'): void;
}>();

const COLORS = ['#54d5bc', '#3999cb', '#f0c858', '#ec9161', '#9a8cda', '#8ecb79', '#b89b65'];

const data = computed(() => props.supply.data);
/** 固定标书六区（高新区使用真实库现有 420507；420500 历史写法归入其他） */
const FIXED_DISTRICTS = [
  { code: '420502', name: '西陵区' },
  { code: '420503', name: '伍家岗区' },
  { code: '420504', name: '点军区' },
  { code: '420505', name: '猇亭区' },
  { code: '420506', name: '夷陵区' },
  { code: '420507', name: '高新区' },
] as const;
const items = computed<DistrictStat[]>(() => {
  if (!data.value) return [];
  if (props.selectedTypeId) return data.value.districtByType?.[props.selectedTypeId]?.items ?? [];
  return data.value.district.items;
});
const unlocated = computed(() => {
  if (!data.value) return null;
  if (props.selectedTypeId) return data.value.districtByType?.[props.selectedTypeId]?.unlocated ?? null;
  return data.value.district.unlocated;
});
/** 固定六区 + 「其他（未列入标书）」；其他区县不并入六区 */
const ringItems = computed(() => {
  const map = new Map(items.value.map((d) => [d.districtCode, d]));
  const six = FIXED_DISTRICTS.map((d) => {
    const hit = map.get(d.code);
    return { districtCode: d.code, name: d.name, count: hit?.count ?? 0, share: hit?.share ?? 0 };
  });
  const fixedCodes = new Set<string>(FIXED_DISTRICTS.map((d) => d.code));
  const others = items.value.filter((d) => !fixedCodes.has(d.districtCode));
  const otherCount = others.reduce((a, d) => a + d.count, 0);
  const locatedSum = six.reduce((a, d) => a + d.count, 0) + otherCount;
  return [
    ...six,
    {
      districtCode: '__other__',
      name: '其他（未列入标书）',
      count: otherCount,
      share: locatedSum ? +((otherCount / locatedSum) * 100).toFixed(1) : 0,
      others: others.map((d) => `${d.name} ${d.count}`).join('、'),
    },
  ];
});
const total = computed(() => {
  if (!data.value) return null;
  if (props.selectedTypeId) {
    const located = ringItems.value.reduce((a, d) => a + d.count, 0);
    return { value: located + (unlocated.value ?? 0), reason: undefined } as { value: number | null; reason?: string };
  }
  return data.value.total;
});
const loading = computed(() => props.supply.status === 'loading' || props.supply.status === 'idle');
const empty = computed(() => {
  if (props.supply.status === 'empty') return true;
  if (props.supply.status !== 'ready') return false;
  if (!props.selectedTypeId) return !items.value.length;
  return !items.value.length && !!data.value?.districtByType && !data.value.districtByType[props.selectedTypeId];
});
const error = computed(() => (props.supply.status === 'error' ? props.supply.error : null));
const totalText = computed(() => (total.value?.value != null ? total.value.value.toLocaleString('zh-CN') : null));
const totalReason = computed(() =>
  total.value?.value === null ? `不可计算：${UNCOMPUTABLE_TEXT[total.value.reason]}` : ''
);

/** 区县合计 = 环形图各区件数之和（不含未定位单列）；空态/错误态显示「—」，不拿 0 冒充 */
const districtSum = computed(() => items.value.reduce((a, d) => a + d.count, 0));
const ready = computed(() => !loading.value && !error.value && !empty.value);
const footItems = computed(() => {
  const sixSum = ringItems.value.filter((d) => d.districtCode !== '__other__').reduce((a, d) => a + d.count, 0);
  const other = ringItems.value.find((d) => d.districtCode === '__other__');
  return [
    {
      label: '六区合计',
      value: ready.value ? `${sixSum} 件` : '—',
      title: '标书固定六区合计；其他区县单列，不并入六区',
    },
    {
      label: '其他',
      value: ready.value ? `${other?.count ?? 0} 件` : '—',
      title: '未列入标书的区县合计（不并入选标书六区）',
      warn: ready.value && (other?.count ?? 0) > 0,
    },
    {
      label: '未定位',
      value: ready.value ? `${unlocated.value ?? 0} 件` : '—',
      warn: ready.value && (unlocated.value ?? 0) > 0,
      itemKey: 'unlocated',
      title: '未定位件不并入区县、不参与环形着色；点击只打开明细，不定位地图',
    },
  ];
});

function onFootItem(key: string) {
  if (key === 'unlocated') emit('drill-unlocated');
}

const option = computed<EChartsCoreOption>(() => ({
  animation: false,
  tooltip: {
    ...tealTooltip(),
    trigger: 'item',
    formatter: (p: unknown) => {
      const item = (p as { data?: { code?: string; name?: string; value?: number; share?: number; others?: string } }).data;
      if (!item) return '';
      const extra = item.code === '__other__' && item.others ? `<br/>${item.others}` : '';
      return `<b>${item.name}</b><br/>诉求 ${item.value ?? 0} 件 · 占比 ${(item.share ?? 0).toFixed(1)}%${extra}<br/>点击 → 地图定位并收窄统计`;
    },
  },
  series: [
    {
      type: 'pie',
      radius: ['46%', '70%'],
      center: ['50%', '46%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: 'rgba(6, 29, 30, 0.9)', borderWidth: 2 },
      label: {
        color: TEAL.text,
        fontSize: 10,
        fontFamily: TEAL_FONT,
        formatter: (p: { name?: string; value?: number }) => `${p.name ?? ''}\n${p.value ?? 0}`,
      },
      labelLine: { length: 6, length2: 6, lineStyle: { color: TEAL.border } },
      data: ringItems.value.map((d, i) => ({
        name: d.name,
        value: d.count,
        code: d.districtCode,
        share: d.share,
        others: (d as { others?: string }).others,
        selected: !!props.selectedDistrict && d.districtCode === props.selectedDistrict,
        itemStyle: {
          color: COLORS[i % COLORS.length],
          opacity: props.selectedDistrict
            ? d.districtCode === props.selectedDistrict
              ? 1
              : 0.42
            : 1,
          borderColor:
            props.selectedDistrict && d.districtCode === props.selectedDistrict ? TEAL.bright : 'rgba(6, 29, 30, 0.9)',
          borderWidth: props.selectedDistrict && d.districtCode === props.selectedDistrict ? 2 : 1,
        },
      })),
    },
  ],
}));

function onChartClick(params: { name?: string; dataIndex?: number; data?: unknown }) {
  const item = (params.data ?? {}) as { code?: string; name?: string };
  const code = item.code ?? ringItems.value[params.dataIndex ?? -1]?.districtCode;
  if (!code || code === '__other__') return;
  const hit = items.value.find((d) => d.districtCode === code);
  emit('select-district', { districtCode: code, name: hit?.name ?? item.name ?? '' });
}
</script>

<template>
  <section class="acc-card dd">
    <header class="acc-card__head">
      <h2>区域分布</h2>
      <small>{{ selectedTypeId ? `按类型：${selectedTypeName || selectedTypeId} · ` : '' }}{{ selectedDistrict ? '已定位，点击他区可切换' : '固定标书六区 + 其他 · 未定位单列' }}</small>
      <button v-if="selectedDistrict" type="button" class="dd__clear" @click="emit('clear-district')">清除区收窄 ×</button>
    </header>
    <div class="acc-card__body dd__body">
      <div v-if="loading" class="dd__skeleton" aria-busy="true">
        <i></i>
      </div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>区域分布加载失败</b>
        <span>{{ error.message }}</span>
        <span class="acc-empty__trace">code={{ error.code }} · traceId={{ error.traceId }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="empty" class="acc-empty">
        <b>当前筛选无区域数据</b>
        <span>空态不代表 0：所选窗口 / 行业 / 网格未命中任何工单</span>
      </div>
      <template v-else>
        <div class="dd__chart-wrap">
          <EChart class="dd__chart" :option="option" @chart-click="onChartClick" />
          <div class="dd__center">
            <b v-if="totalText">{{ totalText }}</b>
            <b v-else class="dd__center-na">{{ totalReason || '不可计算' }}</b>
            <span v-if="totalText">件 · 合计</span>
            <span v-else>不补 0</span>
          </div>
        </div>
      </template>
    </div>
    <CardFooter v-if="ready" :items="footItems" @item-click="onFootItem" />
  </section>
</template>

<style scoped>
.dd__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 2px;
}
.dd__chart-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}
.dd__chart {
  position: absolute;
  inset: 0;
}
.dd__center {
  position: absolute;
  left: 50%;
  top: 46%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  pointer-events: none;
  white-space: nowrap;
}
.dd__center b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 24px;
  color: #8fffe8;
  letter-spacing: 0;
  line-height: 1.1;
}
.dd__center b.dd__center-na {
  font-family: 'Bahnschrift', 'Microsoft YaHei', sans-serif;
  font-size: 11px;
  color: #9db8ca;
  line-height: 1.25;
  white-space: normal;
  max-width: 78px;
  text-align: center;
}
.dd__center span {
  font-size: 9.5px;
  color: #7fa9a0;
}
/* 注：原「未定位」独立小盒已移入卡片底部信息带（仍保留「只开明细、不定位地图」交互）；
   区县收窄的清除入口移到卡头，避免底部再出现第二个带边框的小按钮。 */
.dd__clear {
  flex: none;
  padding: 1px 6px;
  font-family: inherit;
  font-size: 10px;
  color: #86fbe7;
  background: transparent;
  border: 1px solid rgba(52, 139, 124, 0.5);
  cursor: pointer;
}
.dd__clear:hover {
  background: #1b7466;
  color: #fff;
}
.dd__skeleton {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dd__skeleton i {
  width: 132px;
  height: 132px;
  border-radius: 50%;
  border: 12px solid rgba(84, 213, 188, 0.18);
  background: radial-gradient(circle, rgba(84, 213, 188, 0.14), transparent 65%);
  animation: dd-pulse 1.2s ease-in-out infinite alternate;
}
@keyframes dd-pulse {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 1;
  }
}
</style>
