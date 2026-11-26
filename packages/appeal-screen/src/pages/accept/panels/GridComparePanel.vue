<script setup lang="ts">
/**
 * 验收大屏 · 网格对比（标书 1.2.8）
 *
 * 交互：选择 2~3 个行政网格（第 4 个禁用并提示「标书规定 2~3 个」）→ 开始对比
 * 结果：行=诉求类型（默认小类）或诉求大类，
 *       列=网格，格值=件数；按后端 `highest` 数组高亮最高值（并列全部高亮）；
 *       底部「合计」行 + 对比结论一句话。
 * 口径：真实主账 dataset=ledger / projection=current / periodKind=custom，窗口取大屏当前起止日期；
 *       未定位件单列（unlocatedCount），不参与网格对比；空/缺数据如实显示，不补 0。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import { hashQuery } from '@/stats/useDesignScale';
import { CATEGORY_OPTIONS } from '@/stats/realSource';
import {
  fetchAssessmentGrids,
  fetchGridComparison,
  FeatureApiError,
  type AssessmentGrid,
  type CategoryLevel,
  type ComparisonResult,
} from '@/stats/businessFeatures';
import { majorCategoryLabel } from './presetRules';

const props = defineProps<{
  /** 大屏当前统计窗口（筛选条开始/结束） */
  fromDate: string;
  toDate: string;
}>();

const qp = hashQuery();
/** 演示直达：?drawer=compare&cmp=3 = 预选 3 个有数据的网格并直接出结果 */
const demoCmp = qp.get('cmp');

/** 小类中文名（字典 19 个小类，与后台 dict 同源；缺失回退大类名/编码） */
const MINOR_LABELS: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((c) => [c.code, c.name]));
/** 标书 1.2.8：按「诉求类型」（小类）对比；?clevel=major 可切大类兼容口径 */
const level = ref<CategoryLevel>(qp.get('clevel') === 'major' ? 'major' : 'minor');
const categoryScope = computed(() => level.value === 'minor' ? '诉求类型（小类）' : '诉求大类');
function categoryLabel(code: string): string {
  if (level.value === 'minor') return MINOR_LABELS[code] ?? majorCategoryLabel(code);
  return majorCategoryLabel(code);
}

const grids = ref<AssessmentGrid[]>([]);
const gridLoading = ref(true);
const gridError = ref('');

const search = ref('');
const selected = ref<string[]>([]);
const phase = ref<'select' | 'result'>('select');
const tip = ref('');
let tipTimer: number | null = null;
let demoTimer: number | null = null;
let disposed = false;

const result = ref<ComparisonResult | null>(null);
const resultLoading = ref(false);
const resultError = ref('');
let compareSequence = 0;

const gridNameOf = computed<Record<string, string>>(() => Object.fromEntries(grids.value.map((g) => [g.code, g.name])));
const filtered = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return grids.value;
  return grids.value.filter((g) => g.code.includes(kw) || g.name.toLowerCase().includes(kw));
});
const selectedGrids = computed(() =>
  selected.value.map((code) => grids.value.find((g) => g.code === code) ?? { code, name: code, version: 0, hasGeometry: false })
);
const canCompare = computed(() => selected.value.length >= 2 && selected.value.length <= 3);
const selectHint = computed(() =>
  canCompare.value
    ? `已选 ${selected.value.length} 个网格，可开始对比`
    : `请选择 2~3 个网格（当前 ${selected.value.length} 个）`
);

function flashTip(msg: string) {
  tip.value = msg;
  if (tipTimer != null) window.clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => {
    tipTimer = null;
    tip.value = '';
  }, 3200);
}

function cancelDemo() {
  if (demoTimer == null) return;
  window.clearTimeout(demoTimer);
  demoTimer = null;
}

function toggle(code: string) {
  if (selected.value.includes(code)) {
    remove(code);
    return;
  }
  if (selected.value.length >= 3) {
    flashTip('标书规定 2~3 个网格：最多选择 3 个（第 4 个已禁用）');
    return;
  }
  cancelDemo();
  selected.value.push(code);
}
function remove(code: string) {
  const i = selected.value.indexOf(code);
  if (i < 0) return;
  cancelDemo();
  selected.value.splice(i, 1);
}
function clearAll() {
  selected.value = [];
  backToSelect();
}
function backToSelect() {
  cancelDemo();
  compareSequence++;
  phase.value = 'select';
  result.value = null;
  resultError.value = '';
  resultLoading.value = false;
}

