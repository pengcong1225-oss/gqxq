<script setup lang="ts">
/**
 * 验收大屏 · 数据预警（标书 1.2.10）
 *
 * 四场景：冬季保供 / 夏季保畅 / 计划性停水停气 / 燃气三件套安装。
 * - 顶部「今日评估」调 POST /business-alerts/evaluate（真实主账核算），展示每条规则的
 *   状态：已触发 / 低于阈值 / 数据不足（含后端 reason，不把「资料不足」显示成正常）；
 * - 下方展示 GET /business-alerts 已保存预警（场景 / 规则名 / 阈值 / 窗口 / 触发量 / 状态）；
 * - 燃气三件套：定义与分类映射待业务确认，系统拒绝未确认时落库 → UI 只显示「待业务确认」。
 */
import { computed, onMounted, ref } from 'vue';
import { hashQuery } from '@/stats/useDesignScale';
import {
  evaluateBusinessAlerts,
  fetchBusinessAlertHistory,
  fetchBusinessAlerts,
  FeatureApiError,
  type BusinessAlertHistoryRow,
  type BusinessAlertRow,
  type EvaluateResult,
} from '@/stats/businessFeatures';
import { ALERT_SCENES, GAS_THREE_PIECE_NOTE, presetOf, SCENE_LABELS, type AlertScene } from './presetRules';

const qp = hashQuery();
/** 演示直达：?drawer=warnings&eval=1 = 打开即执行今日评估 */
const autoEval = qp.get('eval') === '1';

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const day = ref(todayStr());
const evaluating = ref(false);
const evalError = ref('');
const evalResult = ref<EvaluateResult | null>(null);
const evalAt = ref('');

const rows = ref<BusinessAlertRow[]>([]);
const rowsLoading = ref(false);
const rowsError = ref('');

/* ---------------------------------------------- 预警详情（标书 1.2.10 详细信息） */
/** 当前打开的预警（null=未打开）；详情数据全部来自后端，不拼演示数据 */
const detail = ref<BusinessAlertRow | null>(null);
const detailHistory = ref<BusinessAlertHistoryRow[]>([]);
const detailLoading = ref(false);
const detailError = ref('');
/** 证据诉求过多时只展示前 N 条，其余如实标注数量 */
const DETAIL_IDS_LIMIT = 60;

function openDetail(row: BusinessAlertRow) {
  detail.value = row;
  detailHistory.value = [];
  detailError.value = '';
  detailLoading.value = true;
  fetchBusinessAlertHistory(row.alertId)
    .then((list) => {
      detailHistory.value = list;
    })
    .catch((e) => {
      detailError.value =
        e instanceof FeatureApiError
          ? `${e.message}（code=${e.code}）`
          : e instanceof Error
            ? e.message
            : String(e);
    })
    .finally(() => {
      detailLoading.value = false;
    });
}

function closeDetail() {
  detail.value = null;
  detailHistory.value = [];
  detailError.value = '';
  detailLoading.value = false;
}

const actionLabel = (a: string): string =>
  ({ acknowledge: '确认', resolve: '处理完成' })[a] ?? a;


const sceneOfRule = (ruleId: string): AlertScene | null => presetOf(ruleId)?.scene ?? null;

const statusLabel = (s: string): string =>
  ({ triggered: '已触发', below_threshold: '低于阈值', insufficient: '数据不足' })[s] ?? s;

const statusTone = (s: string): string =>
  s === 'triggered' ? 'is-triggered' : s === 'below_threshold' ? 'is-below' : 'is-insufficient';

const stateLabel = (s: string): string =>
  ({ open: '待确认', acknowledged: '已确认', resolved: '已处理' })[s] ?? s;

const sceneLabel = (s: string, fallback?: string): string => SCENE_LABELS[s] ?? fallback ?? s;

/**
 * 标书 1.2.10：诉求量预警为全市口径；引擎改造后可按区县/企业/网格细分。
 * 旧数据无 scope 字段 → 视为全市；三码为空时也只显示「全市」，不显示 — 或 null。
 */
