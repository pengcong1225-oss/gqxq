<script setup lang="ts">
/**
 * 处理时长互斥四档表：[0,24]、(24,48]、(48,72]、>72
 * 四档互斥且合计=总数；满意%/不满意% 分母为该档**有效评价**（rated=满意+基本满意+不满意），
 * 未评价/暂无回复单列不进分母；无有效评价时显示「不可计算」，不补 0。
 */
import { computed } from 'vue';
import ComputableValue from '../ComputableValue.vue';
import { UNCOMPUTABLE_TEXT, type DurationBucketRow } from '../../types';

const props = defineProps<{ rows: DurationBucketRow[] }>();
const emit = defineEmits<{ (e: 'select', row: DurationBucketRow): void }>();

const total = computed(() => props.rows.reduce((a, b) => a + b.demandCount, 0));
const maxCount = computed(() => Math.max(1, ...props.rows.map((r) => r.demandCount)));
const share = (n: number) => (total.value > 0 ? (n / total.value) * 100 : 0);
const naText = (row: DurationBucketRow) => {
  const v = row.satisfiedRate;
  return v.value === null ? `不可计算：${UNCOMPUTABLE_TEXT[v.reason]}` : '';
};
</script>

<template>
  <div class="dur">
    <div class="dur__head">
      <span>档位</span>
      <span>诉求量</span>
      <span>满意%</span>
      <span>不满意%</span>
    </div>
    <div
      v-for="row in rows"
      :key="row.bucket"
      class="dur__row"
      role="button"
      tabindex="0"
      :title="`${row.label}：点击查看该档明细`"
      @click="emit('select', row)"
      @keydown.enter="emit('select', row)"
    >
      <span class="dur__label">{{ row.label || row.bucket }}</span>
      <span class="dur__count">
        <i class="dur__bar" :style="{ width: `${(row.demandCount / maxCount) * 100}%` }"></i>
        <b>{{ row.demandCount }}</b>
        <em>{{ share(row.demandCount).toFixed(1) }}%</em>
      </span>
      <span class="dur__rate">
        <ComputableValue v-if="row.satisfiedRate.value !== null" :value="row.satisfiedRate" unit="%" :decimals="1" size="sm" />
        <span v-else class="st-uncomputable" :title="naText(row)">不可计算</span>
      </span>
      <span class="dur__rate dur__rate--bad">
        <ComputableValue v-if="row.dissatisfiedRate.value !== null" :value="row.dissatisfiedRate" unit="%" :decimals="1" size="sm" />
        <span v-else class="st-uncomputable" :title="naText(row)">不可计算</span>
      </span>
    </div>
    <div class="dur__foot">
      四档互斥，合计 {{ total }} 件 = 当前期间总数；满意% + 不满意% 分母=该档有效评价（rated），未评价/暂无回复不进分母
    </div>
  </div>
</template>

<style scoped>
.dur {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
}
.dur__head,
.dur__row {
  display: grid;
  grid-template-columns: 86px 1fr 82px 82px;
  align-items: center;
  gap: 8px;
}
.dur__head {
  flex: none;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--st-muted);
  background: rgba(53, 224, 255, 0.06);
  border-bottom: 1px solid rgba(53, 224, 255, 0.16);
}
.dur__row {
  flex: 1;
  min-height: 0;
  padding: 0 8px;
  cursor: pointer;
  border-bottom: 1px dashed rgba(53, 224, 255, 0.1);
}
.dur__row:hover {
  background: rgba(53, 224, 255, 0.08);
}
.dur__label {
  color: #cfe9fb;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dur__count {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #eaf8ff;
}
.dur__count b {
  position: relative;
  z-index: 1;
  font-weight: 600;
  min-width: 22px;
}
.dur__count em {
  position: relative;
  z-index: 1;
  font-style: normal;
  font-size: 11px;
  color: var(--st-muted);
}
.dur__bar {
  position: absolute;
  left: 0;
  top: 50%;
  height: 14px;
  transform: translateY(-50%);
  background: linear-gradient(90deg, rgba(53, 224, 255, 0.22), rgba(53, 224, 255, 0.04));
  max-width: 62%;
}
.dur__rate {
  color: #d5f4ff;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dur__rate--bad {
  color: #ffb0b0;
}
.dur__foot {
  flex: none;
  padding-top: 4px;
  font-size: 11px;
  color: var(--st-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