async function runCompare() {
  if (disposed || !canCompare.value) return;
  cancelDemo();
  const sequence = ++compareSequence;
  phase.value = 'result';
  resultLoading.value = true;
  resultError.value = '';
  result.value = null;
  try {
    const data = await fetchGridComparison({
      adminGridCodes: [...selected.value],
      from: props.fromDate,
      to: props.toDate,
      categoryLevel: level.value,
    });
    if (sequence === compareSequence) result.value = data;
  } catch (e) {
    if (sequence !== compareSequence) return;
    resultError.value = e instanceof FeatureApiError ? `${e.message}（code=${e.code}）` : e instanceof Error ? e.message : String(e);
  } finally {
    if (sequence === compareSequence) resultLoading.value = false;
  }
}

/** 大类/小类切换：结果态直接按新口径重算（默认小类=标书「诉求类型」） */
function setLevel(next: CategoryLevel) {
  if (level.value === next) return;
  level.value = next;
  if (phase.value === 'result') void runCompare();
}

watch([() => props.fromDate, () => props.toDate], () => {
  if (phase.value === 'result') void runCompare();
});

async function loadGrids() {
  gridLoading.value = true;
  gridError.value = '';
  try {
    const list = await fetchAssessmentGrids();
    if (disposed) return;
    grids.value = list;
    if (list.length === 0) gridError.value = '当前范围无已登记的下级网格编码';
  } catch (e) {
    if (disposed) return;
    gridError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!disposed) gridLoading.value = false;
  }
}

