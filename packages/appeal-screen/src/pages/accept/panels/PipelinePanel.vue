<script setup lang="ts">
/**
 * 管线改造事件详情（标书 1.2.7）
 *
 * 逐条对齐标书要求：
 *   「点击可查看改造事件的信息，包括改造项目名称、企业名称、时间范围、现场施工人数、相关诉求等信息」
 *      → 列表视图：项目名称 / 企业名称 / 时间范围 / 现场施工人数 / 施工状态
 *   「点击查看更多可获取管道改造详情，其中基础信息包括项目名称、企业名称、时间范围、现场施工人数、
 *     改造原因、影响区域、应急预案等信息」
 *      → 详情视图：上述全部字段，缺失如实写「未提供」，不补 0、不编造
 *   「此外对于影响区域可查看每个网格历史产生的管道改造事件信息」
 *      → 「影响区域」区块列出该网格历史上的全部改造项目（本项目之外的历史事件）
 *
 * ===== 口径 =====
 * 落图单位是「真实上报的影响网格」，不画虚构管线（投标技术方案第 755 行）。
 * 一个项目可涉及多个网格，空间关系以项目号关联，网格重叠不合并不同项目 —— 因此这里按项目逐条列出，
 * 不做「合并成一条」的归并。
 */
import { computed, nextTick, ref } from 'vue';
import PipelineComplaintClues from './PipelineComplaintClues.vue';
import {
  projectPeriodText,
  projectWorkerText,
  PIPELINE_COLORS,
  type PipelineBusinessType,
  type PipelineProject,
} from '@/components/Map/map2d/pipelineLayer';

const props = defineProps<{
  /** 被点击的网格编码 */
  gridCode: string;
  /** 网格名称 */
  gridName: string;
  /** 该网格涉及的全部改造项目（燃气+供水） */
  projects: PipelineProject[];
  /** 按业务类型分组，燃气在前（标书原文顺序） */
  byBusinessType: Record<PipelineBusinessType, PipelineProject[]>;
}>();

/** 当前展开详情的项目（null = 列表视图） */
const detailProject = ref<PipelineProject | null>(null);
const panel = ref<HTMLElement | null>(null);
const clueAnchor = ref<HTMLElement | null>(null);

const gasCount = computed(() => props.byBusinessType?.gas?.length ?? 0);
const waterCount = computed(() => props.byBusinessType?.water?.length ?? 0);

/** 项目所属业务类型的中文名 + 配色 */
function bizLabel(p: PipelineProject): string {
  const t = String(p.businessType ?? '');
  if (t === 'gas') return PIPELINE_COLORS.gas.label;
  if (t === 'water') return PIPELINE_COLORS.water.label;
  return t || '业务类型未提供';
}
function bizClass(p: PipelineProject): string {
  return String(p.businessType ?? '') === 'gas' ? 'is-gas' : 'is-water';
}

/** 状态标签配色：施工中=亮、未批准/已取消=灰虚线 */
function statusClass(p: PipelineProject): string {
  if (p.status === 'in_progress') return 'is-active';
  if (p.status === 'rejected' || p.status === 'cancelled') return 'is-invalid';
  if (p.status === 'completed') return 'is-done';
  return 'is-plain';
}

/** 字段展示：空值一律「未提供」（标书要求字段齐全，数据缺失就如实说） */
function shown(v: string | number | null | undefined, suffix = ''): string {
  if (v === null || v === undefined || String(v).trim() === '') return '未提供';
  return suffix ? `${v}${suffix}` : String(v);
}

/** 历史事件 = 本项目之外，同一网格里的其它改造项目 */
function historyOf(current: PipelineProject): PipelineProject[] {
  return props.projects.filter((p) => p.projectId !== current.projectId);
}

async function openDetail(p: PipelineProject, scrollToClues = false) {
  detailProject.value = p;
  await nextTick();
  if (scrollToClues) clueAnchor.value?.scrollIntoView({ block: 'start' });
  else panel.value?.scrollTo({ top: 0 });
}
function backToList() {
  detailProject.value = null;
}
</script>

