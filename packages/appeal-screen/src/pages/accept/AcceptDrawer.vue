<script setup lang="ts">
/**
 * 验收大屏 · 右侧抽屉（底部按钮按标书打开四个专题面板）
 *
 *  网格对比   → 标书 1.2.8：选 2~3 个行政网格 → 按诉求大类对比件数，最高值高亮
 *  数据预警   → 标书 1.2.10：四场景规则 + 今日评估 + 已保存预警
 *  冬夏研判   → 标书 1.2.11：冬季保供(g08)/夏季保畅(w04) 三块
 *  停供与施工 → 标书 1.2.6/1.2.7：字段口径 + 空态（正式接口未接入）
 *  更多分析   → 复用 CompactDynamic + CompactFourDim（主屏精简收纳）
 */
import { computed } from 'vue';
import CompactDynamic from '@/components/compact/CompactDynamic.vue';
import CompactFourDim from '@/components/compact/CompactFourDim.vue';
import GridComparePanel from './panels/GridComparePanel.vue';
import BusinessAlertsPanel from './panels/BusinessAlertsPanel.vue';
import SeasonResearchPanel from './panels/SeasonResearchPanel.vue';
import EventsPanel from './panels/EventsPanel.vue';
import type { AcceptDrawerKey } from './types';
import type {
  DemandDynamicData,
  DrillQuery,
  ForcedState,
  IndustryFilter,
  PanelState,
  PeriodMeta,
  ResearchTopData,
  SupplyData,
  WarningListData,
} from '@/stats/types';

const props = defineProps<{
  drawerKey: AcceptDrawerKey | null;
  supply: PanelState<SupplyData>;
  dynamic: PanelState<DemandDynamicData>;
  warnings: PanelState<WarningListData>;
  research: PanelState<ResearchTopData>;
  periodMeta: PeriodMeta;
  industry: IndustryFilter;
  forcedState: ForcedState;
  /** 大屏当前统计窗口（网格对比用） */
  fromDate: string;
  toDate: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
  /** 抽屉内点击 Top6 网格：关闭抽屉 + 收窄统计 + 地图定位 + 同条件明细 */
  (e: 'locate', payload: { gridCode: string; query: DrillQuery }): void;
}>();

const TITLES: Record<AcceptDrawerKey, { title: string; caption: string }> = {
  compare: { title: '网格对比', caption: '标书 1.2.8：选择 2~3 个行政网格 · 按诉求大类对比件数 · 最高值高亮（并列全部高亮）' },
  warnings: { title: '数据预警', caption: '标书 1.2.10：冬季保供 / 夏季保畅 / 计划性停水停气 / 燃气三件套（待业务确认）' },
  research: { title: '冬夏研判', caption: '标书 1.2.11：近 5 个保障季年度量 / 上年度月度 / 本期 Top6 网格（g08 燃气气压 · w04 水压）' },
  events: { title: '停供与施工', caption: '标书 1.2.6 / 1.2.7：停水停气 / 管道施工改造事件（正式接口未接入，字段口径 + 空态）' },
  analysis: { title: '更多分析', caption: '诉求动态（满意/时长/周变化/高峰）+ 供气供水四维摘要' },
};

const meta = computed(() => (props.drawerKey ? TITLES[props.drawerKey] : null));
const widePanel = computed(() => props.drawerKey !== null && props.drawerKey !== 'analysis');
</script>

