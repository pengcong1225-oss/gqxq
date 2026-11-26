<script setup lang="ts">
/**
 * ECharts 容器：唯一持有 echarts 实例，负责 init / setOption / resize / dispose / 点击事件。
 * - devicePixelRatio 按 designScale 放大，4K/拼接屏下不糊
 * - 窗口尺寸变化导致缩放比变化时重新 init（canvas DPR 需要重建才能变）
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { echarts, type EChartsCoreOption, type EChartsType } from '../echarts';
import { chartDpr } from '../theme';

const props = withDefaults(
  defineProps<{
    option: EChartsCoreOption;
    /** 容器高度，默认 100%（由父级面板决定） */
    height?: string;
    /** 空数据/不可计算时由父级遮罩，图不再绘制 */
    silent?: boolean;
  }>(),
  { height: '100%', silent: false }
);

const emit = defineEmits<{
  (e: 'chart-click', params: { name?: string; dataIndex?: number; data?: unknown; seriesName?: string }): void;
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;
let dpr = 0;
let resizeObserver: ResizeObserver | undefined;

function init() {
  if (!el.value) return;
  chart?.dispose();
  dpr = chartDpr();
  chart = echarts.init(el.value, undefined, { renderer: 'canvas', devicePixelRatio: dpr });
  chart.setOption(props.option, true);
  chart.off('click');
  chart.on('click', (params) => {
    const p = params as { name?: string; dataIndex?: number; data?: unknown; seriesName?: string };
    emit('chart-click', p);
  });
}

function onResize() {
  const nextDpr = chartDpr();
  if (Math.abs(nextDpr - dpr) > 0.15) {
    init();
    return;
  }
  chart?.resize();
}

onMounted(() => {
  init();
  if (el.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(el.value);
  }
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});

watch(
  () => props.option,
  (option) => {
    chart?.setOption(option, true);
  },
  { deep: true }
);

defineExpose({
  getChart: () => chart,
});
</script>

<template>
  <div ref="el" class="echart" :style="{ height }"></div>
</template>

<style scoped>
.echart {
  width: 100%;
  min-height: 0;
}
</style>
