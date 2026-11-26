<script setup lang="ts">
/**
 * 验收大屏 · 冬夏研判（标书 1.2.11）
 *
 * 冬季保供 = 燃气气压问题(g08)，保障期 11 月–次年 3 月；夏季保畅 = 水压问题(w04)，6–9 月。
 * 三块（全部来自 /assessment/seasonal?scene&businessType&year 的真实返回）：
 *   ① 近 5 个保障季年度诉求量（count=null → 无数据/规则未覆盖，**不补 0**）
 *   ② 上年度保障期月度诉求量（previousMonths；无接入记录月不补 0）
 *   ③ 本期 Top6 行政网格 + 上一保障季同期（previousCount=null → 资料不足，不据此算降幅）
 * 保障期规则未发布时显示「保障期未配置：需主管部门确认起止日期」，不自编日期。
 */
import { computed, onMounted, ref } from 'vue';
import EChart from '@/stats/components/EChart.vue';
import type { EChartsCoreOption } from '@/stats/echarts';
import { hashQuery } from '@/stats/useDesignScale';
import { fetchSeasonal, fetchSeasonalDetails, FeatureApiError, type SeasonalResult, type SeasonalSeasonRow, type SeasonalDetailRow } from '@/stats/businessFeatures';
import { PRESET_RULES } from './presetRules';

const qp = hashQuery();
const now = new Date();
const currentYear = now.getFullYear();

type Scene = 'winter' | 'summer';
const SCENES: { key: Scene; label: string; business: 'gas' | 'water'; category: string; ruleId: string }[] = [
  { key: 'winter', label: '冬季保供', business: 'gas', category: '燃气气压问题(g08) · 保障期 11 月–次年 3 月', ruleId: 'seasonal-winter-gas-pressure' },
  { key: 'summer', label: '夏季保畅', business: 'water', category: '水压问题(w04) · 保障期 6–9 月', ruleId: 'seasonal-summer-water-pressure' },
];

/** 默认最近已结束保障季：冬季取上一年（本年 11 月才开始，未结束）；夏季 10 月后取本年 */
function defaultYear(scene: Scene): number {
  if (scene === 'winter') return currentYear - 1;
  return now.getMonth() + 1 > 9 ? currentYear : currentYear - 1;
}

const initScene = (qp.get('season') === 'summer' ? 'summer' : 'winter') as Scene;
const scene = ref<Scene>(initScene);
const initYear = Number(qp.get('year'));
const year = ref(Number.isInteger(initYear) && initYear >= currentYear - 4 && initYear <= currentYear ? initYear : defaultYear(initScene));

const loading = ref(false);
const error = ref('');
const data = ref<SeasonalResult | null>(null);
let summaryRequest = 0;

const yearOptions = computed(() => Array.from({ length: 5 }, (_, i) => currentYear - i));

const sceneMeta = computed(() => SCENES.find((s) => s.key === scene.value) ?? SCENES[0]);
const preset = computed(() => PRESET_RULES.find((r) => r.ruleId === data.value?.rule?.ruleId) ?? null);
const currentSeasonOutsideRule = computed(() => data.value?.seasons?.[0]?.status === 'outside_rule_period');

const statusText = (s: string): string =>
  ({ observed: '已接入观测', insufficient: '无数据（资料不足）', outside_rule_period: '规则有效期未覆盖', truncated: '本期截至' })[s] ?? s;

const seasonNote = (s: SeasonalSeasonRow): string => {
  const range = `${s.from} ~ ${s.observedTo ?? s.to}`;
  if (s.count === null) {
    return s.status === 'outside_rule_period'
      ? `${s.year}季：规则有效期未覆盖（不按 0 计）`
      : `${s.year}季：无数据（资料不足，不补 0）`;
  }
  return `${s.year}季：${range}${s.truncated ? '（本季进行中，仅统计截至该日）' : ''} · ${s.count} 条`;
};

async function load() {
  const request = ++summaryRequest;
  resetDetails();
  loading.value = true;
  error.value = '';
  data.value = null;
  try {
    const result = await fetchSeasonal({ scene: scene.value, businessType: sceneMeta.value.business, year: year.value });
    if (request === summaryRequest) data.value = result;
  } catch (e) {
    if (request !== summaryRequest) return;
    error.value = e instanceof FeatureApiError ? `${e.message}（code=${e.code}）` : e instanceof Error ? e.message : String(e);
  } finally {
    if (request === summaryRequest) loading.value = false;
  }
}

