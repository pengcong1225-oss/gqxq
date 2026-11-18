<script setup lang="ts">
/** 数据预警：列表 + 点击行展开详情卡（事件 / 影响网格 / 时间 / 相关诉求） */
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import type { DrillQuery, IndustryFilter, PanelState, PeriodMeta, WarningItem, WarningLevel, WarningListData } from '../types';

const props = withDefaults(
  defineProps<{
    warnings: PanelState<WarningListData>;
    periodMeta: PeriodMeta;
    industry: IndustryFilter;
    /** 集成屏右栏空间小：隐藏长 caption、压缩徽标 */
    compact?: boolean;
  }>(),
  { compact: false }
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const selected = ref<WarningItem | null>(null);

const items = computed(() => props.warnings.data?.items ?? []);
const countByLevel = computed(() => {
  const acc: Record<WarningLevel, number> = { RED: 0, ORANGE: 0, YELLOW: 0 };
  for (const w of items.value) acc[w.level] += 1;
  return acc;
});
const hasItems = computed(() => items.value.length > 0);

const LEVEL_TEXT: Record<WarningLevel, string> = { RED: '高危', ORANGE: '关注', YELLOW: '提示' };
const CATEGORY_TEXT: Record<WarningItem['category'], string> = {
  SAME_EVENT: '同事件跨网格',
  DEMAND_SPIKE: '诉求激增',
  REGION_ANOMALY: '区域异常',
  SATISFACTION_DROP: '满意度下降',
  UNLOCATED: '未定位',
  DATA_QUALITY: '数据质量',
};

const fmt = (iso: string) => {
  const m = iso.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : iso;
};

function openDetail(w: WarningItem) {
  selected.value = w;
}

function drillWarning(w: WarningItem) {
  emit('drill', {
    source: '数据预警 · 关联诉求',
    title: `${w.title} · 关联诉求明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    ...(w.eventNo ? { eventNo: w.eventNo } : {}),
  });
  selected.value = null;
}
</script>

<template>
  <div class="warn">
    <PanelShell
      title="数据预警"
      :caption="compact ? '点击行看详情' : '点击行 → 详情卡（事件/影响网格/时间/相关诉求）'"
      :state="warnings"
      empty-title="暂无预警"
      :empty-text="'当前统计期间未触发预警规则（同事件跨网格 / 诉求激增 / 区域异常 / 满意度下降 / 未定位 / 数据质量）'"
      @retry="emit('retry')"
    >
      <template #extra>
        <span class="st-chip st-chip--red">危 {{ countByLevel.RED }}</span>
        <span class="st-chip st-chip--warn">关注 {{ countByLevel.ORANGE }}</span>
        <span class="st-chip">提示 {{ countByLevel.YELLOW }}</span>
      </template>

      <div v-if="hasItems" class="warn__list">
        <button
          v-for="w in items"
          :key="w.warningId"
          type="button"
          class="warn__row"
          :class="`is-${w.level.toLowerCase()}`"
          @click="openDetail(w)"
        >
          <span class="warn__level">{{ LEVEL_TEXT[w.level] }}</span>
          <span class="warn__main">
            <span class="warn__title">{{ w.title }}</span>
            <span class="warn__meta">
              <i>{{ CATEGORY_TEXT[w.category] }}</i>
              <i v-if="w.eventNo">{{ w.eventNo }}</i>
              <i>{{ fmt(w.detectedAt) }}</i>
              <i>关联 {{ w.relatedDemandCount }} 件</i>
            </span>
          </span>
          <span class="warn__arrow">›</span>
        </button>
      </div>

      <!-- 详情卡 -->
      <div v-if="selected" class="warn__detail" role="dialog" aria-label="预警详情">
        <header class="warn__detail-head">
          <span class="warn__level" :class="`is-${selected.level.toLowerCase()}`">{{ LEVEL_TEXT[selected.level] }}</span>
          <b>{{ selected.title }}</b>
          <button type="button" class="warn__close" @click="selected = null">✕</button>
        </header>
        <div class="warn__detail-body">
          <p class="warn__desc">{{ selected.description }}</p>
          <dl class="warn__kv">
            <dt>事件号</dt>
            <dd>{{ selected.eventNo ?? '非事件类预警' }}</dd>
            <dt>时间范围</dt>
            <dd>{{ fmt(selected.timeRange[0]) }} ~ {{ fmt(selected.timeRange[1]) }}</dd>
            <dt>相关诉求</dt>
            <dd>{{ selected.relatedDemandCount }} 件</dd>
            <dt>影响网格</dt>
            <dd>
              <template v-if="selected.affectedGrids.length">
                <span v-for="g in selected.affectedGrids" :key="g.gridCode" class="warn__grid">
                  {{ g.gridName }}<i>{{ g.communityName }}</i><b>{{ g.demandCount }} 件</b>
                </span>
              </template>
              <span v-else class="warn__grid-empty">无网格级影响（未定位/数据质量类）</span>
            </dd>
            <dt>处置建议</dt>
            <dd>{{ selected.suggestion }}</dd>
          </dl>
          <div class="warn__actions">
            <button type="button" class="warn__btn" @click="drillWarning(selected)">查看关联诉求明细</button>
            <button type="button" class="warn__btn warn__btn--ghost" @click="selected = null">关闭</button>
          </div>
        </div>
      </div>
    </PanelShell>
  </div>
</template>

<style scoped>
.warn {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.warn :deep(.st-panel__extra) {
  gap: 4px;
  overflow: hidden;
}
.warn :deep(.st-panel__extra .st-chip) {
  font-size: 10px;
  padding: 0 5px;
}
.warn :deep(.st-panel__caption) {
  max-width: 150px;
}
.warn :deep(.st-panel) {
  height: 100%;
}
.warn__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  overflow: auto;
}
.warn__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  text-align: left;
  font-family: inherit;
  color: var(--st-text);
  background: rgba(12, 38, 62, 0.55);
  border: 1px solid rgba(53, 224, 255, 0.16);
  border-left: 3px solid rgba(53, 224, 255, 0.4);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.warn__row:hover {
  background: rgba(20, 62, 96, 0.75);
  border-color: rgba(53, 224, 255, 0.5);
}
.warn__row.is-red {
  border-left-color: #ff5b5b;
}
.warn__row.is-orange {
  border-left-color: #ff9f43;
}
.warn__row.is-yellow {
  border-left-color: #ffd166;
}
.warn__level {
  flex: none;
  padding: 1px 6px;
  font-size: 11px;
  color: #ffb3b3;
  border: 1px solid rgba(255, 91, 91, 0.45);
  background: rgba(255, 91, 91, 0.1);
  white-space: nowrap;
}
.warn__level.is-orange {
  color: #ffd0a0;
  border-color: rgba(255, 159, 67, 0.5);
  background: rgba(255, 159, 67, 0.1);
}
.warn__level.is-yellow {
  color: #ffe2a3;
  border-color: rgba(255, 209, 102, 0.45);
  background: rgba(255, 209, 102, 0.08);
}
.warn__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.warn__title {
  font-size: 13.5px;
  color: #e8f7ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.warn__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--st-muted);
  overflow: hidden;
}
.warn__meta i {
  font-style: normal;
  white-space: nowrap;
}
.warn__arrow {
  flex: none;
  color: var(--st-cyan);
  font-size: 16px;
}
.warn__detail {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: column;
  background: rgba(4, 18, 33, 0.98);
  border: 1px solid var(--st-border-strong);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
  z-index: 5;
  animation: warn-in 0.18s ease;
}
@keyframes warn-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.warn__detail-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(53, 224, 255, 0.18);
}
.warn__detail-head b {
  font-size: 13.5px;
  color: #eaf8ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.warn__close {
  margin-left: auto;
  flex: none;
  width: 22px;
  height: 22px;
  color: #a9cbe2;
  background: transparent;
  border: 1px solid rgba(169, 203, 226, 0.3);
  cursor: pointer;
}
.warn__detail-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.warn__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: #9fc3dc;
}
.warn__kv {
  margin: 0;
  display: grid;
  grid-template-columns: 58px 1fr;
  gap: 5px 8px;
  font-size: 12px;
}
.warn__kv dt {
  color: var(--st-muted);
}
.warn__kv dd {
  margin: 0;
  color: #cfe9fb;
  line-height: 1.5;
}
.warn__grid {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 8px 4px 0;
  padding: 1px 6px;
  background: rgba(53, 224, 255, 0.07);
  border: 1px solid rgba(53, 224, 255, 0.18);
  white-space: nowrap;
}
.warn__grid i {
  font-style: normal;
  color: var(--st-muted);
  font-size: 11px;
}
.warn__grid b {
  color: #9ff2ff;
  font-weight: 500;
}
.warn__grid-empty {
  color: var(--st-muted);
}
.warn__actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.warn__btn {
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  color: #04121f;
  background: linear-gradient(180deg, #6ff0ff, #1fb9d9);
  border: 1px solid #6ff0ff;
  cursor: pointer;
}
.warn__btn--ghost {
  color: var(--st-cyan);
  background: rgba(53, 224, 255, 0.08);
}
</style>
