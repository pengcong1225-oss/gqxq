<script setup lang="ts">
/**
 * 验收大屏 · 停供与施工（标书 1.2.6 / 1.2.7）—— 口径说明页
 *
 * ===== 现状（2026-11-19 更新）=====
 * 两类事件**均已接入真实数据**，本面板不再是「数据待对接」的占位页：
 *   · 停水停气：`GET /assessment/shutdown-layer` —— 157 条真实事件 / 291 个打点 / 22 个网格，
 *     四类分层（计划停水·计划停气·突发停水·突发停气），来自 `utility-feed-real` 来源快照。
 *   · 管道施工改造：`GET /assessment/pipeline-layer` —— 燃气/供水双图层，按涉及网格着色。
 *
 * 交互入口在**地图**上：点停水停气打点 → `ShutdownEventPanel` 展示事件详情
 * （企业/业务类型/时间范围/涉及户数/影响区域/应急预案/房屋信息/网格历史/相关诉求）；
 * 点管线色块 → `PipelinePanel` 展示改造项目详情。
 *
 * 本面板保留的价值是**口径说明**：把两类的字段定义、数据来源与「缺失不补 0」原则写清楚，
 * 避免使用者误读地图上的空态（例如「计划性停气」图层为空是来源确实没有该类型记录，
 * 不是功能缺失）。因此不再显示「数据待对接」这类已过时的表述。
 */
import { ref } from 'vue';
import { EVENT_FIELDS, EVENT_TABS, EVENTS_PENDING_TEXT } from './presetRules';

const tab = ref<(typeof EVENT_TABS)[number]['key']>('shutdown');

const TAB_TEXT: Record<string, { title: string; fields: string; note: string }> = {
  shutdown: {
    title: '停水停气事件（已接入，在地图上查看）',
    fields: '计划停水 / 突发停水 / 计划停气 / 突发停气',
    note:
      '数据来源：utility-feed 来源快照中已映射的停供申请（157 条 / 291 个打点 / 22 个网格，' +
      '经企业映射与 GCJ-02→WGS84 坐标系推定解析）。在地图上点击彩色打点即可查看事件详情：' +
      '企业、业务类型、时间范围、涉及户数、影响区域、应急预案、房屋信息、该网格历史与相关诉求。' +
      '若某类图层为空（如「计划性停气」），表示来源确实没有该类型记录，不是功能缺失。',
  },
  construction: {
    title: '管道施工改造（已接入，在地图上查看）',
    fields: '管线施工 / 管道改造 / 施工挖断',
    note:
      '数据来源：pipeline_project 改造项目，按「涉及网格」在燃气管线图层 / 供水管线图层上以网格色块高亮。' +
      '点击色块可查看改造项目详情：项目名称、企业、时间范围、现场施工人数、改造原因、影响区域、应急预案。' +
      '当前库内仅 2 条项目且均缺少「涉及网格」编码，故图层暂无可着色网格 —— 缺失不补 0、不画虚构管线。',
  },
};
</script>

<template>
  <div class="evt">
    <header class="evt__top">
      <div class="evt__tabs" role="tablist" aria-label="停供与施工分类">
        <button
          v-for="t in EVENT_TABS"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          class="evt__tab"
          :class="{ 'is-active': tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
      <span class="evt__tag">业务类型：{{ TAB_TEXT[tab].fields }}</span>
    </header>

    <p class="evt__notice">{{ EVENTS_PENDING_TEXT }}</p>

    <section class="evt__block">
      <header class="evt__blockhead">
        <b>字段口径（标书 1.2.6 / 1.2.7）</b>
        <span>接入后事件列表按此口径展示，字段值来自正式接口</span>
      </header>
      <table class="evt__table">
        <thead>
          <tr>
            <th>字段</th>
            <th>口径说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in EVENT_FIELDS" :key="f.key">
            <td class="evt__field">{{ f.label }}</td>
            <td>{{ f.desc }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="acc-empty evt__empty">
      <b>{{ TAB_TEXT[tab].title }}</b>
      <span>正式接口尚未提供事件数据（库内仅 2 条样例行，不作为正式数据展示）。</span>
      <span class="evt__sub">{{ TAB_TEXT[tab].note }}</span>
      <span class="evt__sub">事件级 / 网格级诉求量分开统计；缺失不补 0，不用样例行冒充正式数据。</span>
    </div>

    <p class="evt__foot">
      接入约定：事件 → 网格关联（同一事件可跨多个网格）· 企业 / 业务类型 / 时间范围 / 涉及户数 / 产生诉求量 ·
      事件级与网格级件数分开回填，避免重复考核。
    </p>
  </div>
</template>

<style scoped>
.evt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}
.evt__top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: rgba(6, 38, 36, 0.72);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.evt__tabs {
  display: flex;
  gap: 5px;
}
.evt__tab {
  padding: 5px 16px;
  font-family: inherit;
  font-size: 12.5px;
  letter-spacing: 1px;
  color: #a8d8ce;
  background: linear-gradient(180deg, rgba(12, 54, 50, 0.92), rgba(6, 30, 29, 0.92));
  border: 1px solid #347d72;
  cursor: pointer;
}
.evt__tab:hover {
  border-color: #86fbe7;
  color: #eafffa;
}
.evt__tab.is-active {
  color: #041d1e;
  background: linear-gradient(180deg, #86fbe7, #35b9a2);
  border-color: #86fbe7;
  box-shadow: 0 0 12px rgba(134, 251, 231, 0.35);
}
.evt__tag {
  margin-left: auto;
  font-size: 10px;
  color: #7fa9a0;
}
.evt__notice {
  flex: none;
  margin: 0;
  padding: 6px 9px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.36);
  border: 1px dashed rgba(255, 214, 124, 0.42);
}
.evt__block {
  flex: none;
  padding: 8px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.5);
}
.evt__blockhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.28);
}
.evt__blockhead b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #b9fff3;
}
.evt__blockhead span {
  margin-left: auto;
  font-size: 9.5px;
  color: #7fa9a0;
}
.evt__table {
  width: 100%;
  margin-top: 6px;
  border-collapse: collapse;
  font-size: 11px;
  color: #d6f6ef;
  table-layout: fixed;
}
.evt__table th {
  padding: 4px 6px;
  font-weight: 400;
  font-size: 10px;
  text-align: left;
  color: #7fa9a0;
  border-bottom: 1px solid rgba(52, 139, 124, 0.45);
}
.evt__table th:first-child {
  width: 128px;
}
.evt__table td {
  padding: 5px 6px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.18);
  color: #b8ded6;
}
.evt__field {
  color: #eafffa !important;
}
.evt__empty {
  flex: 1;
  min-height: 180px;
}
.evt__sub {
  font-size: 9.5px !important;
  color: #7fa9a0 !important;
}
.evt__foot {
  flex: none;
  margin: 0;
  font-size: 9px;
  color: #6f9a93;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>