function switchScene(s: Scene) {
  if (scene.value === s) return;
  scene.value = s;
  year.value = defaultYear(s);
  void load();
}

onMounted(() => void load());

/* ------------------------------------------------------------ 明细（按需拉取） */

/**
 * 明细展开状态与数据。
 *
 * 为什么按需：一个保障季可能有上千条诉求，一次性拉回来会拖慢面板；
 * 主接口通过覆盖索引查询统计列，案号和标题由明细接口返回。
 * 这里做成「用户点开才请求」，默认收起，首屏零额外开销。
 */
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detailReason = ref('');
const detailRows = ref<SeasonalDetailRow[]>([]);
const detailTotal = ref<number | null>(null);
const detailPage = ref(1);
let detailRequest = 0;
const DETAIL_SIZE = 20;

const detailPages = computed(() => Math.max(1, Math.ceil((detailTotal.value ?? 0) / DETAIL_SIZE)));

async function loadDetails(page = 1) {
  const request = ++detailRequest;
  detailLoading.value = true;
  detailError.value = '';
  detailReason.value = '';
  try {
    const r = await fetchSeasonalDetails({
      scene: scene.value,
      businessType: sceneMeta.value.business,
      year: year.value,
      page,
      size: DETAIL_SIZE,
    });
    if (request !== detailRequest) return;
    detailRows.value = r.items;
    detailTotal.value = r.total;
    detailPage.value = r.page;
    if (r.status !== 'available') detailReason.value = r.reason ?? statusText(r.status);
  } catch (e) {
    if (request !== detailRequest) return;
    detailError.value = e instanceof FeatureApiError ? `${e.message}（code=${e.code}）` : e instanceof Error ? e.message : String(e);
    detailRows.value = [];
    detailTotal.value = null;
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

function toggleDetails() {
  detailOpen.value = !detailOpen.value;
  // 首次展开才拉数据；之后保留已取到的页
  if (detailOpen.value && detailTotal.value === null && !detailReason.value && !detailLoading.value) void loadDetails(1);
}

function goDetailPage(p: number) {
  const target = Math.min(Math.max(1, p), detailPages.value);
  if (target !== detailPage.value) void loadDetails(target);
}

/** 切换季节/年份后清空明细，避免显示上一季的数据 */
function resetDetails() {
  detailRequest++;
  detailOpen.value = false;
  detailLoading.value = false;
  detailRows.value = [];
  detailTotal.value = null;
  detailPage.value = 1;
  detailError.value = '';
  detailReason.value = '';
}

function fmtDetailTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- ① 近 5 年年度量 */

const seasonsAsc = computed(() => [...(data.value?.seasons ?? [])].reverse());

const annualOption = computed<EChartsCoreOption>(() => {
  const rows = seasonsAsc.value;
  const missing = new Map(rows.filter((r) => r.count === null).map((r) => [`${r.year}季`, r.status === 'outside_rule_period' ? '规则未覆盖' : '无数据']));
  return {
    animation: false,
    grid: { left: 8, right: 12, top: 20, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(3,27,26,0.94)',
      borderColor: '#86fbe7',
      textStyle: { color: '#d0eeea', fontSize: 12 },
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number }[];
        const r = rows[arr[0]?.dataIndex ?? 0];
        if (!r) return '';
        const val = r.count === null ? '无数据（不补 0）' : `<b>${r.count}</b> 条`;
        return `<b>${r.year}季</b><br/>${r.from} ~ ${r.observedTo ?? r.to}${r.truncated ? '（本季进行中）' : ''}<br/>${val}`;
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => `${r.year}季`),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#377b72' } },
      axisLabel: {
        color: '#9bc9c5',
        fontSize: 11,
        interval: 0,
        formatter: (v: string) => (missing.has(v) ? `{na|${v}}\n{na|${missing.get(v)}}` : v),
        rich: { na: { color: '#ffd67c', fontSize: 9, lineHeight: 13 } },
      },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#9bc9c5', fontSize: 9 },
      splitLine: { lineStyle: { color: '#17443f', type: 'dashed' } },
    },
    series: [
      {
        type: 'bar',
        barWidth: 30,
        data: rows.map((r, i) => ({
          value: r.count,
          itemStyle: {
            color: i === rows.length - 1 ? '#86fbe7' : 'rgba(84,213,188,0.6)',
            borderRadius: [3, 3, 0, 0],
            shadowBlur: i === rows.length - 1 ? 10 : 0,
            shadowColor: 'rgba(134,251,231,0.5)',
          },
          label: {
            show: r.count !== null,
            position: 'top',
            color: '#cfece5',
            fontSize: 10,
            formatter: () => String(r.count ?? ''),
          },
        })),
      },
    ],
  };
});