const SCOPE_LABELS: Record<string, string> = { city: '全市', district: '区县', enterprise: '企业', grid: '网格' };
const scopeOf = (s?: string | null): 'city' | 'district' | 'enterprise' | 'grid' =>
  s === 'district' || s === 'enterprise' || s === 'grid' ? s : 'city';
function scopeText(row: { scope?: string | null; districtCode?: string | null; enterpriseCode?: string | null; adminGridCode?: string | null }): string {
  const scope = scopeOf(row.scope);
  if (scope === 'city') return '全市';
  const value = scope === 'district' ? row.districtCode : scope === 'enterprise' ? row.enterpriseCode : row.adminGridCode;
  return SCOPE_LABELS[scope] + ' ' + (value || '（未标注）');
}
/** 覆盖度：可判定/缺字段；旧响应无该字段时返回 null（不臆造 0） */
function coverageOf(c: { eligibleCount?: number | null; incompleteCount?: number | null }) {
  const eligible = typeof c.eligibleCount === 'number' ? c.eligibleCount : null;
  const incomplete = typeof c.incompleteCount === 'number' ? c.incompleteCount : null;
  if (eligible === null && incomplete === null) return null;
  const total = (eligible ?? 0) + (incomplete ?? 0);
  return { eligible, incomplete, total, rate: total > 0 ? (eligible ?? 0) / total : null };
}

const unconfigured = computed(() => new Set(evalResult.value?.unconfiguredScenes ?? []));

const evalCards = computed(() => evalResult.value?.statuses ?? []);

async function loadRows() {
  rowsLoading.value = true;
  rowsError.value = '';
  try {
    rows.value = await fetchBusinessAlerts();
  } catch (e) {
    rowsError.value = e instanceof FeatureApiError ? `${e.message}（code=${e.code}）` : e instanceof Error ? e.message : String(e);
  } finally {
    rowsLoading.value = false;
  }
}

async function doEvaluate() {
  if (evaluating.value) return;
  evaluating.value = true;
  evalError.value = '';
  try {
    evalResult.value = await evaluateBusinessAlerts(day.value);
    const d = new Date();
    evalAt.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    // 核算结果先落屏（按钮立即恢复），列表单独刷新，避免长时间停留在「评估中」
    void loadRows();
  } catch (e) {
    evalError.value = e instanceof FeatureApiError ? `${e.message}（code=${e.code}）` : e instanceof Error ? e.message : String(e);
  } finally {
    evaluating.value = false;
  }
}

onMounted(async () => {
  await loadRows();
  // 让主屏 3 份 bootstrap 先落地，再触发核算（避免首屏并发把评估请求挤掉）
  if (autoEval) window.setTimeout(() => void doEvaluate(), 1200);
});
</script>

