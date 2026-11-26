<script setup lang="ts">
/**
 * 验收大屏 · 右③高频诉求小区 Top10
 * 按诉求件数降序（并列用小区名稳定排序），每行显示小区 / 网格 / 件数 / 满意率（分母=已评价件）。
 * 满意率 null 时显示「不可计算：无有效评价」，绝不补 0。
 */
import { computed } from 'vue';
import {
  type CommunityRow,
  type DrillQuery,
  type IndustryFilter,
  type PanelState,
  type PeriodMeta,
  type SupplyData,
} from '@/stats/types';
import CardFooter from './CardFooter.vue';

const props = defineProps<{
  supply: PanelState<SupplyData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
  /** 真实数据缺小区/网格主数据时的空态标题与原因 */
  emptyTitle?: string;
  emptyText?: string;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
  /**
   * 定位到小区（用户点行主体时触发）。
   * 只移动地图视野 + 高亮，**不改筛选、不开明细** —— 用户明确要求「点小区就是到具体位置」。
   */
  (e: 'locate', q: DrillQuery): void;
  /** 看该小区的诉求明细（用户点行尾「明细」按钮时触发，显式动作才展开） */
  (e: 'detail', q: DrillQuery): void;
}>();

const loading = computed(() => props.supply.status === 'loading' || props.supply.status === 'idle');
const empty = computed(() => props.supply.status === 'empty' || (props.supply.status === 'ready' && !rows.value.length));
const error = computed(() => (props.supply.status === 'error' ? props.supply.error : null));

const rows = computed<CommunityRow[]>(() =>
  [...(props.supply.data?.communityTop.items ?? [])]
    .sort((a, b) => b.count - a.count || a.communityName.localeCompare(b.communityName, 'zh-CN'))
    .slice(0, 10)
);

/** 满意率分母（已评价件）= 诉求总量 − 缺评价件数；任一项缺失时为 null → 底部条「—」 */
const evaluatedDenominator = computed<number | null>(() => {
  const total = props.supply.data?.total.value;
  const missing = props.supply.data?.meta.missingEvaluationCount;
  if (total == null || missing == null) return null;
  return Math.max(0, total - missing);
});

const footItems = computed(() => {
  const ready = props.supply.status === 'ready';
  const captured = props.supply.data?.communityTop.captured;
  return [
    {
      label: '覆盖小区',
      value: ready && captured != null ? `${captured} 个` : '—',
      title: '当前窗口可统计到的小区数（可能少于 10）',
    },
    {
      label: '已评价分母',
      value: ready && evaluatedDenominator.value != null ? `${evaluatedDenominator.value} 件` : '—',
      title: '满意率分母 = 诉求总量 − 缺评价件数（meta.missingEvaluationCount）；不拿 0 冒充',
    },
  ];
});

function drillAll() {
  emit('drill', {
    source: '验收大屏 · 高频诉求小区 Top10',
    title: '高频诉求小区明细（Top10）',
    period: props.periodMeta.key,
    industry: props.industry,
  });
}

function satText(row: CommunityRow): string {
  const sat = row.satisfactionRate;
  if (!sat || sat.value === null) return '不可计算：无有效评价';
  return `${sat.value.toFixed(1)}%`;
}

function satAvailable(row: CommunityRow): boolean {
  return !!row.satisfactionRate && row.satisfactionRate.value !== null;
}

/** 行数据的查询描述（定位与明细共用同一份条件，避免两处拼参数走样） */
function rowQuery(row: CommunityRow): DrillQuery {
  return {
    source: '验收大屏 · 高频诉求小区 Top10',
    title: `${row.communityName} · 同小区诉求明细`,
    period: props.periodMeta.key,
    industry: props.industry,
    ...(row.communityCode ? { communityCode: row.communityCode } : {}),
    ...(row.communityName ? { communityName: row.communityName } : {}),
  };
}

/**
 * 点击行主体 → **只定位**到该小区在地图上的具体位置并高亮。
 *
 * 原实现直接 emit('drill') 打开明细、并把 communityFilter 落到筛选条，
 * 效果是整屏数据被收窄成一个小区 —— 用户反馈这不是「定位」而是「筛选」，已按此修正。
 */
function locateRow(row: CommunityRow) {
  emit('locate', rowQuery(row));
}

/** 点击行尾「明细」按钮 → 打开该小区诉求明细（显式动作，不会误触） */
function detailRow(row: CommunityRow) {
  emit('detail', rowQuery(row));
}
</script>