<template>
  <div ref="panel" class="pl">
    <!-- 列表视图：网格 → 改造项目清单 -->
    <template v-if="!detailProject">
      <header class="pl__head">
        <div class="pl__head-main">
          <b>{{ gridName || gridCode }}</b>
          <span class="pl__code">{{ gridCode }}</span>
        </div>
        <div class="pl__head-meta">
          <span>改造项目 <b>{{ projects.length }}</b> 个</span>
          <span v-if="gasCount" class="pl__tag is-gas">燃气 {{ gasCount }}</span>
          <span v-if="waterCount" class="pl__tag is-water">供水 {{ waterCount }}</span>
        </div>
      </header>

      <p class="pl__note">
        标书 1.2.7 口径：按改造项目<b>真实上报的影响网格</b>形成色块，不绘制虚构管线；
        一个项目可涉及多个网格，空间关系以项目号关联，<b>网格重叠不合并不同项目</b>。
      </p>

      <div v-if="!projects.length" class="pl__empty">
        <b>该网格暂无改造项目</b>
        <span>未从来源系统获得该网格的管道施工改造上报记录。</span>
      </div>

      <ul v-else class="pl__list">
        <li v-for="p in projects" :key="p.projectId" class="pl__item">
          <div class="pl__item-head">
            <span class="pl__tag" :class="bizClass(p)">{{ bizLabel(p) }}</span>
            <b class="pl__name">{{ p.projectName || '（项目名称未提供）' }}</b>
            <span class="pl__status" :class="statusClass(p)">{{ p.statusLabel }}</span>
          </div>
          <dl class="pl__brief">
            <div><dt>企业名称</dt><dd>{{ shown(p.enterpriseName) }}</dd></div>
            <div><dt>时间范围</dt><dd>{{ projectPeriodText(p) }}</dd></div>
            <div><dt>现场施工人数</dt><dd>{{ projectWorkerText(p) }}</dd></div>
            <div><dt>项目编号</dt><dd>{{ shown(p.projectNo || p.projectId) }}</dd></div>
          </dl>
          <div class="pl__actions">
            <button type="button" class="pl__more" @click="openDetail(p)">查看更多 ›</button>
            <button type="button" class="pl__more" @click="openDetail(p, true)">查看相关诉求</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- 详情视图：管道改造详情（标书要求的全部基础信息） -->
    <template v-else>
      <header class="pl__head">
        <div class="pl__head-main">
          <b>{{ detailProject.projectName || '（项目名称未提供）' }}</b>
          <span class="pl__tag" :class="bizClass(detailProject)">{{ bizLabel(detailProject) }}</span>
          <span class="pl__status" :class="statusClass(detailProject)">{{ detailProject.statusLabel }}</span>
        </div>
        <div class="pl__head-meta">
          <span>{{ gridName || gridCode }}</span>
          <span class="pl__code">{{ detailProject.projectNo || detailProject.projectId }}</span>
        </div>
      </header>

      <button type="button" class="pl__back" @click="backToList">‹ 返回项目列表</button>

      <section class="pl__block">
        <h4>基础信息</h4>
        <dl class="pl__fields">
          <div><dt>项目名称</dt><dd>{{ shown(detailProject.projectName) }}</dd></div>
          <div><dt>企业名称</dt><dd>{{ shown(detailProject.enterpriseName) }}</dd></div>
          <div><dt>时间范围</dt><dd>{{ projectPeriodText(detailProject) }}</dd></div>
          <div><dt>现场施工人数</dt><dd>{{ projectWorkerText(detailProject) }}</dd></div>
          <div><dt>改造原因</dt><dd>{{ shown(detailProject.constructionReason) }}</dd></div>
          <div><dt>影响区域</dt><dd>{{ shown(detailProject.affectedArea) }}</dd></div>
          <div><dt>应急预案</dt><dd>{{ shown(detailProject.emergencyPlan) }}</dd></div>
          <div><dt>管线长度</dt><dd>{{ shown(detailProject.pipelineLength, ' 米') }}</dd></div>
          <div><dt>施工进度</dt><dd>{{ shown(detailProject.progress, '%') }}</dd></div>
          <div><dt>涉及网格</dt><dd>{{ detailProject.gridCodes.join('、') || '未提供' }}</dd></div>
        </dl>
        <p v-if="detailProject.source || detailProject.sourceApplyNo || detailProject.sourceEventNo" class="pl__source">
          <span v-if="detailProject.source === 'utility-application'">公共事业施工申请</span>
          <span v-else-if="detailProject.source === 'legacy-project'">历史改造台账</span>
          <span v-if="detailProject.sourceApplyNo">申请单 {{ detailProject.sourceApplyNo }}</span>
          <span v-if="detailProject.sourceEventNo">事件 {{ detailProject.sourceEventNo }}</span>
        </p>
      </section>

      <div ref="clueAnchor">
        <PipelineComplaintClues
          :key="detailProject.projectId"
          class="pl__block"
          :project-id="detailProject.projectId"
          :grid-code="gridCode"
          :source-revision="detailProject.sourceRevision"
        />
      </div>

      <!-- 影响区域 → 该网格历史改造事件（标书 1.2.7 明确要求） -->
      <section class="pl__block">
        <h4>影响区域 · 该网格历史改造事件</h4>
        <p class="pl__hint">
          网格 <b>{{ gridCode }}</b> 除本项目外，历史上还产生以下改造事件：
        </p>
        <ul v-if="historyOf(detailProject).length" class="pl__history">
          <li v-for="h in historyOf(detailProject)" :key="h.projectId">
            <span class="pl__tag" :class="bizClass(h)">{{ bizLabel(h) }}</span>
            <button type="button" class="pl__history-link" @click="openDetail(h)">{{ h.projectName }}</button>
            <span class="pl__status" :class="statusClass(h)">{{ h.statusLabel }}</span>
            <span class="pl__hist-time">{{ projectPeriodText(h) }}</span>
          </li>
        </ul>
        <p v-else class="pl__empty-inline">该网格暂无其它历史改造事件。</p>
      </section>

    </template>
  </div>
