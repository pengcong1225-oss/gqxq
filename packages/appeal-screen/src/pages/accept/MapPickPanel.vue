<script setup lang="ts">
/**
 * 地图点击浮层：显示被点中对象（小区 / 网格）的**概况 + 明细**。
 *
 * ===== 为什么要有这个组件 =====
 * 用户反馈：「点击地图出东西啊，从这里看概况和明细，列表不要动」。
 *
 * 之前的行为是「点地图 = 改筛选」，左右两侧列表面板全部重算 —— 点一个只有 0~1 条工单的
 * 小区，整屏从 10,626 掉到 0，观感等同"数据不加载了"。现在改为：
 *   · 点地图 → 弹出本浮层，显示该点位/网格的概况与诉求明细
 *   · 左右两侧列表**完全不动**，筛选条也不变
 *   · 想按该范围收窄统计时，浮层里提供「按此筛选」按钮（显式动作）
 *
 * 复用主屏统计上下文，通过 `/screen/demands` 按小区或网格读取第一页。
 */
import { computed, ref, watch } from 'vue';
import { fetchDemands } from '@/stats/api';
import type { DemandItem, DrillQuery } from '@/stats/types';

/** 被点中的对象类型 */
export type MapPickKind = 'community' | 'grid';

export interface MapPickDetail {
  kind: MapPickKind;
  /** 小区编码（kind=community 时必填） */
  communityCode?: string | null;
  /** 网格编码（kind=grid 时用 adminGridCode 查询；community 时可用 gridCode 展示所属网格） */
  adminGridCode?: string | null;
  formalHeatGrid?: boolean;
  /** 小区所属网格（仅展示用） */
  gridCode?: string | null;
  /** 展示名 */
  name: string;
  /** 同一像素上重叠的其它小区名（点密集时会重叠） */
  overlaps?: string[];
}

/** 定位点在地图容器内的像素坐标（由地图组件回报） */
export interface MapAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  lonLat: [number, number];
}

const props = defineProps<{
  detail: MapPickDetail | null;
  query: DrillQuery | null;
  /** 定位锚点：有值时浮层贴在点位旁边，无值时退回地图中央 */
  anchor?: MapAnchor | null;
  /** 地图容器相对页面左上角的偏移（用于把容器内坐标换算成浮层绝对坐标） */
  mapOffset?: { x: number; y: number };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  /** 用户显式要求「按此范围筛选」时才改变主屏统计 */
  (e: 'apply-filter', payload: { communityCode?: string; adminGridCode?: string }): void;
  /** 打开完整明细抽屉 */
  (e: 'open-drawer'): void;
}>();

const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<DemandItem[]>([]);
const total = ref<number | null>(null);

/** 每页条数：浮层空间有限，先给 10 条，更多走「查看全部」 */
const PAGE = 10;

/**
 * 概况：把明细按诉求类型聚合。
 * 没有数据时显示「当前窗口无工单」，而不是 0 件冒充有数据。
 */