/* ---------------------------------------------------------------- ② 上年度保障期月度 */

const previousMonths = computed(() => data.value?.previousMonths ?? []);

const monthlyOption = computed<EChartsCoreOption>(() => {
  const rows = previousMonths.value;
  return {
    animation: false,
    grid: { left: 8, right: 14, top: 18, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(3,27,26,0.94)',
      borderColor: '#86fbe7',
      textStyle: { color: '#d0eeea', fontSize: 12 },
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number }[];
        const m = rows[arr[0]?.dataIndex ?? 0];
        if (!m) return '';
        const val = m.count === null ? `无数据（${statusText(m.status)}，不补 0）` : `<b>${m.count}</b> 条`;
        return `<b>${m.month}</b><br/>${val}`;
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((m) => m.month),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#377b72' } },
      axisLabel: {
        color: '#9bc9c5',
        fontSize: 10,
        interval: 0,
        formatter: (v: string) => {
          const m = rows.find((x) => x.month === v);
          return m && m.count === null ? `{na|${v}}\n{na|无数据}` : v;
        },
        rich: { na: { color: '#ffd67c', fontSize: 9, lineHeight: 13 } },
      },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#9bc9c5', fontSize: 9 },
      splitLine: { lineStyle: { color: '#17443f', type: 'dashed' } },
    },
    series: [
      {
        type: 'bar',
        barWidth: 22,
        data: rows.map((m) => m.count),
        itemStyle: { color: 'rgba(127,178,255,0.78)', borderRadius: [3, 3, 0, 0] },
        label: {
          show: true,
          position: 'top',
          color: '#cfece5',
          fontSize: 10,
          formatter: (p: { value: number | null }) => (p.value === null ? '' : String(p.value)),
        },
      },
    ],
  };
});

/** 上一保障季起止（来自年度量第 2 行） */
const previousSeason = computed(() => seasonsAsc.value[Math.max(0, seasonsAsc.value.length - 2)] ?? null);

/* ---------------------------------------------------------------- ③ Top6 网格 */

const top6 = computed(() => data.value?.top6 ?? []);
const DETAIL_ROWS_LIMIT = 6;

const topRows = computed(() => top6.value.slice(0, DETAIL_ROWS_LIMIT));
const topChartRows = computed(() => [...topRows.value].reverse());

function deltaOf(r: { count: number; previousCount: number | null }): { text: string; tone: string } {
  if (r.previousCount === null) return { text: '资料不足', tone: 'is-na' };
  if (r.previousCount === 0) return { text: '基期为零', tone: 'is-na' };
  const pct = Math.round(((r.count - r.previousCount) / r.previousCount) * 1000) / 10;
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, tone: pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : '' };
}

const topOption = computed<EChartsCoreOption>(() => {
  const rows = topChartRows.value;
  return {
    animation: false,
    grid: { left: 6, right: 40, top: 22, bottom: 2, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: '#9bc9c5', fontSize: 9.5 },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(3,27,26,0.94)',
      borderColor: '#86fbe7',
      textStyle: { color: '#d0eeea', fontSize: 12 },
      axisPointer: { type: 'shadow' },
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number }[];
        const r = rows[arr[0]?.dataIndex ?? 0];
        if (!r) return '';
        return `<b>${r.name ?? r.code}</b><br/>本期：${r.count} 条<br/>上一保障季：${
          r.previousCount === null ? '资料不足（无记录）' : r.previousCount + ' 条'
        }`;
      },
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#9bc9c5', fontSize: 9 },
      splitLine: { lineStyle: { color: '#17443f', type: 'dashed' } },
      axisLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.name ?? r.code),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#377b72' } },
      axisLabel: { color: '#9bc9c5', fontSize: 9.5, margin: 4 },
    },
    series: [
      {
        name: '本期',
        type: 'bar',
        barWidth: 9,
        barGap: '24%',
        itemStyle: { color: '#86fbe7', borderRadius: [0, 4, 4, 0] },
        data: rows.map((r) => r.count),
        label: {
          show: true,
          position: 'right',
          color: '#cfece5',
          fontSize: 9,
          formatter: (p: { value: number }) => String(p.value),
        },
      },
      {
        name: '上一保障季',
        type: 'bar',
        barWidth: 9,
        itemStyle: { color: 'rgba(127,178,255,0.72)', borderRadius: [0, 4, 4, 0] },
        data: rows.map((r) => r.previousCount),
      },
    ],
  };
});
</script>