</template>

<style scoped>
.pl {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  font-size: 12px;
  color: #d6f6ef;
}
.pl__head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(6, 38, 36, 0.72);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.pl__head-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.pl__head-main b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 17px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #b9fff3;
}
.pl__code {
  font-size: 10.5px;
  color: #7fa9a0;
}
.pl__head-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #a8d8ce;
}
.pl__head-meta b {
  color: #ffd67c;
}
.pl__note {
  flex: none;
  margin: 0;
  padding: 6px 9px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.36);
  border: 1px dashed rgba(255, 214, 124, 0.42);
}
.pl__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10.5px;
}
.pl__tag.is-gas {
  color: #ffc58a;
  background: rgba(230, 126, 34, 0.26);
}
.pl__tag.is-water {
  color: #9ed3f7;
  background: rgba(52, 152, 219, 0.26);
}
.pl__status {
  flex: none;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10.5px;
}
.pl__status.is-active {
  color: #06251f;
  background: #4be7a0;
}
.pl__status.is-done {
  color: #06251f;
  background: #86fbe7;
}
.pl__status.is-invalid {
  color: #ffd7d2;
  border: 1px dashed rgba(255, 138, 128, 0.8);
}
.pl__status.is-plain {
  color: #a8d8ce;
  background: rgba(52, 139, 124, 0.35);
}
.pl__list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pl__item {
  padding: 8px 10px;
  background: rgba(4, 28, 27, 0.6);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.pl__item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pl__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #eafffa;
}
.pl__item-head .pl__status {
  margin-left: auto;
}
.pl__brief {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px 14px;
  margin: 6px 0 0;
}
.pl__brief div,
.pl__fields div {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.pl__brief dt,
.pl__fields dt {
  flex: none;
  width: 84px;
  color: #7fa9a0;
  font-size: 10.5px;
}
.pl__brief dd,
.pl__fields dd {
  margin: 0;
  min-width: 0;
  color: #d6f6ef;
  overflow-wrap: anywhere;
}
.pl__more {
  margin-top: 6px;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 11px;
  color: #86fbe7;
  background: rgba(13, 58, 53, 0.9);
  border: 1px solid rgba(134, 251, 231, 0.5);
  cursor: pointer;
}
.pl__more:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
.pl__actions {
  display: flex;
  gap: 8px;
}
.pl__back {
  flex: none;
  align-self: flex-start;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 11px;
  color: #a8d8ce;
  background: transparent;
  border: 1px solid rgba(52, 139, 124, 0.6);
  cursor: pointer;
}
.pl__back:hover {
  border-color: #86fbe7;
  color: #86fbe7;
}
.pl__block {
  flex: none;
  padding: 8px 10px;
  background: rgba(4, 28, 27, 0.5);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.pl__block :deep(h4),
.pl__block h4 {
  margin: 0 0 6px;
  padding-bottom: 5px;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 14px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #b9fff3;
  border-bottom: 1px solid rgba(52, 139, 124, 0.28);
}
.pl__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 14px;
  margin: 0;
}
.pl__source {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 6px 0 0;
  font-size: 10px;
  color: #6f9a93;
}
.pl__hint {
  margin: 0 0 5px;
  font-size: 10.5px;
  color: #7fa9a0;
}
.pl__history {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pl__history li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  font-size: 11.5px;
  background: rgba(6, 38, 36, 0.6);
  border-left: 2px solid rgba(52, 139, 124, 0.7);
}
.pl__history-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #86fbe7;
  font: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.pl__history-link:hover {
  text-decoration: underline;
}
.pl__hist-time {
  margin-left: auto;
  flex: none;
  font-size: 10.5px;
  color: #7fa9a0;
}
.pl__empty,
.pl__empty-inline {
  margin: 0;
  padding: 14px;
  text-align: center;
  font-size: 11.5px;
  color: #7fa9a0;
  border: 1px dashed rgba(52, 139, 124, 0.45);
}
.pl__empty b {
  display: block;
  margin-bottom: 4px;
  color: #ffd67c;
  font-size: 12.5px;
}
</style>