const DEMO_CODES = ['420502001', '420502011', '420503003'];
onMounted(async () => {
  await loadGrids();
  if (disposed) return;
  if (demoCmp === '3' && grids.value.length) {
    const picked = DEMO_CODES.filter((c) => grids.value.some((g) => g.code === c));
    for (const g of grids.value) {
      if (picked.length >= 3) break;
      if (!picked.includes(g.code)) picked.push(g.code);
    }
    selected.value = picked.slice(0, 3);
    // 让主屏 3 份 bootstrap 先落地，避免首屏并发把对比请求挤掉（dev 代理偶发 ECONNRESET）
    demoTimer = window.setTimeout(() => {
      demoTimer = null;
      void runCompare();
    }, 900);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  compareSequence++;
  cancelDemo();
  if (tipTimer != null) window.clearTimeout(tipTimer);
});

/* ---------------------------------------------------------------- 结果派生 */

const rows = computed(() => result.value?.categories ?? []);
const gridCols = computed(() => result.value?.grids ?? []);

const totalsRow = computed(() => {
  const r = result.value;
  if (!r) return [] as number[];
  return gridCols.value.map((g) => r.totals[g.code] ?? 0);
});

const leader = computed(() => {
  const r = result.value;
  if (!r || !gridCols.value.length) return null;
  let best: { code: string; name: string; count: number } | null = null;
  for (const g of gridCols.value) {
    const count = r.totals[g.code] ?? 0;
    if (!best || count > best.count) best = { code: g.code, name: g.name, count };
  }
  return best;
});

const conclusion = computed(() => {
  const r = result.value;
  if (!r || !gridCols.value.length) return '';
  const parts: string[] = [];
  const totalAll = sum(totalsRow.value);
  const lead = leader.value;
  if (lead) {
    parts.push(`所选 ${gridCols.value.length} 个网格合计 ${totalAll} 条，${lead.name}最高（${lead.count} 条）`);
  }
  // 取当前分类口径下件数最多的前 3 项，列出各项件数最高的网格（含并列）。
  const topRows = [...rows.value].sort((a, b) => b.count - a.count).slice(0, 3);
  for (const c of topRows) {
    const names = c.highest.map((code) => gridNameOf.value[code] ?? code).filter(Boolean);
    if (!names.length) continue;
    const count = c.counts[c.highest[0]] ?? 0;
    parts.push(`${categoryLabel(c.code)}由${names.join(' / ')}最高（${count} 条${names.length > 1 ? '，并列' : ''}）`);
  }
  return parts.join('；') + '。';
});

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

/* ---------------------------------------------------------------- 并列柱状图（分类 × 网格） */

const GRID_COLORS = ['#baa6ff', '#ffd67c', '#7fb2ff'];

const chartOption = computed<EChartsCoreOption>(() => {
  const r = result.value;
  if (!r || !r.categories.length) return { animation: false };
  const names = r.categories.map((c) => `${categoryLabel(c.code)}·v${c.dictionaryVersion}`).reverse();
  const series = r.grids.map((g, gi) => ({
    name: g.name,
    type: 'bar' as const,
    barWidth: 12,
    barGap: '26%',
    itemStyle: { color: GRID_COLORS[gi % GRID_COLORS.length] },
    data: [...r.categories]
      .reverse()
      .map((c) => ({
        value: c.counts[g.code] ?? 0,
        itemStyle: {
          color: c.highest.includes(g.code) ? '#86fbe7' : GRID_COLORS[gi % GRID_COLORS.length],
          borderRadius: [0, 5, 5, 0] as [number, number, number, number],
          shadowBlur: c.highest.includes(g.code) ? 10 : 0,
          shadowColor: 'rgba(134,251,231,0.55)',
          borderColor: c.highest.includes(g.code) ? '#eafffa' : 'transparent',
          borderWidth: c.highest.includes(g.code) ? 1 : 0,
        },
        label: {
          show: true,
          position: 'right' as const,
          color: '#cfece5',
          fontSize: 10,
          fontFamily: "'Bahnschrift','Microsoft YaHei',sans-serif",
          formatter: () => String(c.counts[g.code] ?? 0),
        },
      })),
  }));
  return {
    animation: false,
    grid: { left: 8, right: 46, top: 22, bottom: 2, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: '#9bc9c5', fontSize: 10, fontFamily: "'Bahnschrift','Microsoft YaHei',sans-serif" },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(3,27,26,0.94)',
      borderColor: '#86fbe7',
      textStyle: { color: '#d0eeea', fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(134,251,231,0.08)' } },
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number }[];
        const idx = arr[0]?.dataIndex ?? 0;
        const c = [...r.categories].reverse()[idx];
        if (!c) return '';
        const lines = [`<b>${categoryLabel(c.code)}</b>（字典 v${c.dictionaryVersion}）`];
        for (const g of r.grids) {
          const hit = c.highest.includes(g.code) ? ' ◀ 最高' : '';
          lines.push(`${g.name}：${c.counts[g.code] ?? 0} 条${hit}`);
        }
        return lines.join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#377b72' } },
      axisLabel: { color: '#9bc9c5', fontSize: 10 },
      splitLine: { lineStyle: { color: '#17443f', type: 'dashed' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#377b72' } },
      axisLabel: { color: '#9bc9c5', fontSize: 10 },
    },
    series,
  };
});
</script>

<template>
  <div class="cmp">
    <!-- 口径条 -->
    <div class="cmp__meta">
      <span class="cmp__chip"><i>统计期间</i>{{ fromDate }} ~ {{ toDate }}</span>
      <span class="cmp__chip"><i>数据口径</i>诉求总账 · 来源明确办结（ledger / current）</span>
      <span class="cmp__chip"><i>分类口径</i>{{ categoryScope }}</span>
      <span v-if="grids.length && grids.every(grid => !grid.hasGeometry)" class="cmp__chip"><i>网格口径</i>按登记的下级编码比较，正式社区网格目录待核验</span>
      <span v-if="result" class="cmp__chip"><i>缺下级网格关联</i>{{ result.unlocatedCount }} 件</span>
      <span v-if="result" class="cmp__chip"><i>快照</i>{{ (result.snapshotId ?? '—').slice(0, 16) }}</span>
      <div class="cmp__level" role="group" aria-label="分类层级切换">
        <button type="button" :class="{ 'is-active': level === 'minor' }" @click="setLevel('minor')">小类 · 诉求类型</button>
        <button type="button" :class="{ 'is-active': level === 'major' }" @click="setLevel('major')">大类</button>
      </div>
    </div>

    <!-- 选择态 -->
    <section v-if="phase === 'select'" class="cmp__select">
      <div class="cmp__picker">
        <div class="cmp__search">
          <input v-model="search" type="search" placeholder="搜索行政网格编码 / 名称" aria-label="搜索行政网格" />
          <span>{{ filtered.length }} / {{ grids.length }} 个网格</span>
        </div>
        <div v-if="gridLoading" class="cmp__loading">行政网格加载中…</div>
        <div v-else-if="gridError && !grids.length" class="acc-empty">
          <b>行政网格不可用</b>
          <span>{{ gridError }}</span>
        </div>
        <div v-else class="cmp__gridlist" role="listbox" aria-multiselectable="true" aria-label="行政网格列表">
          <button
            v-for="g in filtered"
            :key="g.code"
            type="button"
            role="option"
            :aria-selected="selected.includes(g.code)"
            class="cmp__griditem"
            :class="{ 'is-selected': selected.includes(g.code) }"
            @click="toggle(g.code)"
          >
            <span class="cmp__check">{{ selected.includes(g.code) ? '✓' : '+' }}</span>
            <span class="cmp__gname">{{ g.name }}</span>
            <span class="cmp__gcode">{{ g.code }}</span>
          </button>
        </div>
      </div>

      <div class="cmp__selected">
        <div class="cmp__selected-head">
          <b>对比网格（{{ selected.length }} / 3）</b>
          <button type="button" class="cmp__link" :disabled="!selected.length" @click="clearAll">清空</button>
        </div>
        <div v-if="!selectedGrids.length" class="cmp__empty-select">尚未选择网格：从左侧点选 2~3 个行政网格</div>
        <ul v-else class="cmp__chips">
          <li v-for="g in selectedGrids" :key="g.code" class="cmp__chipsel">
            <span class="cmp__chipname">{{ g.name }}</span>
            <span class="cmp__chipcode">{{ g.code }}</span>
            <button type="button" class="cmp__remove" :aria-label="`移除 ${g.name}`" @click="remove(g.code)">×</button>
          </li>
        </ul>
        <div class="cmp__submitbar">
          <button type="button" class="cmp__submit" :disabled="!canCompare" @click="runCompare">开始对比</button>
          <span class="cmp__hint" :class="{ 'is-warn': !canCompare }">{{ selectHint }}</span>
          <span v-if="tip" class="cmp__tip">{{ tip }}</span>
        </div>
      </div>
    </section>

    <!-- 结果态：已选网格 + 重新选择 -->
    <section v-else class="cmp__resultbar">
      <div class="cmp__resultchips">
        <span class="cmp__resultlabel">对比网格</span>
        <span v-for="g in selectedGrids" :key="g.code" class="cmp__resultchip">{{ g.name }}<i>{{ g.code }}</i></span>
      </div>
      <button type="button" class="cmp__reselect" @click="backToSelect">重新选择</button>
    </section>

    <!-- 结果区 -->
    <section v-if="phase === 'result'" class="cmp__result">
      <div v-if="resultLoading" class="cmp__skeleton" aria-busy="true">
        <i v-for="n in 6" :key="n" :style="{ width: `${40 + ((n * 13) % 50)}%` }"></i>
      </div>

      <div v-else-if="resultError" class="acc-empty acc-empty--error">
        <b>网格对比失败</b>
        <span>{{ resultError }}</span>
        <button type="button" @click="runCompare">重新对比</button>
      </div>

      <template v-else-if="result">
        <div v-if="!rows.length" class="acc-empty">
          <b>暂无{{ categoryScope }}对比记录</b>
          <span>请核查所选网格、统计期间和分类映射。</span>
        </div>

        <template v-else>
          <!-- 对比表：行=诉求类型（默认小类）/ 大类，列=网格，最大值按 highest 高亮（并列全部高亮） -->
          <div class="cmp__tablewrap">
            <table class="cmp__table">
              <thead>
                <tr>
                  <th class="cmp__th-cat">{{ categoryScope }} / 分类版本</th>
                  <th v-for="g in gridCols" :key="g.code">
                    <span>{{ g.name }}</span>
                    <small>{{ g.code }}</small>
                  </th>
                  <th class="cmp__th-count">合计</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in rows" :key="c.code + '@' + c.dictionaryVersion">
                  <th class="cmp__th-cat">
                    <b>{{ categoryLabel(c.code) }}</b>
                    <small>{{ c.code }} · 字典 v{{ c.dictionaryVersion }}</small>
                  </th>
                  <td v-for="g in gridCols" :key="g.code">
                    <span class="cmp__cell" :class="{ 'is-max': c.highest.includes(g.code) }">
                      {{ c.counts[g.code] ?? 0 }}
                      <em v-if="c.highest.includes(g.code)">最高</em>
                    </span>
                  </td>
                  <td class="cmp__cell-total">{{ c.count }}</td>
                </tr>
                <tr class="cmp__totalrow">
                  <th class="cmp__th-cat">合计</th>
                  <td v-for="(n, i) in totalsRow" :key="i">{{ n }}</td>
                  <td class="cmp__cell-total">{{ sum(totalsRow) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="cmp__bottom">
            <!-- 各网格合计卡 -->
            <div class="cmp__totals">
              <div v-for="(g, gi) in gridCols" :key="g.code" class="cmp__totalcard" :style="{ borderTopColor: GRID_COLORS[gi % GRID_COLORS.length] }">
                <b>{{ g.name }}</b>
                <span class="cmp__totalnum">{{ result.totals[g.code] ?? 0 }}<i>条</i></span>
                <span class="cmp__totalsub">{{ g.code }}</span>
              </div>
              <div class="cmp__conclusion">
                <b>对比结论</b>
                <span>{{ conclusion }}</span>
                <span v-if="result.partial" class="cmp__warn">当前统计窗口存在不完整来源，对比结果仅供参考。</span>
              </div>
            </div>

            <!-- 并列柱状图：分类 × 网格 -->
            <div class="cmp__chartwrap">
              <div class="cmp__charthead">
                <b>按{{ categoryScope }}并列对比（条）</b>
                <span>青色高亮 = 该分类最高（并列全部高亮）</span>
              </div>
              <EChart class="cmp__chart" :option="chartOption" />
            </div>
          </div>

          <p class="cmp__foot">
            资料截止 {{ result.dataCutoffAt ?? '—' }} · {{ result.timeBasis ?? '宜接就办来源录入时间' }} · {{ result.coverageNote ?? '' }}
          </p>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.cmp {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}
.cmp__meta {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding: 6px 8px;
  background: rgba(6, 38, 36, 0.72);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.cmp__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: #cfece5;
  white-space: nowrap;
}
.cmp__chip i {
  font-style: normal;
  padding: 0 4px;
  font-size: 9.5px;
  color: #7fa9a0;
  border: 1px solid rgba(52, 139, 124, 0.45);
  background: rgba(10, 54, 50, 0.6);
}
.cmp__level {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 3px;
}
.cmp__level button {
  padding: 2px 9px;
  font-family: inherit;
  font-size: 10px;
  color: #9bc9c5;
  background: rgba(10, 54, 50, 0.7);
  border: 1px solid rgba(52, 139, 124, 0.45);
  cursor: pointer;
}
.cmp__level button:hover {
  border-color: #86fbe7;
  color: #eafffa;
}
.cmp__level button.is-active {
  color: #041d1e;
  background: linear-gradient(180deg, #86fbe7, #35b9a2);
  border-color: #86fbe7;
}
.cmp__select {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 10px;
}
.cmp__picker {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.5);
}
.cmp__search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.32);
}
.cmp__search input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-family: inherit;
  font-size: 12px;
  color: #d5f8ef;
  background: #0c3632;
  border: 1px solid #2b7064;
  outline: none;
}
.cmp__search input:focus {
  border-color: #86fbe7;
}
.cmp__search span {
  flex: none;
  font-size: 10px;
  color: #7fa9a0;
}
.cmp__loading {
  padding: 20px;
  text-align: center;
  font-size: 11px;
  color: #7fa9a0;
}
.cmp__gridlist {
  flex: 1;
  min-height: 0;
  max-height: 420px;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 5px;
}
.cmp__griditem {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 5px 6px;
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  color: #d6f6ef;
  background: rgba(10, 48, 44, 0.5);
  border: 1px solid rgba(52, 139, 124, 0.3);
  cursor: pointer;
}
.cmp__griditem:hover {
  border-color: #86fbe7;
  background: rgba(20, 92, 82, 0.55);
}
.cmp__griditem.is-selected {
  border-color: #86fbe7;
  background: rgba(20, 110, 96, 0.62);
  box-shadow: inset 0 0 12px rgba(134, 251, 231, 0.16);
}
.cmp__check {
  flex: none;
  width: 13px;
  height: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #041d1e;
  background: rgba(134, 251, 231, 0.85);
}
.cmp__griditem:not(.is-selected) .cmp__check {
  color: #7fa9a0;
  background: rgba(12, 54, 50, 0.9);
  border: 1px solid rgba(52, 139, 124, 0.4);
}
.cmp__gname {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmp__gcode {
  margin-left: auto;
  flex: none;
  font-size: 9px;
  color: #6f9a93;
}
.cmp__selected {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.5);
}
.cmp__selected-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #b9fff3;
}
.cmp__link {
  padding: 1px 8px;
  font-family: inherit;
  font-size: 10px;
  color: #86fbe7;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.cmp__link:disabled {
  opacity: 0.45;
  cursor: default;
}
.cmp__empty-select {
  padding: 16px 10px;
  font-size: 11px;
  text-align: center;
  color: #7fa9a0;
  border: 1px dashed rgba(52, 139, 124, 0.4);
}
.cmp__chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cmp__chipsel {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  font-size: 11px;
  color: #eafffa;
  background: rgba(14, 74, 65, 0.6);
  border-left: 3px solid #86fbe7;
}
.cmp__chipname {
  white-space: nowrap;
}
.cmp__chipcode {
  font-size: 9.5px;
  color: #8ab9b0;
}
.cmp__remove {
  margin-left: auto;
  width: 16px;
  height: 16px;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  color: #ffb3b3;
  background: rgba(120, 28, 28, 0.35);
  border: 1px solid rgba(255, 91, 91, 0.45);
  cursor: pointer;
}
.cmp__remove:hover {
  background: rgba(160, 38, 38, 0.6);
  color: #fff;
}
.cmp__submitbar {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cmp__submit {
  padding: 7px 10px;
  font-family: inherit;
  font-size: 12.5px;
  letter-spacing: 1px;
  color: #041d1e;
  background: linear-gradient(180deg, #86fbe7, #35b9a2);
  border: 1px solid #86fbe7;
  cursor: pointer;
}
.cmp__submit:disabled {
  color: #6f9a93;
  background: rgba(12, 54, 50, 0.75);
  border-color: rgba(52, 139, 124, 0.45);
  cursor: not-allowed;
}
.cmp__hint {
  font-size: 10px;
  color: #86fbe7;
}
.cmp__hint.is-warn {
  color: #ffd67c;
}
.cmp__tip {
  font-size: 10px;
  color: #ffb3b3;
}
.cmp__resultbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(6, 38, 36, 0.65);
}
.cmp__resultchips {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.cmp__resultlabel {
  flex: none;
  font-size: 10px;
  color: #7fa9a0;
}
.cmp__resultchip {
  flex: none;
  padding: 1px 8px;
  font-size: 11px;
  color: #041d1e;
  background: rgba(134, 251, 231, 0.82);
}
.cmp__resultchip i {
  margin-left: 4px;
  font-style: normal;
  font-size: 9px;
  color: #0b4a42;
}
.cmp__reselect {
  margin-left: auto;
  flex: none;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 11px;
  color: #86fbe7;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.cmp__reselect:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
.cmp__result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cmp__tablewrap {
  flex: 1.25;
  min-height: 0;
  overflow: auto;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.55);
  padding: 6px;
}
.cmp__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  color: #d6f6ef;
  table-layout: fixed;
}
.cmp__table th,
.cmp__table td {
  padding: 1px 8px;
  text-align: center;
  border-bottom: 1px solid rgba(52, 139, 124, 0.22);
}
.cmp__table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  font-weight: 400;
  color: #b9fff3;
  background: #08201f;
  border-bottom: 1px solid rgba(52, 139, 124, 0.55);
}
.cmp__table thead th span {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmp__table thead th small {
  display: block;
  font-size: 9px;
  color: #7fa9a0;
}
.cmp__th-cat {
  width: 24%;
  text-align: left;
  font-weight: 400;
  color: #a8d8ce;
}
.cmp__th-cat b {
  display: block;
  font-size: 11.5px;
  font-weight: 400;
  line-height: 1.2;
  color: #eafffa;
}
.cmp__th-cat small {
  display: block;
  font-size: 8.5px;
  line-height: 1.15;
  color: #7fa9a0;
}
.cmp__th-count {
  width: 90px;
}
.cmp__cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 48px;
  justify-content: center;
  padding: 2px 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: #d6f6ef;
  background: rgba(14, 74, 65, 0.32);
  border: 1px solid transparent;
}
.cmp__cell em {
  font-style: normal;
  font-size: 8.5px;
  padding: 0 3px;
  color: #041d1e;
  background: #86fbe7;
}
.cmp__cell.is-max {
  color: #041d1e;
  font-weight: 700;
  background: linear-gradient(180deg, #86fbe7, #4fd7bf);
  border-color: #eafffa;
  box-shadow: 0 0 8px rgba(134, 251, 231, 0.45);
}
.cmp__cell-total {
  font-size: 12px;
  color: #86fbe7;
  font-variant-numeric: tabular-nums;
}
.cmp__totalrow th,
.cmp__totalrow td {
  position: sticky;
  bottom: 0;
  z-index: 2;
  background: #08201f;
  border-top: 1px solid rgba(52, 139, 124, 0.5);
  border-bottom: 0;
  font-size: 13px;
  color: #86fbe7;
}
.cmp__totalrow th {
  color: #7fa9a0;
  font-weight: 400;
  font-size: 12px;
}
.cmp__bottom {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 0.82fr) minmax(0, 1fr);
  gap: 8px;
}
.cmp__totals {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}
.cmp__totalcard {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px;
  background: linear-gradient(180deg, rgba(9, 52, 47, 0.8), rgba(4, 26, 25, 0.72));
  border: 1px solid rgba(52, 139, 124, 0.4);
  border-top: 2px solid #86fbe7;
}
.cmp__totalcard b {
  font-size: 12px;
  font-weight: 400;
  color: #eafffa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmp__totalnum {
  margin-left: auto;
  font-family: 'Bahnschrift', 'Microsoft YaHei', sans-serif;
  font-size: 24px;
  line-height: 1.1;
  color: #86fbe7;
}
.cmp__totalnum i {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  color: #7fa9a0;
}
.cmp__totalsub {
  font-size: 9.5px;
  color: #7fa9a0;
}
.cmp__conclusion {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(61, 48, 12, 0.28);
  border: 1px dashed rgba(255, 214, 124, 0.34);
}
.cmp__conclusion b {
  font-size: 11px;
  font-weight: 400;
  color: #ffd67c;
}
.cmp__conclusion span {
  font-size: 11px;
  line-height: 1.55;
  color: #e4e0c8;
}
.cmp__warn {
  margin-top: auto;
  font-size: 9.5px !important;
  color: #ffb3b3 !important;
}
.cmp__chartwrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.55);
  padding: 6px 6px 2px;
}
.cmp__charthead {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}
.cmp__charthead b {
  font-size: 11.5px;
  font-weight: 400;
  color: #b9fff3;
}
.cmp__charthead span {
  margin-left: auto;
  font-size: 9.5px;
  color: #7fa9a0;
}
.cmp__chart {
  flex: 1;
  min-height: 150px;
}
.cmp__foot {
  flex: none;
  margin: 0;
  font-size: 9.5px;
  color: #7fa9a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmp__skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 4px;
}
.cmp__skeleton i {
  display: block;
  height: 18px;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.14), rgba(84, 213, 188, 0.34), rgba(84, 213, 188, 0.14));
  animation: cmp-pulse 1.1s ease-in-out infinite alternate;
}
@keyframes cmp-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
</style>