<template>
  <section class="acc-card ct">
    <header class="acc-card__head">
      <h2>高频诉求小区</h2>
      <small>Top10 · 满意率分母=已评价件</small>
    </header>
    <div class="acc-card__body ct__body">
      <div v-if="loading" class="ct__skeleton" aria-busy="true">
        <i v-for="n in 10" :key="n"></i>
      </div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>高频小区加载失败</b>
        <span>{{ error.message }}</span>
        <span class="acc-empty__trace">code={{ error.code }} · traceId={{ error.traceId }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>
      <div v-else-if="empty" class="acc-empty">
        <b>{{ emptyTitle ?? '当前筛选无高频小区' }}</b>
        <span>{{ emptyText ?? '空态不代表 0：所选窗口 / 行业 / 网格未命中任何工单' }}</span>
      </div>

      <div v-else class="ct__list">
        <div class="ct__head-row">
          <span aria-hidden="true"></span>
          <span>小区 / 网格</span>
          <span>件数</span>
          <span title="满意率 = 有效评价数 / 已评价件数；无有效评价时显示 —">满意率</span>
        </div>
        <div
          v-for="row in rows"
          :key="`${row.rank}-${row.communityName}`"
          class="ct__row"
          role="button"
          tabindex="0"
          @keydown.enter.prevent="locateRow(row)"
          :title="`${row.communityName} / ${row.gridName} · ${row.count} 件；点击行 → 地图定位到该小区`"
          @click="locateRow(row)"
        >
          <i class="ct__rank" :class="{ 'is-top3': row.rank <= 3 }">{{ row.rank }}</i>
          <span class="ct__name-wrap">
            <b class="ct__name">{{ row.communityName }}</b>
            <em class="ct__grid">{{ row.gridName }}</em>
          </span>
          <span class="ct__count">{{ row.count }}</span>
          <span v-if="satAvailable(row)" class="ct__sat">{{ satText(row) }}</span>
          <!-- 满意率不可计算时只显示「—」，原因放 title（原 9 字长文案在 76px 列里被挤成两行） -->
          <span
            v-else
            class="st-uncomputable ct__sat-na"
            title="不可计算：该小区在当前窗口内无有效评价"
          >—</span>
        </div>
      </div>
    </div>
    <CardFooter v-if="!loading && !error && !empty" :items="footItems" drill-label="明细" @drill="drillAll" />
  </section>
</template>

<style scoped>
.ct__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ct__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  gap: 1px;
}
.ct__head-row {
  flex: none;
  display: grid;
  /* 与 .ct__row 一致的 4 列，否则表头与数据错位 */
  grid-template-columns: 16px minmax(0, 1fr) 34px 76px;
  gap: 5px;
  padding: 0 4px 2px;
  margin-bottom: 1px;
  font-size: 9px;
  color: #7fa9a0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.28);
}
.ct__head-row span:nth-child(3),
.ct__head-row span:nth-child(4) {
  text-align: right;
}
/* 行撑满列表高度（10 行时刚好铺满，不留大片空白），去掉每行小盒子边框，改用细分隔线 */
.ct__row {
  flex: 1 1 auto;
  min-height: 17px;
  max-height: 26px;
  display: grid;
  /*
   * 4 列：序号 / 名称 / 件数 / 满意率。
   *
   * 历史坑：曾加过第 5 列「明细」按钮，但该列只有 34px，中文字被挤成竖排、
   * 还溢出到卡片外压住地图（截图可见）。用户明确要求列表里不要明细按钮，已移除。
   * 明细入口统一保留在「地图点击浮层」与卡片底部「明细」按钮。
   */
  grid-template-columns: 16px minmax(0, 1fr) 34px 76px;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  font-family: inherit;
  text-align: left;
  color: #d6f6ef;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.14);
  cursor: pointer;
}
.ct__row:hover {
  background: linear-gradient(90deg, rgba(31, 143, 129, 0.2), transparent);
}
.ct__rank {
  font-style: normal;
  font-size: 9.5px;
  text-align: center;
  color: #d8f4ee;
  /* 原 0.28 alpha 在深底上几乎看不出，与前三名亮色块落差太大 */
  background: rgba(52, 139, 124, 0.55);
  border-radius: 2px;
  line-height: 14px;
}
.ct__rank.is-top3 {
  color: #041d1e;
  background: #86fbe7;
  font-weight: 700;
}
.ct__name-wrap {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  line-height: 1.2;
}
.ct__name {
  flex: none;
  font-size: 10.5px;
  color: #eafffa;
  white-space: nowrap;
}
.ct__grid {
  min-width: 0;
  font-style: normal;
  font-size: 8.5px;
  color: #7fa9a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ct__count {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 13px;
  color: #8fffe8;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ct__sat {
  font-size: 10px;
  text-align: right;
  color: #54d5bc;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ct__sat-na {
  justify-self: end;
  color: rgba(158, 198, 190, 0.55);
  font-size: 11px;
  padding: 0 2px;
}
.ct__skeleton {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}
.ct__skeleton i {
  display: block;
  height: 15px;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.2), rgba(134, 251, 231, 0.4), rgba(84, 213, 188, 0.2));
  background-size: 220% 100%;
  animation: ct-shimmer 1.2s linear infinite;
}
@keyframes ct-shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}
</style>