<template>
  <div class="alt">
    <!-- 顶部：核算日 + 今日评估 + 场景说明 -->
    <div class="alt__bar">
      <label class="alt__day">
        核算日
        <input v-model="day" type="date" :max="todayStr()" />
      </label>
      <button type="button" class="alt__evalbtn" :disabled="evaluating" @click="doEvaluate">
        {{ evaluating ? '评估中…' : '今日评估' }}
      </button>
      <span class="alt__hint">按已发布规则核算近窗口；缺企业/分类/网格等证据时判「数据不足」，不显示「正常」</span>
      <span v-if="evalAt" class="alt__evalat">最近评估 {{ evalAt }}</span>
    </div>

    <!-- 四场景 -->
    <div class="alt__scenes">
      <div
        v-for="s in ALERT_SCENES"
        :key="s.scene"
        class="alt__scene"
        :class="{ 'is-unconfigured': s.scene === 'gas_three_piece' || unconfigured.has(s.scene) }"
      >
        <b>{{ s.label }}</b>
        <span>{{ unconfigured.has(s.scene) ? '未发布规则 / 待业务确认' : s.note }}</span>
      </div>
    </div>

    <p class="alt__gap">{{ GAS_THREE_PIECE_NOTE }}</p>

    <div v-if="evalError" class="acc-empty acc-empty--error alt__state">
      <b>今日评估失败</b>
      <span>{{ evalError }}</span>
      <button type="button" @click="doEvaluate">重试</button>
    </div>

    <!-- 本次核算结果 -->
    <section v-if="evalResult" class="alt__block">
      <header class="alt__blockhead">
        <b>今日评估结果</b>
        <span>新增预警 {{ evalResult.created }} 条 · 规则 {{ evalCards.length }} 条</span>
        <span class="alt__muted">判定口径：窗口内命中分类且证据齐全才判正常；资料不完整一律「数据不足」</span>
      </header>
      <div v-if="evalCards.length" class="alt__cards">
        <article v-for="c in evalCards" :key="c.ruleId" class="alt__card" :class="statusTone(c.status)">
          <header>
            <span class="alt__sceneTag">{{ sceneLabel(sceneOfRule(c.ruleId) ?? '', '—') }}</span>
            <b>{{ c.name }}</b>
            <span class="alt__status" :class="statusTone(c.status)">{{ statusLabel(c.status) }}</span>
          </header>
          <p class="alt__ruleline">
            <template v-if="presetOf(c.ruleId)">
              {{ presetOf(c.ruleId)?.categoryLabel }} · 阈值 {{ presetOf(c.ruleId)?.threshold }} 件 ·
              {{ presetOf(c.ruleId)?.windowText }}
            </template>
            <template v-else>规则 {{ c.ruleId }}</template>
            <span class="alt__scopeTag">{{ scopeText({ scope: c.scope }) }}</span>
          </p>
          <p class="alt__count">
            本窗口观测
            <b>{{ c.status === 'insufficient' ? '未计算' : c.count ?? '—' }}</b>
            {{ c.status === 'insufficient' ? '' : '条' }}
            <span v-if="c.status === 'below_threshold'" class="alt__sub">未达阈值</span>
            <span v-else-if="c.status === 'insufficient'" class="alt__sub">证据不完整，不能判定正常</span>
            <span v-else-if="c.status === 'triggered'" class="alt__sub">已触发预警并留存证据</span>
          </p>
          <p v-if="coverageOf(c)" class="alt__coverage" :class="{ 'is-low': (coverageOf(c)?.rate ?? 1) < 0.6 }">
            可判定 <b>{{ coverageOf(c)?.eligible ?? 0 }}</b> 件 · 缺字段 <b>{{ coverageOf(c)?.incomplete ?? 0 }}</b> 件
            <template v-if="coverageOf(c)?.rate !== null">（覆盖 {{ ((coverageOf(c)?.rate ?? 0) * 100).toFixed(0) }}%）</template>
            <span v-if="(coverageOf(c)?.rate ?? 1) < 0.6">覆盖不足，结论仅供参照</span>
          </p>
          <p v-if="c.reason" class="alt__reason">{{ c.reason }}</p>
          <p v-else-if="presetOf(c.ruleId)?.thresholdBasis" class="alt__basis">阈值推导：{{ presetOf(c.ruleId)?.thresholdBasis }}</p>
        </article>
      </div>
      <div v-else class="acc-empty alt__state">
        <b>无已发布的预警规则</b>
        <span>规则未发布或已停用时，不参与核算；请在管理端「真实主账预警 → 配置预警规则」发布后再评估。</span>
      </div>
    </section>

    <!-- 已保存预警 -->
    <section class="alt__block alt__block--saved">
      <header class="alt__blockhead">
        <b>已保存预警（{{ rows.length }}）</b>
        <span>重复计算不重复插入；处理记录与管理端一致</span>
        <button type="button" class="alt__refresh" :disabled="rowsLoading" @click="loadRows">
          {{ rowsLoading ? '刷新中…' : '刷新' }}
        </button>
      </header>

      <div v-if="rowsError" class="acc-empty acc-empty--error alt__state">
        <b>预警列表加载失败</b>
        <span>{{ rowsError }}</span>
        <button type="button" @click="loadRows">重试</button>
      </div>
      <div v-else-if="rowsLoading && !rows.length" class="alt__skeleton" aria-busy="true">
        <i v-for="n in 3" :key="n" :style="{ width: `${46 + ((n * 16) % 40)}%` }"></i>
      </div>
      <div v-else-if="!rows.length" class="acc-empty alt__state">
        <b>尚无以保存预警</b>
        <span>当前没有达到阈值且证据齐全的预警；点击「今日评估」按已发布规则核算一次。资料不足不会写入预警。</span>
      </div>
      <div v-else class="alt__savedlist">
        <article
          v-for="r in rows"
          :key="r.alertId"
          class="alt__saved is-clickable"
          title="点击查看预警详情：规则 / 阈值 / 窗口 / 证据诉求 / 处理记录"
          @click="openDetail(r)"
        >
          <header>
            <span class="alt__sceneTag">{{ sceneLabel(r.scene, r.ruleName) }}</span>
            <b>{{ r.ruleName }}</b>
            <span class="alt__status" :class="r.state === 'resolved' ? 'is-triggered' : 'is-below'">{{ stateLabel(r.state) }}</span>
            <button type="button" class="alt__detailbtn" @click.stop="openDetail(r)">详情 ›</button>
          </header>
          <p class="alt__ruleline">
            {{ scopeText(r) }} · 统计窗口 {{ r.from }} ~ {{ r.to }}
          </p>
          <p class="alt__count">
            触发量 <b>{{ r.quantity }}</b> / 阈值 <b>{{ r.threshold }}</b> 件
            <span class="alt__sub">命中诉求证据 {{ r.complaintIds === null ? '（当前账号无诉求明细权限）' : r.complaintIds.length + ' 条' }}</span>
          </p>
          <p class="alt__basis">规则版本 v{{ r.ruleVersion }} · 触发时间 {{ r.createdAt }}</p>
        </article>
      </div>
    </section>

    <!-- 预警详情弹窗（标书 1.2.10「预警信息可查看详细信息」）：只展示后端真实字段，不伪造 -->
    <div v-if="detail" class="alt__dmask" @click="closeDetail"></div>
    <aside v-if="detail" class="alt__dpanel" role="dialog" aria-modal="true" aria-label="预警详情">
      <header class="alt__dhead">
        <b>预警详情</b>
        <span class="alt__sceneTag">{{ sceneLabel(detail.scene, detail.ruleName) }}</span>
        <span class="alt__dtitle">{{ detail.ruleName }}</span>
        <span class="alt__status" :class="detail.state === 'resolved' ? 'is-triggered' : 'is-below'">{{ stateLabel(detail.state) }}</span>
        <button type="button" class="alt__dclose" @click="closeDetail">关闭 ×</button>
      </header>
      <div class="alt__dbody">
        <section class="alt__dblock">
          <h3>规则 / 阈值 / 窗口</h3>
          <p><span class="alt__dk">预警 ID</span>{{ detail.alertId }}</p>
          <p><span class="alt__dk">规则</span>{{ detail.ruleName }}（{{ detail.ruleId }} · v{{ detail.ruleVersion }}）</p>
          <p><span class="alt__dk">统计窗口</span>{{ detail.from }} ~ {{ detail.to }}</p>
          <p><span class="alt__dk">触发量 / 阈值</span>{{ detail.quantity }} 件 / ≥ {{ detail.threshold }} 件</p>
          <p><span class="alt__dk">统计范围</span>{{ scopeText(detail) }}</p>
          <p v-if="scopeOf(detail.scope) !== 'city'" class="alt__dgroup">
            <span class="alt__dk">归组明细</span>区县 {{ detail.districtCode || '—' }} · 企业
            {{ detail.enterpriseCode || '—' }} · 网格 {{ detail.adminGridCode || '—' }}
          </p>
          <p><span class="alt__dk">触发时间</span>{{ detail.createdAt }}</p>
          <p><span class="alt__dk">资料截止</span>{{ detail.dataCutoffAt }}</p>
          <p v-if="detail.definitionBasis"><span class="alt__dk">规则口径</span>{{ detail.definitionBasis }}</p>
        </section>

        <section class="alt__dblock">
          <h3>证据诉求</h3>
          <template v-if="detail.complaintIds === null">
            <p class="alt__dna">当前账号无诉求明细权限：后端未返回 complaintIds，只能看预警汇总，不展示具体诉求编号。</p>
          </template>
          <template v-else>
            <p>共 {{ detail.complaintIds.length }} 条命中诉求</p>
            <div class="alt__dids">
              <span v-for="id in detail.complaintIds.slice(0, DETAIL_IDS_LIMIT)" :key="id">{{ id }}</span>
              <span v-if="detail.complaintIds.length > DETAIL_IDS_LIMIT" class="alt__dmore">
                其余 {{ detail.complaintIds.length - DETAIL_IDS_LIMIT }} 条未展开
              </span>
            </div>
          </template>
        </section>

        <section class="alt__dblock">
          <h3>处理记录</h3>
          <div v-if="detailLoading" class="alt__dloading">加载处理记录…</div>
          <div v-else-if="detailError" class="alt__derr">
            <b>处理记录加载失败</b>
            <span>{{ detailError }}</span>
            <button type="button" @click="openDetail(detail)">重试</button>
          </div>
          <p v-else-if="!detailHistory.length" class="alt__dna">暂无处理记录（该预警尚未被确认 / 处理）。</p>
          <ul v-else class="alt__dlist">
            <li v-for="(h, i) in detailHistory" :key="`${i}-${h.createdAt}`">
              <b>{{ actionLabel(h.action) }}</b>
              <span>{{ h.notes }}</span>
              <em>{{ h.userId || '操作人未记录' }} · {{ h.createdAt || '时间未记录' }}</em>
            </li>
          </ul>
        </section>

        <p class="alt__dfoot">
          大屏为只读详情；确认 / 处理动作请在管理端「真实主账 → 数据预警」执行（同一 /business-alerts 接口）。
        </p>
      </div>
    </aside>

    <p class="alt__foot">
      口径：真实诉求总账（来源明确办结）· 场景与分类按已发布规则（版本=2）· 资料截止以预警证据的 dataCutoffAt 为准；
      三件套未确认定义前不落库、不参与核算。
    </p>
  </div>
