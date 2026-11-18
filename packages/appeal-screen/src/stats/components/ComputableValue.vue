<script setup lang="ts">
/**
 * 可计算数值的统一渲染：
 *  - 有值 → 支持千分位/小数位/单位
 *  - null + reason → 显示「不可计算：无样本/基期为零/缺户数/历史缺失」，**永不显示 0**
 */
import { computed } from 'vue';
import { UNCOMPUTABLE_TEXT, type Computable } from '../types';

const props = withDefaults(
  defineProps<{
    value: Computable<number | string>;
    unit?: string;
    decimals?: number;
    size?: 'sm' | 'md' | 'lg';
    /** 为 true 时不显示「不可计算：」前缀，只显示原因（空间紧张时用） */
    short?: boolean;
  }>(),
  { unit: '', decimals: 0, size: 'md', short: false }
);

const available = computed(() => props.value.value !== null);
const reasonText = computed(() =>
  props.value.value === null ? `${props.short ? '' : '不可计算：'}${UNCOMPUTABLE_TEXT[props.value.reason]}` : ''
);
const display = computed(() => {
  const v = props.value.value;
  if (v === null) return '';
  if (typeof v === 'number') {
    const fixed = v.toFixed(props.decimals);
    const [int, dec] = fixed.split('.');
    const intText = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec ? `${intText}.${dec}` : intText;
  }
  return v;
});
</script>

<template>
  <span v-if="available" class="cv" :class="`cv--${size}`">
    {{ display }}<em v-if="unit" class="cv__unit">{{ unit }}</em>
  </span>
  <span v-else class="st-uncomputable cv-un" :title="reasonText">{{ reasonText }}</span>
</template>

<style scoped>
.cv {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  color: #eaf8ff;
  letter-spacing: 0.5px;
  line-height: 1.1;
}
.cv--sm {
  font-size: 16px;
}
.cv--md {
  font-size: 22px;
}
.cv--lg {
  font-size: 40px;
  font-weight: 600;
}
.cv__unit {
  margin-left: 3px;
  font-size: 0.5em;
  font-style: normal;
  color: var(--st-sub);
}
.cv-un {
  font-size: 13px;
}
</style>
