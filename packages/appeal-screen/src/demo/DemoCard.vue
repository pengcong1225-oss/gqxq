<script setup>
/**
 * 卡片内容演示组件。
 * 模块外观完全沿用原项目的 echartsCard.scss（.com / .title / .olympic-rings）
 * 与原卡片切图，内部只换成 src/demo 的本地假数据，不含任何接口与业务方法。
 */
defineProps({
  config: { type: Object, required: true },
})
</script>

<template>
  <!-- 结构与原 K1~K18 卡片组件完全一致 -->
  <div class="com">
    <div class="title">
      <div class="title-icon">
        <img src="@/assets/image/img01.png" alt="" class="w-100">
      </div>
      <div class="title-txe">{{ config.title }}</div>
      <div class="title-more">
        <span class="tabs-div active">示例</span>
      </div>
    </div>

    <div class="olympic-rings">
      <div class="demo-body">
        <!-- 指标块 -->
        <div v-if="config.type === 'metrics'" class="demo-metrics">
          <div v-for="item in config.metrics" :key="item.label" class="demo-metric">
            <div class="demo-metric-label">{{ item.label }}</div>
            <div class="demo-metric-value">{{ item.value }}<small>{{ item.unit }}</small></div>
          </div>
        </div>

        <!-- 横向条形 -->
        <div v-else-if="config.type === 'bars'" class="demo-bars">
          <div v-for="item in config.bars" :key="item.label" class="demo-bar-row">
            <span class="demo-bar-label">{{ item.label }}</span>
            <span class="demo-bar-track">
              <i class="demo-bar-fill" :style="{ width: item.value + '%' }"></i>
            </span>
            <span class="demo-bar-value">{{ item.value }}%</span>
          </div>
        </div>

        <!-- 趋势列表 -->
        <div v-else-if="config.type === 'list'" class="demo-rows">
          <div v-for="row in config.rows" :key="row.label" class="demo-row">
            <span class="demo-row-label">{{ row.label }}</span>
            <span class="demo-row-value">{{ row.value }}</span>
            <span class="demo-row-trend" :class="{ 'is-down': row.trend.startsWith('-') }">{{ row.trend }}</span>
          </div>
        </div>

        <!-- 排行榜 -->
        <div v-else-if="config.type === 'rank'" class="demo-rows">
          <div v-for="(row, i) in config.rows" :key="row.label" class="demo-row">
            <i class="demo-rank-no" :class="{ 'is-top': i < 3 }">{{ i + 1 }}</i>
            <span class="demo-row-label">{{ row.label }}</span>
            <span class="demo-row-value">{{ row.value }}</span>
          </div>
        </div>

        <!-- 柱状走势 -->
        <div v-else-if="config.type === 'columns'" class="demo-columns">
          <div class="demo-columns-chart">
            <i v-for="(v, i) in config.columns" :key="i" class="demo-column" :style="{ height: v + '%' }"></i>
          </div>
          <div class="demo-columns-axis">
            <span v-for="label in config.axis" :key="label">{{ label }}</span>
          </div>
        </div>

        <!-- 明细表格 -->
        <div v-else-if="config.type === 'table'" class="demo-table">
          <div class="demo-table-head">
            <span v-for="col in config.columns" :key="col">{{ col }}</span>
          </div>
          <div v-for="row in config.rows" :key="row.name" class="demo-table-row">
            <span>{{ row.name }}</span>
            <span>{{ row.value }}</span>
            <span :class="row.status === '关注' ? 'is-warn' : 'is-ok'">{{ row.status }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/assets/css/echartsCard.scss' as *;

/* 假数据内容区：只负责排版，模块外框全部来自原样式 */
.demo-body {
  width: 100%;
  flex: 1;
  min-height: 0;
  padding: 2px 12px 8px;
  box-sizing: border-box;
  color: #edffff;
  font-size: 13px;
  overflow: hidden;
}

.demo-metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  height: 100%;
}
.demo-metric {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  background: linear-gradient(120deg, rgba(18, 73, 77, 0.5), rgba(6, 24, 30, 0.25));
  border: 1px solid rgba(102, 255, 255, 0.14);
  border-radius: 4px;
}
.demo-metric-label { font-size: 12px; color: #91b9bb; }
.demo-metric-value {
  font-size: 22px;
  font-weight: 600;
  color: #66ffff;
  line-height: 1;
  font-variant-numeric: tabular-nums;

  small { margin-left: 4px; font-size: 12px; font-weight: 400; color: #91b9bb; }
}

.demo-bars {
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  height: 100%;
}
.demo-bar-row { display: flex; align-items: center; gap: 10px; }
.demo-bar-label { flex: 0 0 52px; color: #bfe6e4; }
.demo-bar-track {
  flex: 1;
  height: 8px;
  background: rgba(102, 255, 255, 0.08);
  border-radius: 6px;
  overflow: hidden;
}
.demo-bar-fill {
  display: block;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(54, 137, 129, 0.8), #66ffff);
  box-shadow: 0 0 10px rgba(102, 255, 255, 0.5);
}
.demo-bar-value { flex: 0 0 38px; text-align: right; color: #86fbe7; }

.demo-rows {
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  height: 100%;
}
.demo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  background: rgba(102, 255, 255, 0.035);
  border-left: 2px solid rgba(102, 255, 255, 0.25);
}
.demo-row-label { flex: 1; color: #d6f4f2; }
.demo-row-value { color: #86fbe7; font-variant-numeric: tabular-nums; }
.demo-row-trend {
  flex: 0 0 56px;
  text-align: right;
  color: #86fbe7;
  &.is-down { color: #ffb27a; }
}
.demo-rank-no {
  flex: 0 0 20px;
  height: 20px;
  line-height: 20px;
  text-align: center;
  font-style: normal;
  font-size: 12px;
  color: #91b9bb;
  background: rgba(102, 255, 255, 0.1);
  border-radius: 3px;
  &.is-top { color: #06211f; background: #66ffff; box-shadow: 0 0 8px rgba(102, 255, 255, 0.5); }
}

.demo-columns { display: flex; flex-direction: column; height: 100%; }
.demo-columns-chart {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 6px 4px 0;
  border-bottom: 1px solid rgba(102, 255, 255, 0.25);
  background: repeating-linear-gradient(0deg, transparent 0 24px, rgba(102, 255, 255, 0.05) 24px 25px);
}
.demo-column {
  flex: 1;
  min-width: 4px;
  background: linear-gradient(0deg, rgba(54, 137, 129, 0.55), #66ffff);
  border-radius: 2px 2px 0 0;
  box-shadow: 0 0 8px rgba(102, 255, 255, 0.3);
}
.demo-columns-axis {
  display: flex;
  justify-content: space-between;
  padding-top: 6px;
  font-size: 11px;
  color: #91b9bb;
}

.demo-table { font-size: 12px; }
.demo-table-head,
.demo-table-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 0.8fr;
  align-items: center;
  padding: 7px 8px;
}
.demo-table-head { color: #86fbe7; background: rgba(102, 255, 255, 0.08); }
.demo-table-row {
  border-bottom: 1px solid rgba(102, 255, 255, 0.08);
  &:nth-child(odd) { background: rgba(102, 255, 255, 0.025); }
  .is-ok { color: #86fbe7; }
  .is-warn { color: #ffb27a; }
}
</style>