<template>
  <div v-if="drawerKey" class="acc-drawer" role="dialog" aria-modal="true" :aria-label="meta?.title">
    <div class="acc-drawer__mask" @click="emit('close')"></div>
    <aside class="acc-drawer__panel" :class="{ 'acc-drawer__panel--wide': widePanel }">
      <header class="acc-drawer__head">
        <div class="acc-drawer__title">
          <h2>{{ meta?.title }}</h2>
          <span>{{ meta?.caption }}</span>
        </div>
        <button type="button" class="acc-drawer__close" aria-label="关闭抽屉" @click="emit('close')">关闭 ×</button>
      </header>

      <div class="acc-drawer__body">
        <!-- 网格对比（标书 1.2.8） -->
        <div v-if="drawerKey === 'compare'" class="dr-compare">
          <GridComparePanel :from-date="fromDate" :to-date="toDate" />
        </div>

        <!-- 数据预警（标书 1.2.10） -->
        <div v-else-if="drawerKey === 'warnings'" class="dr-feature">
          <BusinessAlertsPanel />
        </div>

        <!-- 冬夏研判（标书 1.2.11） -->
        <div v-else-if="drawerKey === 'research'" class="dr-research">
          <SeasonResearchPanel />
        </div>

        <!-- 停供与施工（标书 1.2.6 / 1.2.7） -->
        <div v-else-if="drawerKey === 'events'" class="dr-feature">
          <EventsPanel />
        </div>

        <!-- 更多分析：动态 + 四维摘要 -->
        <div v-else class="dr-analysis">
          <p class="dr-note">
            主屏已精简：诉求动态（满意度 / 办理时长 / 周变化 / 高峰）与四维摘要收进这里，按需查看。
          </p>
          <div class="dr-analysis__block">
            <CompactDynamic
              :dynamic="dynamic"
              :industry="industry"
              :period-meta="periodMeta"
              @retry="emit('retry')"
              @drill="(q) => emit('drill', q)"
            />
          </div>
          <div class="dr-analysis__block">
            <CompactFourDim
              :supply="supply"
              :industry="industry"
              :period-meta="periodMeta"
              @retry="emit('retry')"
              @drill="(q) => emit('drill', q)"
            />
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.acc-drawer {
  position: absolute;
  inset: 0;
  z-index: 700;
  display: flex;
  justify-content: flex-end;
}
.acc-drawer__mask {
  position: absolute;
  inset: 0;
  background: rgba(1, 12, 11, 0.62);
  backdrop-filter: blur(1px);
}
.acc-drawer__panel {
  position: relative;
  width: 880px;
  max-width: 62vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(100deg, rgba(5, 35, 33, 0.98), rgba(3, 24, 25, 0.96));
  border-left: 1px solid #59a998;
  box-shadow: -18px 0 46px rgba(0, 0, 0, 0.6), inset 0 0 40px rgba(11, 73, 64, 0.26);
  animation: acc-drawer-in 0.2s ease;
}
/* 专题抽屉（网格对比 / 冬夏研判）需要并排表格+图表与三块研判，用更宽的版式，风格不变 */
.acc-drawer__panel--wide {
  width: 1240px;
  max-width: 86vw;
}
@keyframes acc-drawer-in {
  from {
    transform: translateX(46px);
    opacity: 0;
  }
}
.acc-drawer__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 62px;
  padding: 0 18px;
  background: url('/assets/screen/img/title_bg.png') left center / 100% 100% no-repeat;
  border-bottom: 1px solid rgba(52, 139, 124, 0.5);
}
.acc-drawer__title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 56px;
}
.acc-drawer__title h2 {
  margin: 0;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 22px;
  font-weight: 400;
  letter-spacing: 2px;
  color: #e5fff8;
}
.acc-drawer__title span {
  font-size: 10.5px;
  color: #97cbc0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.acc-drawer__close {
  margin-left: auto;
  flex: none;
  padding: 5px 12px;
  font-family: inherit;
  font-size: 12px;
  color: #d5f8ef;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.acc-drawer__close:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
.acc-drawer__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 16px;
}
.dr-note {
  margin: 0 0 8px;
  padding: 7px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.45);
  border: 1px dashed rgba(255, 214, 124, 0.42);
}
.dr-compare {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.dr-feature {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.dr-research {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dr-analysis {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dr-analysis__block {
  display: flex;
  min-height: 360px;
}
.dr-analysis__block > :deep(.st-panel) {
  flex: 1;
  min-height: 360px;
}
</style>