<template>
  <div class="sea">
    <!-- 场景切换 + 规则口径 -->
    <header class="sea__top">
      <div class="sea__scenes" role="group" aria-label="冬夏研判场景">
        <button
          v-for="s in SCENES"
          :key="s.key"
          type="button"
          class="sea__scene"
          :class="{ 'is-active': scene === s.key }"
          @click="switchScene(s.key)"
        >
          <b>{{ s.label }}</b>
          <span>{{ s.category }}</span>
        </button>
      </div>
      <label class="sea__year">
        保障季开始年份
        <select v-model.number="year" @change="load">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
        </select>
      </label>
      <span class="sea__defaultnote">默认最近已结束保障季；可切换年份</span>
    </header>

    <div v-if="data?.rule" class="sea__rule">
      <b>{{ data.rule.name }} · 发布版本 v{{ data.rule.version }}</b>
      <span>{{ data.rule.definitionBasis }}</span>
    </div>

    <!-- loading / error / 未配置 -->
    <div v-if="loading" class="sea__skeleton" aria-busy="true">
      <div v-for="n in 3" :key="n" class="sea__skblock"><i class="sea__sktitle"></i><i class="sea__skchart"></i></div>
    </div>
    <div v-else-if="error" class="acc-empty acc-empty--error sea__state">
      <b>冬夏研判加载失败</b>
      <span>{{ error }}</span>
      <button type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="data && data.status === 'unconfigured'" class="acc-empty sea__state">
      <b>保障期未配置：需主管部门确认起止日期</b>
      <span>{{ data.reason ?? '该业务保障季及正式分类映射尚未发布，系统不自编保障期。' }}</span>
      <span class="sea__trace">规则未发布前不展示任何推算数据（不补 0、不估算降幅）。</span>
    </div>
    <div v-else-if="data && data.status === 'not_started'" class="acc-empty sea__state">
      <b>所选保障季尚未开始</b>
      <span>{{ data.reason ?? '保障期起止由已发布规则确定，未开始不展示推算数据。' }}</span>
    </div>

    <template v-else-if="data && data.status === 'available'">
      <div class="sea__blocks">
        <!-- ① 近 5 年保障期年度量 -->
        <section class="sea__block">
          <header class="sea__blockhead">
            <b>① 近 5 个保障季年度诉求量</b>
            <span v-if="data.rule" class="sea__std">{{ data.rule.name }} · 版本 v{{ data.rule.version }}</span>
          </header>
          <p class="sea__cov">
            口径：{{ sceneMeta.category }}；近 5 个保障季；无接入记录/规则未覆盖年度写「无数据/规则未覆盖」，不补 0。
          </p>
          <div class="sea__chart sea__chart--annual"><EChart :option="annualOption" /></div>
          <p class="sea__notes">
            <span v-for="s in seasonsAsc" :key="s.year" class="sea__notecell" :class="{ 'is-na': s.count === null }">{{ seasonNote(s) }}</span>
          </p>
        </section>

        <!-- ② 上年度保障期月度诉求量 -->
        <section class="sea__block">
          <header class="sea__blockhead">
            <b>② 上年度保障期月度诉求量</b>
            <span v-if="previousSeason" class="sea__std">
              上一保障季 {{ previousSeason.year }}：{{ previousSeason.from }} ~ {{ previousSeason.observedTo ?? previousSeason.to }}
            </span>
          </header>
          <p class="sea__cov">
            口径：后端 previousMonths（上一保障季按月汇总）；无接入记录的月份显示无数据，不补 0；本期月度接口未返回，不伪造对比。
          </p>
          <div class="sea__chart sea__chart--monthly"><EChart :option="monthlyOption" /></div>
          <p class="sea__notes">
            <span class="sea__notecell">
              观测月 {{ previousMonths.filter((m) => m.count !== null).length }} / {{ previousMonths.length }}；无数据月
              {{ previousMonths.filter((m) => m.count === null).length }} 个（不补 0）
            </span>
          </p>
        </section>

        <!-- ③ Top6 网格 + 上一保障季同期 -->
        <section class="sea__block sea__block--top">
          <header class="sea__blockhead">
            <b>③ 本期 Top6 行政网格与上一保障季同期</b>
            <span class="sea__std">
              本期 {{ data.seasons?.[0]?.from ?? '—' }} ~ {{ data.seasons?.[0]?.observedTo ?? data.seasons?.[0]?.to ?? '—' }} ·
              按本期件数降序（并列按网格编码升序）
            </span>
          </header>
          <div class="sea__topwrap">
            <div class="sea__tablewrap">
              <table class="sea__table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>行政网格</th>
                    <th>本期</th>
                    <th>上一保障季</th>
                    <th>同比</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in topRows" :key="r.code">
                    <td class="sea__rank" :class="{ 'is-top3': i < 3 }">{{ i + 1 }}</td>
                    <td class="sea__grid"><b>{{ r.name ?? r.code }}</b><small>{{ r.code }}</small></td>
                    <td class="sea__num sea__num--cur">{{ r.count }} 条</td>
                    <td class="sea__num">
                      <template v-if="r.previousCount !== null">{{ r.previousCount }} 条</template>
                      <span v-else class="sea__na">资料不足</span>
                    </td>
                    <td class="sea__num" :class="deltaOf(r).tone">{{ deltaOf(r).text }}</td>
                  </tr>
                  <tr v-if="!topRows.length">
                    <td colspan="5" class="sea__emptyrow">
                      {{ currentSeasonOutsideRule ? '规则有效期未覆盖所选保障季' : '本期保障季暂无满足条件的行政网格（已接入记录不足）' }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="!currentSeasonOutsideRule" class="sea__topnote">
                共 {{ topRows.length }} 个网格（不足 6 个按实际数量展示）；上一保障季无记录显示「资料不足」，不据此计算降幅。
                <template v-if="data.unlocatedCount != null">缺少下级网格关联 {{ data.unlocatedCount }} 件。排名采用已登记的下级编码，正式社区网格目录待核验。</template>
              </p>
            </div>
            <div class="sea__chart sea__chart--top"><EChart :option="topOption" /></div>
          </div>
        </section>
      </div>

    <!-- ④ 本季诉求明细（按需拉取，默认收起） -->
    <section class="sea__block sea__block--detail">
      <header class="sea__blockhead">
        <b>④ 本季诉求明细</b>
        <span v-if="!currentSeasonOutsideRule" class="sea__std">
          <template v-if="detailOpen && !detailLoading && detailTotal !== null">共 {{ detailTotal }} 条 · 按录入时间倒序</template>
          <template v-else-if="!detailOpen">默认收起，不占用首屏加载</template>
        </span>
        <button v-if="!currentSeasonOutsideRule" type="button" class="sea__toggle" :aria-expanded="detailOpen" @click="toggleDetails">
          {{ detailOpen ? '收起' : '查看明细' }}
        </button>
      </header>
      <p class="sea__cov">
        口径：{{ sceneMeta.category }}；明细按需加载 —— 主接口为走覆盖索引只取统计列，
        案号/标题由本区块单独分页获取，不拖慢面板首屏。
      </p>

      <div v-if="currentSeasonOutsideRule" class="sea__detailidle">规则有效期未覆盖所选保障季。</div>
      <div v-else-if="!detailOpen" class="sea__detailidle">
        点击「查看明细」加载本季诉求清单（每页 {{ DETAIL_SIZE }} 条）。
      </div>
      <div v-else-if="detailLoading" class="sea__detailidle">加载中…</div>
      <div v-else-if="detailError" class="acc-empty acc-empty--error">
        <b>明细加载失败</b>
        <span>{{ detailError }}</span>
        <button type="button" @click="loadDetails(detailPage)">重试</button>
      </div>
      <div v-else-if="detailReason" class="sea__detailidle">{{ detailReason }}</div>
      <div v-else-if="!detailRows.length" class="sea__detailidle">当前页暂无明细记录。</div>
      <template v-else>
        <div class="sea__tablewrap sea__tablewrap--detail">
          <table class="sea__table sea__table--detail">
            <thead>
              <tr>
                <th>#</th>
                <th>案件号</th>
                <th>类型</th>
                <th>标题</th>
                <th>网格</th>
                <th>企业</th>
                <th>录入时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in detailRows" :key="r.complaintId">
                <td class="sea__rank">{{ (detailPage - 1) * DETAIL_SIZE + i + 1 }}</td>
                <td class="sea__mono" :title="r.complaintId">{{ r.complaintNo || r.complaintId }}</td>
                <td class="sea__mono">{{ r.categoryCode }}</td>
                <td class="sea__title" :title="r.title">{{ r.title }}</td>
                <td class="sea__mono">{{ r.adminGridCode ?? '未定位' }}</td>
                <td class="sea__mono">{{ r.enterpriseName ?? '—' }}</td>
                <td class="sea__mono">{{ fmtDetailTime(r.reportedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="sea__pager">
          <button type="button" :disabled="detailPage <= 1" @click="goDetailPage(detailPage - 1)">上一页</button>
          <span>第 {{ detailPage }} / {{ detailPages }} 页 · 共 {{ detailTotal }} 条</span>
          <button type="button" :disabled="detailPage >= detailPages" @click="goDetailPage(detailPage + 1)">下一页</button>
        </div>
      </template>
    </section>

      <p class="sea__foot">
        资料截止 {{ data.dataCutoffAt ?? '—' }} · 时间依据 {{ data.timeBasis ?? '宜接就办来源录入时间' }} · 快照
        {{ (data.snapshotId ?? '—').slice(0, 16) }} · {{ data.coverageNote ?? '' }}
      </p>
    </template>

    <div v-else class="acc-empty sea__state">
      <b>暂无研判数据</b>
      <span>请选择保障季后重试；缺失数据不补 0。</span>
    </div>
  </div>
</template>

<style scoped>
/* ---- ④ 明细区块 ---- */
.sea__block--detail {
  flex: none;
  max-height: 42vh;
  overflow: hidden;
}
.sea__toggle {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 3px;
  border: 1px solid rgba(134, 251, 231, 0.5);
  background: rgba(134, 251, 231, 0.12);
  color: #86fbe7;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.sea__toggle:hover {
  background: rgba(134, 251, 231, 0.22);
  color: #eafffa;
}
.sea__detailidle {
  padding: 10px 0;
  color: #7ea8a0;
  font-size: 11px;
  line-height: 1.6;
}
.sea__block--detail .sea__tablewrap--detail {
  max-height: 30vh;
  overflow: auto;
}
.sea__table--detail {
  font-size: 10.5px;
}
.sea__table--detail th,
.sea__table--detail td {
  padding: 2px 6px;
  white-space: nowrap;
}
/* 标题列限宽 + 省略号，避免长文本把表格撑爆 */
.sea__table--detail .sea__title {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d6f6ef;
}
.sea__mono {
  font-variant-numeric: tabular-nums;
  color: #9fe3d3;
}
.sea__pager {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 6px 0 2px;
  color: #8ab9b0;
  font-size: 11px;
}
.sea__pager button {
  padding: 2px 9px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.4);
  background: transparent;
  color: #9fe3d3;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sea__pager button:disabled {
  opacity: 0.35;
  cursor: default;
}
.sea__pager button:hover:not(:disabled) {
  background: rgba(134, 251, 231, 0.16);
}
.sea {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}
.sea__top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sea__scenes {
  display: flex;
  gap: 5px;
}
.sea__scene {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 4px 12px;
  font-family: inherit;
  text-align: left;
  color: #a8d8ce;
  background: linear-gradient(180deg, rgba(12, 54, 50, 0.92), rgba(6, 30, 29, 0.92));
  border: 1px solid #347d72;
  cursor: pointer;
}
.sea__scene b {
  font-size: 12.5px;
  font-weight: 400;
  letter-spacing: 1px;
}
.sea__scene span {
  font-size: 9.5px;
  color: #7fa9a0;
}
.sea__scene:hover {
  border-color: #86fbe7;
  color: #eafffa;
}
.sea__scene.is-active {
  color: #041d1e;
  background: linear-gradient(180deg, #86fbe7, #35b9a2);
  border-color: #86fbe7;
  box-shadow: 0 0 12px rgba(134, 251, 231, 0.35);
}
.sea__scene.is-active span {
  color: #0b4a42;
}
.sea__year {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #b8ded6;
}
.sea__year select {
  padding: 3px 6px;
  font-family: inherit;
  font-size: 11.5px;
  color: #d5f8ef;
  background: #0c3632;
  border: 1px solid #2b7064;
}
.sea__defaultnote {
  font-size: 9.5px;
  color: #7fa9a0;
}
.sea__rule {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  background: rgba(6, 38, 36, 0.72);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.sea__rule b {
  font-size: 11px;
  font-weight: 400;
  color: #86fbe7;
  white-space: nowrap;
}
.sea__rule span {
  font-size: 9.5px;
  line-height: 1.45;
  color: #9bc9c5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sea__blocks {
  flex: 1;
  min-height: min(54vh, 540px);
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr);
  gap: 6px;
}
.sea__block {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px 4px;
  background: linear-gradient(180deg, rgba(7, 44, 40, 0.82), rgba(3, 24, 25, 0.78));
  border: 1px solid rgba(52, 139, 124, 0.42);
  border-left: 2px solid rgba(134, 251, 231, 0.55);
}
.sea__blockhead {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.sea__blockhead b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #d9fff7;
  white-space: nowrap;
}
.sea__std {
  margin-left: auto;
  font-size: 9.5px;
  color: #7fa9a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sea__cov {
  flex: none;
  margin: 0;
  font-size: 9.5px;
  line-height: 1.4;
  color: #86b8ae;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sea__chart {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
}
.sea__notes {
  flex: none;
  display: flex;
  gap: 6px;
  margin: 0;
  overflow: hidden;
}
.sea__notecell {
  flex: 1;
  min-width: 0;
  font-size: 9px;
  color: #86b8ae;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sea__notecell.is-na {
  color: #c9a35a;
}
.sea__topwrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 1fr);
  gap: 8px;
}
.sea__tablewrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(52, 139, 124, 0.3);
  background: rgba(4, 28, 27, 0.5);
  padding: 4px 6px;
}
.sea__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
  color: #d6f6ef;
  table-layout: fixed;
}
.sea__table th {
  padding: 3px 5px;
  font-weight: 400;
  font-size: 9.5px;
  text-align: left;
  color: #7fa9a0;
  border-bottom: 1px solid rgba(52, 139, 124, 0.5);
}
.sea__table td {
  padding: 3px 5px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.18);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sea__rank {
  width: 22px;
  text-align: center !important;
  color: #041d1e;
  font-weight: 700;
}
.sea__rank.is-top3 {
  color: #ffd67c;
}
.sea__grid b {
  display: block;
  font-size: 10.5px;
  font-weight: 400;
  color: #eafffa;
}
.sea__grid small {
  display: block;
  font-size: 8.5px;
  color: #7fa9a0;
}
.sea__num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.sea__num--cur {
  color: #86fbe7;
  font-weight: 600;
}
.sea__num.is-up {
  color: #ff9f9f;
}
.sea__num.is-down {
  color: #7cffd8;
}
.sea__num.is-na {
  color: #c9a35a;
  font-size: 9px;
}
.sea__na {
  color: #c9a35a;
  font-size: 9px;
}
.sea__emptyrow {
  padding: 14px 0 !important;
  text-align: center;
  color: #7fa9a0;
  white-space: normal !important;
}
.sea__topnote {
  margin: 4px 0 0;
  font-size: 8.5px;
  line-height: 1.4;
  color: #7fa9a0;
}
.sea__foot {
  flex: none;
  margin: 0;
  font-size: 9px;
  color: #6f9a93;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sea__state {
  flex: 1;
}
.sea__trace {
  font-size: 9.5px;
  color: #7fa9a0;
}
.sea__skeleton {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sea__skblock {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border: 1px solid rgba(52, 139, 124, 0.3);
}
.sea__sktitle,
.sea__skchart {
  display: block;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.1), rgba(84, 213, 188, 0.3), rgba(84, 213, 188, 0.1));
  animation: sea-pulse 1.15s ease-in-out infinite alternate;
}
.sea__sktitle {
  height: 12px;
  width: 42%;
}
.sea__skchart {
  flex: 1;
  min-height: 60px;
}
@keyframes sea-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
</style>
