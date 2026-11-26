<script setup lang="ts">
/**
 * 验收大屏 · 底部「TOP3 跑马灯」（8002 版式）
 * 5s 自动切换、可暂停/前后翻；数据使用真实接口的 topTypes（真实侧不可用时显示后端原因）。
 * 真实数据：往年同期 Top3 需要历史覆盖与业务季节口径，后端未发布时显示「不可用」原因，不补数。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DrillQuery, IndustryFilter, PanelState, PeriodMeta, TopTypesData } from '@/stats/types';

const props = defineProps<{
  topTypes: PanelState<TopTypesData>;
  periodMeta: PeriodMeta;
  industry: IndustryFilter;
  noMotion?: boolean;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const items = computed(() => (props.topTypes.status === 'ready' ? props.topTypes.data?.items ?? [] : []));
const index = ref(0);
const paused = ref(false);
let timer: number | null = null;

const current = computed(() => items.value[index.value % Math.max(1, items.value.length)] ?? null);

function next() {
  if (items.value.length) index.value = (index.value + 1) % items.value.length;
}
function prev() {
  if (items.value.length) index.value = (index.value - 1 + items.value.length) % items.value.length;
}
function tick() {
  if (!paused.value) next();
}

function start() {
  stop();
  if (props.noMotion) return;
  timer = window.setInterval(tick, 5000);
}
function stop() {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

onMounted(start);
onBeforeUnmount(stop);
watch(
  () => props.noMotion,
  () => start()
);
watch(items, () => {
  index.value = 0;
});

function drillCurrent() {
  const item = current.value;
  if (!item?.evidence) return;
  emit('drill', {
    source: '验收大屏 · 往年同期 TOP3',
    title: `${item.title} · 关联明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    evidence: item.evidence,
  });
}
</script>

<template>
  <div class="ticker" :class="{ 'no-motion': noMotion }">
    <span class="ticker__label">
      往年同期 TOP3
      <small v-if="current">{{ topTypes.data?.coverage }}</small>
    </span>

    <div class="ticker__body">
      <button
        v-if="current"
        type="button"
        class="ticker__item"
        :title="current.hint"
        :disabled="!current.evidence"
        @click="drillCurrent"
      >
        <i class="ticker__rank">TOP{{ current.rank }}</i>
        <b>{{ current.typeName }}</b>
        <span>{{ current.count }} 件</span>
        <span class="ticker__share" title="占比分母=TOP3 合计（历史覆盖未知，不是全量占比）">占 TOP3 {{ current.share.toFixed(1) }}%</span>
        <em v-if="current.evidence">查看证据 ›</em>
      </button>
      <span v-else-if="topTypes.status === 'loading' || topTypes.status === 'idle'" class="ticker__empty">TOP3 研判加载中…</span>
      <span v-else class="ticker__empty">{{ topTypes.data?.emptyReason || '暂无往年同期 TOP3 数据' }}</span>
    </div>

    <div class="ticker__ops">
      <span class="ticker__dots" aria-hidden="true">
        <i v-for="(it, i) in items" :key="it.rank" :class="{ 'is-on': i === index % Math.max(1, items.length) }"></i>
      </span>
      <button type="button" title="上一条" @click="prev">‹</button>
      <button type="button" :title="paused ? '继续' : '暂停'" @click="paused = !paused">{{ paused ? '▶' : '⏸' }}</button>
      <button type="button" title="下一条" @click="next">›</button>
    </div>
  </div>
</template>

<style scoped>
/* 与卡片统一：同色边框 / 同底渐变 / 与卡片底部信息带同级字号（11px），避免和卡片高度参差 */
.ticker {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  background: linear-gradient(100deg, rgba(5, 35, 33, 0.94), rgba(3, 24, 25, 0.86));
  border: 1px solid rgba(51, 139, 124, 0.5);
  box-shadow: inset 0 0 18px rgba(11, 73, 64, 0.28);
  font-size: 11px;
  color: #a2eee0;
}
.ticker__label {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-right: 8px;
  border-right: 1px solid rgba(83, 191, 173, 0.22);
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 13px;
  letter-spacing: 1.5px;
  color: #b9fff3;
  line-height: 1.15;
}
.ticker__label small {
  font-family: 'Bahnschrift', 'Microsoft YaHei', sans-serif;
  font-size: 9px;
  letter-spacing: 0.4px;
  color: #7fa9a0;
}
.ticker__body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.ticker__item {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 7px;
  font-family: inherit;
  font-size: 11px;
  white-space: nowrap;
  color: #d6f6ef;
  background: transparent;
  border: 0;
  cursor: pointer;
  overflow: hidden;
}
.ticker__item:hover {
  background: linear-gradient(90deg, rgba(31, 143, 129, 0.2), transparent);
}
.ticker__rank {
  flex: none;
  padding: 1px 5px;
  font-style: normal;
  font-size: 9.5px;
  font-weight: 700;
  color: #041d1e;
  background: #86fbe7;
}
.ticker__item b {
  font-size: 12px;
  color: #eafffa;
}
.ticker__share {
  color: #8ab9b0;
}
.ticker__item em {
  margin-left: 4px;
  font-style: normal;
  color: #86fbe7;
}
.ticker__empty {
  color: #9bc9c5;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ticker__ops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.ticker__dots {
  display: flex;
  gap: 2px;
  margin-right: 6px;
}
.ticker__dots i {
  width: 4px;
  height: 4px;
  background: rgba(134, 251, 231, 0.25);
}
.ticker__dots i.is-on {
  background: #86fbe7;
  box-shadow: 0 0 4px #86fbe7;
}
.ticker__ops button {
  padding: 1px 7px;
  font-family: inherit;
  font-size: 11px;
  color: #d6f6ef;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.ticker__ops button:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
</style>