</template>

<style scoped>
.alt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}
.alt__bar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(6, 38, 36, 0.72);
  border: 1px solid rgba(52, 139, 124, 0.42);
}
.alt__day {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #b8ded6;
}
.alt__day input {
  padding: 3px 6px;
  font-family: inherit;
  font-size: 11.5px;
  color: #d5f8ef;
  background: #0c3632;
  border: 1px solid #2b7064;
  color-scheme: dark;
}
.alt__evalbtn {
  padding: 5px 14px;
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 1px;
  color: #041d1e;
  background: linear-gradient(180deg, #86fbe7, #35b9a2);
  border: 1px solid #86fbe7;
  cursor: pointer;
}
.alt__evalbtn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.alt__hint {
  flex: 1;
  min-width: 200px;
  font-size: 9.5px;
  color: #7fa9a0;
}
.alt__evalat {
  font-size: 10px;
  color: #86fbe7;
  white-space: nowrap;
}
.alt__scenes {
  flex: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.alt__scene {
  padding: 6px 9px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  border-left: 3px solid rgba(134, 251, 231, 0.65);
  background: rgba(7, 44, 40, 0.78);
}
.alt__scene b {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: #eafffa;
}
.alt__scene span {
  display: block;
  margin-top: 2px;
  font-size: 9.5px;
  line-height: 1.4;
  color: #7fa9a0;
}
.alt__scene.is-unconfigured {
  border-left-color: #ffd67c;
  background: rgba(61, 48, 12, 0.3);
}
.alt__scene.is-unconfigured b {
  color: #ffd67c;
}
.alt__gap {
  flex: none;
  margin: 0;
  padding: 5px 8px;
  font-size: 9.5px;
  line-height: 1.45;
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.36);
  border: 1px dashed rgba(255, 214, 124, 0.4);
}
.alt__block {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.5);
}
.alt__block--saved {
  flex: 1;
  min-height: 0;
}
.alt__block--saved .alt__state {
  flex: 1;
}
.alt__blockhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.28);
}
.alt__blockhead b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #b9fff3;
  white-space: nowrap;
}
.alt__blockhead span {
  font-size: 9.5px;
  color: #7fa9a0;
}
.alt__muted {
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.alt__refresh {
  margin-left: auto;
  flex: none;
  padding: 2px 9px;
  font-family: inherit;
  font-size: 10.5px;
  color: #86fbe7;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.alt__cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.alt__card,
.alt__saved {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  background: rgba(9, 52, 47, 0.7);
  border: 1px solid rgba(52, 139, 124, 0.36);
  border-left: 3px solid rgba(134, 251, 231, 0.5);
}
.alt__card header,
.alt__saved header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.alt__card header b,
.alt__saved header b {
  font-size: 12px;
  font-weight: 400;
  color: #eafffa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.alt__sceneTag {
  flex: none;
  padding: 1px 6px;
  font-size: 9px;
  color: #041d1e;
  background: #54d5bc;
}
.alt__status {
  margin-left: auto;
  flex: none;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 700;
}
.alt__status.is-triggered {
  color: #2a0b0b;
  background: #ff8f8f;
}
.alt__status.is-below {
  color: #2a1f05;
  background: #ffd67c;
}
.alt__status.is-insufficient {
  color: #d8e6f2;
  background: rgba(90, 130, 160, 0.55);
  border: 1px solid rgba(169, 203, 226, 0.45);
  font-weight: 400;
}
.alt__ruleline {
  margin: 0;
  font-size: 10px;
  color: #9bc9c5;
}
.alt__count {
  margin: 0;
  font-size: 10.5px;
  color: #d6f6ef;
}
.alt__count b {
  font-family: 'Bahnschrift', 'Microsoft YaHei', sans-serif;
  font-size: 17px;
  color: #86fbe7;
}
.alt__sub {
  margin-left: 6px;
  font-size: 9.5px;
  color: #7fa9a0;
}
.alt__reason {
  margin: 2px 0 0;
  padding: 4px 6px;
  font-size: 9.5px;
  line-height: 1.45;
  color: #ffd8a8;
  background: rgba(97, 68, 12, 0.28);
  border-left: 2px solid rgba(255, 214, 124, 0.55);
}
.alt__basis {
  margin: 0;
  font-size: 9px;
  color: #6f9a93;
}
.alt__savedlist {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.alt__state {
  flex: none;
  min-height: 110px;
}
.alt__skeleton {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 6px 2px;
}
.alt__skeleton i {
  display: block;
  height: 16px;
  background: linear-gradient(90deg, rgba(84, 213, 188, 0.14), rgba(84, 213, 188, 0.34), rgba(84, 213, 188, 0.14));
  animation: alt-pulse 1.1s ease-in-out infinite alternate;
}
@keyframes alt-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
.alt__foot {
  flex: none;
  margin: 0;
  font-size: 9px;
  color: #6f9a93;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* ---------------- 预警详情（只读弹窗） ---------------- */
.alt__saved.is-clickable {
  cursor: pointer;
}
.alt__saved.is-clickable:hover {
  border-left-color: #86fbe7;
  background: rgba(13, 66, 59, 0.82);
}
.alt__detailbtn {
  flex: none;
  padding: 1px 7px;
  font-family: inherit;
  font-size: 10px;
  color: #86fbe7;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.alt__detailbtn:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
.alt__dmask {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: rgba(1, 12, 11, 0.72);
  backdrop-filter: blur(1px);
}
.alt__dpanel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 6;
  width: min(760px, 92%);
  max-height: 88%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(160deg, rgba(6, 40, 37, 0.99), rgba(3, 22, 23, 0.99));
  border: 1px solid #59a998;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6), inset 0 0 36px rgba(11, 73, 64, 0.28);
}
.alt__dhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.45);
  background: linear-gradient(90deg, rgba(24, 92, 84, 0.5), transparent);
}
.alt__dhead b {
  flex: none;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-size: 16px;
  font-weight: 400;
  letter-spacing: 1px;
  color: #b9fff3;
}
.alt__dtitle {
  min-width: 0;
  font-size: 12px;
  color: #eafffa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.alt__dhead .alt__status {
  margin-left: auto;
}
.alt__dclose {
  flex: none;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 11px;
  color: #d5f8ef;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.alt__dclose:hover {
  background: #1b7466;
  border-color: #86fbe7;
  color: #fff;
}
.alt__dbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}
.alt__dblock {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  background: rgba(4, 28, 27, 0.62);
  border: 1px solid rgba(52, 139, 124, 0.36);
}
.alt__dblock h3 {
  margin: 0 0 3px;
  padding-bottom: 3px;
  font-size: 11.5px;
  font-weight: 400;
  color: #86fbe7;
  border-bottom: 1px dashed rgba(52, 139, 124, 0.35);
}
.alt__dblock p {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: #d6f6ef;
  word-break: break-all;
}
.alt__dk {
  display: inline-block;
  min-width: 62px;
  margin-right: 6px;
  color: #7fa9a0;
  font-size: 10px;
}
.alt__dna {
  color: #ffd67c !important;
  background: rgba(61, 48, 12, 0.3);
  padding: 4px 6px;
  border-left: 2px solid rgba(255, 214, 124, 0.55);
}
.alt__dids {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 132px;
  overflow: auto;
}
.alt__dids span {
  padding: 1px 5px;
  font-size: 9.5px;
  color: #d6f6ef;
  background: rgba(18, 74, 66, 0.65);
  border: 1px solid rgba(52, 139, 124, 0.35);
}
.alt__dmore {
  color: #ffd67c !important;
  background: transparent !important;
  border-style: dashed !important;
}
.alt__dloading {
  font-size: 10.5px;
  color: #8ab9b0;
}
.alt__derr {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10.5px;
  color: #ffd8a8;
}
.alt__derr b {
  color: #ff8f8f;
  font-weight: 400;
}
.alt__derr button {
  padding: 1px 8px;
  font-family: inherit;
  font-size: 10px;
  color: #86fbe7;
  background: #0c3632;
  border: 1px solid #347d72;
  cursor: pointer;
}
.alt__dlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.alt__dlist li {
  display: grid;
  grid-template-columns: 62px 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 10.5px;
  background: rgba(9, 52, 47, 0.62);
  border-left: 2px solid rgba(134, 251, 231, 0.5);
}
.alt__dlist b {
  color: #86fbe7;
  font-weight: 400;
}
.alt__dlist span {
  color: #d6f6ef;
  word-break: break-all;
}
.alt__dlist em {
  font-style: normal;
  font-size: 9.5px;
  color: #7fa9a0;
  white-space: nowrap;
}
.alt__dfoot {
  flex: none;
  margin: 0;
  font-size: 9.5px;
  line-height: 1.45;
  color: #8ab9b0;
}

.alt__scopeTag {
  margin-left: 6px;
  padding: 0 5px;
  font-size: 9.5px;
  color: #041d1e;
  background: rgba(134, 251, 231, 0.75);
}
.alt__coverage {
  margin: 2px 0 0;
  font-size: 9.5px;
  color: #8ab9b0;
}
.alt__coverage b {
  color: #86fbe7;
  font-weight: 400;
}
.alt__coverage.is-low {
  color: #ffd67c;
}
.alt__coverage.is-low b {
  color: #ffd67c;
}
.alt__coverage.is-low span {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px dashed rgba(255, 214, 124, 0.5);
}
.alt__dgroup {
  color: #8ab9b0;
}
</style>