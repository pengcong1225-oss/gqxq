<script setup lang="ts">
/** 满意与不满意占比环（分母 = 已评价件；未评价单列，不拉低满意率） */
import { computed } from 'vue';
import EChart from '../EChart.vue';
import ComputableValue from '../ComputableValue.vue';
import { C, FONT_FAMILY, baseTooltip } from '../../theme';
import type { EChartsCoreOption } from '../../echarts';
import { UNCOMPUTABLE_TEXT, type SatisfactionBreakdown } from '../../types';

const props = defineProps<{ data: SatisfactionBreakdown }>();

const rateUncomputable = computed(() => props.data.satisfiedRate.value === null);
const rateReason = computed(() =>
  props.data.satisfiedRate.value === null ? UNCOMPUTABLE_TEXT[props.data.satisfiedRate.reason] : ''
);

const option = computed<EChartsCoreOption>(() => {
  const items = props.data.items.filter((i) => i.value > 0);
  return {
    animationDuration: 700,
    tooltip: {
      ...baseTooltip({ trigger: 'item' }),
      formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}<br/><b style="color:#6ff0ff">${p.value}</b> 件 · ${p.percent.toFixed(1)}%`,
    },
    legend: {
      orient: 'horizontal',
      bottom: 0,
      left: 'center',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: C.sub, fontSize: 12, fontFamily: FONT_FAMILY },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '76%'],
        center: ['50%', '44%'],
        padAngle: 1,
        itemStyle: { borderRadius: 3, borderColor: '#071528', borderWidth: 2 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 5 },
        data: items.map((i) => ({
          name: i.name,
          value: i.value,
          itemStyle: {
            color:
              i.name === '满意'
                ? { type: 'linear', x: 0, y: 0, x2: 1, y2: 1, colorStops: [{ offset: 0, color: '#6ff0ff' }, { offset: 1, color: '#19a7d8' }] }
                : i.name === '不满意'
                  ? '#ff6b6b'
                  : 'rgba(140, 160, 175, 0.6)',
          },
        })),
      },
    ],
  };
});
</script>

<template>
  <div class="satisfaction">
    <div class="satisfaction__chart">
      <EChart :option="option" />
      <div v-if="!rateUncomputable" class="satisfaction__center">
        <ComputableValue :value="data.satisfiedRate" unit="%" :decimals="1" size="lg" />
        <span class="satisfaction__label">满意率（已评价）</span>
      </div>
      <div v-else class="satisfaction__na">不可计算：{{ rateReason }}</div>
    </div>
    <div class="satisfaction__note">
      满意 {{ data.satisfied }} · 不满意 {{ data.dissatisfied }} · 未评价 {{ data.unevaluated }}（未评价不进分母）
    </div>
  </div>
</template>

<style scoped>
.satisfaction {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.satisfaction__chart {
  position: relative;
  flex: 1;
  min-height: 0;
}
.satisfaction__center {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
  text-align: center;
  width: 124px;
}
.satisfaction__center :deep(.cv--lg) {
  font-size: 32px;
}
.satisfaction__center :deep(.st-uncomputable) {
  font-size: 11px;
  white-space: normal;
  line-height: 1.2;
  max-width: 118px;
}
.satisfaction__na {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 1px 7px;
  font-size: 11px;
  color: #9db8ca;
  border: 1px dashed rgba(157, 184, 202, 0.55);
  background: rgba(157, 184, 202, 0.08);
  white-space: nowrap;
}
.satisfaction__label {
  font-size: 11px;
  color: var(--st-muted);
}
.satisfaction__note {
  flex: none;
  font-size: 11px;
  color: var(--st-muted);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