const summary = computed(() => {
  const byType = new Map<string, number>();
  for (const it of items.value) {
    const k = it.typeName || '未分类';
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }
  return [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
});

const industryLabel = computed(() =>
  props.query?.industry === 'GAS' ? '供气' : props.query?.industry === 'WATER' ? '供水' : '供水+供气'
);
const from = computed(() => props.query?.filters?.window?.from);
const to = computed(() => props.query?.filters?.window?.to);

watch(
  () => props.query,
  async (query, _, onCleanup) => {
    items.value = [];
    total.value = null;
    error.value = null;
    loading.value = false;
    if (!query) return;
    if (!query.communityCode && !query.gridCode) {
      error.value = '缺少小区或网格编码，无法查询诉求明细';
      return;
    }

    let current = true;
    onCleanup(() => { current = false; });
    loading.value = true;
    try {
      const { data } = await fetchDemands({ ...query, page: 1, pageSize: PAGE });
      if (!current) return;
      items.value = data.items;
      total.value = data.total;
    } catch (e) {
      if (current) error.value = e instanceof Error ? e.message : '明细加载失败';
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true }
);

/** 浮层尺寸（与 CSS 中的 width 保持一致） */
const PANEL_W = 380;
const PANEL_MAX_H = 420;
/** 点位与浮层之间的间距 */
const GAP = 10;

/**
 * 浮层位置：**贴在定位点旁边**，而不是固定挂在右下角。
 *
 * 规则：
 *   · 默认开在点位右侧、垂直居中；
 *   · 右侧放不下（会盖住右栏或出界）→ 翻到点位左侧；
 *   · 垂直方向夹在安全区内（顶部让开标题栏与筛选条，底部让开按钮条）。
 *
 * 这样点位在哪，详情就在哪，符合"挂到地图上"的直觉。
 */
const panelStyle = computed(() => {
  const a = props.anchor;
  const off = props.mapOffset ?? { x: 0, y: 0 };
  if (!a) {
    // 没有锚点（例如网格点击未回报坐标）：落在地图中央偏右的安全位
    return {
      left: `${off.x + (a?.width ?? 900) * 0.42}px`,
      top: `${off.y + 200}px`,
    };
  }
  const px = off.x + a.x;
  const py = off.y + a.y;
  // 安全边界（页面坐标系）
  const safeTop = 120;
  const safeBottom = window.innerHeight - 96;
  let left = px + GAP;
  if (left + PANEL_W > window.innerWidth - 24) {
    left = px - GAP - PANEL_W; // 右侧放不下，翻到左边
  }
  if (left < 24) left = 24;
  let top = py - 24; // 轻微上移：浮层左上角贴近点位右上侧
  const maxTop = safeBottom - Math.min(PANEL_MAX_H, 360);
  if (top > maxTop) top = maxTop;
  if (top < safeTop) top = safeTop;
  return { left: `${left}px`, top: `${top}px` };
});

function applyFilter() {
  const d = props.detail;
  if (!d) return;
  emit('apply-filter', {
    ...(d.communityCode ? { communityCode: d.communityCode } : {}),
    ...(d.adminGridCode ? { adminGridCode: d.adminGridCode } : {}),
  });
}

</script>

<template>
  <div v-if="detail" class="mpop" role="dialog" aria-label="地图选中对象详情" :style="panelStyle">
    <header class="mpop__head">
      <span class="mpop__kind">{{ detail.kind === 'community' ? '小区' : '网格' }}</span>
      <b class="mpop__name" :title="detail.name">{{ detail.name }}</b>
      <button type="button" class="mpop__x" title="关闭" @click="emit('close')">×</button>
    </header>

    <div class="mpop__meta">
      <span v-if="detail.gridCode">网格 {{ detail.gridCode }}</span>
      <span v-if="detail.communityCode">编码 {{ detail.communityCode }}</span>
      <span>{{ from }} ~ {{ to }}</span>
      <span>{{ industryLabel }}</span>
    </div>

    <p v-if="detail.overlaps && detail.overlaps.length" class="mpop__overlap">
      该位置还有 {{ detail.overlaps.length }} 个小区重叠：{{ detail.overlaps.slice(0, 3).join('、') }}{{ detail.overlaps.length > 3 ? ' 等' : '' }}
    </p>

    <!-- 概况 -->
    <section class="mpop__sec">
      <h4>概况</h4>
      <div v-if="loading" class="mpop__hint">加载中…</div>
      <div v-else-if="error" class="mpop__err">{{ error }}</div>
      <div v-else-if="total === 0" class="mpop__hint">
        当前窗口（{{ from }} ~ {{ to }}）该{{ detail.kind === 'community' ? '小区' : '网格' }}无诉求工单 ——
        不是加载失败，本窗口确实没有记录，可换时间窗口再看。
      </div>
      <template v-else>
        <div class="mpop__stat">
          <span class="mpop__num">{{ total ?? items.length }}</span>
          <span class="mpop__unit">件诉求</span>
        </div>
        <ul v-if="summary.length" class="mpop__types">
          <li v-for="[t, n] in summary" :key="t">
            <span class="mpop__tname" :title="t">{{ t }}</span>
            <span class="mpop__tbar"><i :style="{ width: `${(n / (items.length || 1)) * 100}%` }"></i></span>
            <span class="mpop__tnum">{{ n }}</span>
          </li>
        </ul>
      </template>
    </section>

    <!-- 明细 -->
    <section v-if="!loading && !error && items.length" class="mpop__sec mpop__sec--list">
      <h4>明细<small>（前 {{ items.length }} 条，共 {{ total }} 条）</small></h4>
      <div class="mpop__list">
        <div class="mpop__lrow mpop__lrow--head">
          <span>案件号</span><span>类型</span><span>录入</span>
        </div>
        <div v-for="it in items" :key="it.caseNo" class="mpop__lrow">
          <span class="mpop__lid" :title="it.caseNo">{{ it.caseNo }}</span>
          <span class="mpop__ltype" :title="it.typeName">{{ it.typeName }}</span>
          <span class="mpop__ltime">{{ it.intakeTime || '—' }}</span>
        </div>
      </div>
    </section>

    <footer class="mpop__foot">
      <button type="button" class="mpop__btn" :disabled="loading || !total" @click="emit('open-drawer')">
        查看全部明细
      </button>
      <button
        type="button"
        class="mpop__btn mpop__btn--ghost"
        title="按此范围收窄主屏统计（会改变左右列表数字）"
        @click="applyFilter"
      >
        按此筛选
      </button>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 浮层定位：贴地图右下、左右两侧列表面板之外的安全区。
 * 不遮挡左栏三卡、右栏三卡与底部按钮条；宽度限制在 380px，高度可滚动。
 */
.mpop {
  /*
   * 定位由 :style="panelStyle" 提供（贴在定位点旁边，随地图移动）。
   * 这里只声明 fixed + 尺寸，不再写死 right/bottom —— 固定挂右下角不符合
   * 「窗体挂到地图上」的直觉（用户反馈）。
   */
  position: fixed;
  width: 380px;
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 4px;
  background: rgba(4, 34, 32, 0.95);
  border: 1px solid rgba(134, 251, 231, 0.45);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
  color: #d6f6ef;
  font-size: 11.5px;
  z-index: 60;
  overflow: hidden;
}
.mpop__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mpop__kind {
  flex: none;
  padding: 0 5px;
  border-radius: 2px;
  background: rgba(134, 251, 231, 0.16);
  border: 1px solid rgba(134, 251, 231, 0.4);
  color: #86fbe7;
  font-size: 10px;
  line-height: 16px;
}
.mpop__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #eafffa;
  font-size: 13px;
}
.mpop__x {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: #9fe3d3;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.mpop__x:hover {
  background: rgba(134, 251, 231, 0.18);
  color: #fff;
}
.mpop__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: #8ab9b0;
  font-size: 10.5px;
}
.mpop__overlap {
  margin: 0;
  padding: 3px 6px;
  border-radius: 2px;
  background: rgba(255, 214, 124, 0.1);
  border-left: 2px solid #ffd67c;
  color: #ffe0a3;
  font-size: 10.5px;
  line-height: 1.5;
}
.mpop__sec {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
}
.mpop__sec--list {
  flex: 1 1 auto;
  overflow: hidden;
}
.mpop__sec h4 {
  margin: 0;
  color: #86fbe7;
  font-size: 11.5px;
  font-weight: 600;
}
.mpop__sec h4 small {
  margin-left: 4px;
  color: #7ea8a0;
  font-weight: 400;
  font-size: 10px;
}
.mpop__hint {
  color: #8ab9b0;
  font-size: 10.5px;
  line-height: 1.6;
}
.mpop__err {
  color: #ff9d9d;
  font-size: 10.5px;
}
.mpop__stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.mpop__num {
  color: #ffd67c;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}
.mpop__unit {
  color: #8ab9b0;
  font-size: 11px;
}
.mpop__types {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mpop__types li {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) 30px;
  align-items: center;
  gap: 5px;
}
.mpop__tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b8ded6;
  font-size: 10.5px;
}
.mpop__tbar {
  height: 6px;
  border-radius: 3px;
  background: rgba(83, 191, 173, 0.16);
  overflow: hidden;
}
.mpop__tbar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #1b7466, #86fbe7);
}
.mpop__tnum {
  text-align: right;
  color: #d6f6ef;
  font-size: 10.5px;
}
.mpop__list {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.mpop__lrow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 62px;
  gap: 5px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(83, 191, 173, 0.12);
  font-size: 10.5px;
}
.mpop__lrow--head {
  color: #7ea8a0;
  border-bottom-color: rgba(83, 191, 173, 0.3);
}
.mpop__lid,
.mpop__ltype {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mpop__ltype {
  color: #9fe3d3;
}
.mpop__ltime {
  color: #8ab9b0;
  text-align: right;
}
.mpop__foot {
  display: flex;
  gap: 6px;
  flex: none;
}
.mpop__btn {
  flex: 1 1 0;
  padding: 4px 8px;
  border-radius: 2px;
  border: 1px solid #347d72;
  background: linear-gradient(180deg, #1b7466, #0c4640);
  color: #eafffa;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.mpop__btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.mpop__btn--ghost {
  background: transparent;
  border-color: rgba(255, 214, 124, 0.5);
  color: #ffd67c;
}
.mpop__btn:hover:not(:disabled) {
  border-color: #86fbe7;
}
</style>
