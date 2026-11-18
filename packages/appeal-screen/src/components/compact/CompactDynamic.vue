<script setup lang="ts">
/** 集成式大屏 · 右栏「诉求动态」精简版：满意占比环 + 处理时长四档（互斥） */
import { computed } from 'vue';
import PanelShell from '@/stats/components/PanelShell.vue';
import SatisfactionDonut from '@/stats/components/charts/SatisfactionDonut.vue';
import DurationTable from '@/stats/components/tables/DurationTable.vue';
import type { DemandDynamicData, DrillQuery, DurationBucketRow, IndustryFilter, PanelState, PeriodMeta } from '@/stats/types';

const props = defineProps<{
  dynamic: PanelState<DemandDynamicData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const data = computed(() => props.dynamic.data);

const drillBucket = (row: DurationBucketRow) =>
  emit('drill', {
    source: '集成屏 · 动态 · 处理时长',
    title: `处理时长 ${row.bucket} · 明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    bucket: row.bucket,
  });
</script>

<template>
  <PanelShell
    title="诉求动态"
    :caption="`${periodMeta.range} · 满意/时长`"
    :state="dynamic"
    empty-text="当前筛选无动态数据"
    @retry="emit('retry')"
  >
    <template #extra><span class="st-chip">A27</span></template>
    <div v-if="data" class="cd">
      <div class="cd__sat">
        <SatisfactionDonut :data="data.satisfaction" />
      </div>
      <div class="cd__dur">
        <DurationTable :rows="data.durationBuckets" @select="drillBucket" />
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.cd {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}
.cd__sat {
  flex: 0 0 52%;
  min-height: 0;
}
.cd__dur {
  flex: 1;
  min-height: 0;
}
/* 紧凑化：表格字号与行高压缩，仍保留四档互斥语义 */
.cd__dur :deep(.dur) {
  font-size: 11px;
}
.cd__dur :deep(.dur__head) {
  height: 22px;
  font-size: 10.5px;
  grid-template-columns: 64px 1fr 62px 62px;
}
.cd__dur :deep(.dur__row) {
  grid-template-columns: 64px 1fr 62px 62px;
}
.cd__dur :deep(.dur__foot) {
  font-size: 9.5px;
}
.cd__dur :deep(.cv--sm) {
  font-size: 12px;
}
</style>
