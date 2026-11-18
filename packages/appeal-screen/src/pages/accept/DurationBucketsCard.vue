<script setup lang="ts">
/**
 * 标书 1.2.3 · 诉求处理时长统计（24h / 48h / 72h / >72h）
 *
 * 口径（2026-11-17 核实）：
 *  - 办结时间只认 complaint.source_completed_at（回填自「宜接就办」导出批次的「实际完成时间」）；
 *  - source_synced_at 是同步管道固定延迟(+3h)，不能当处理时长；
 *  - 只有 2026-03~09 批次带办结时间（461 条），窗口不覆盖时四档不可计算 → 显示原因，不补 0。
 */
import { computed } from 'vue';
import type { DemandDynamicData, DurationBucketCount, PanelState, PeriodMeta } from '@/stats/types';

const props = defineProps<{
  dynamic: PanelState<DemandDynamicData>;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{ (e: 'retry'): void }>();

const data = computed(() => props.dynamic.data);
const stats = computed(() => data.value?.durationStats);
const loading = computed(() => props.dynamic.status === 'loading' || props.dynamic.status === 'idle');
const error = computed(() => (props.dynamic.status === 'error' ? props.dynamic.error : null));

const realValue = computed(() => stats.value?.value ?? null);
const buckets = computed(() => realValue.value?.buckets ?? []);
const maxCount = computed(() => Math.max(1, ...buckets.value.map((b) => b.count)));

/**
 * 每档满意度（标书 1.2.3「每档满意度/不满意百分比」）
 * 后端 evaluation：{ evaluatedCount, satisfiedCount, unsatisfiedCount, percent }，percent 为 0~1 小数。
 * 缺 evaluation / 分母 0 → 不展示百分比、绝不补 0；有 evaluation 但四档有效评价均为 0 时整列隐藏并注明原因。
 */
function evalView(b: DurationBucketCount) {
  const e = b.evaluation;
  const rated = typeof e?.evaluatedCount === 'number' ? e.evaluatedCount : null;
  let satPct: number | null = null;
  if (e && typeof e.percent === 'number' && Number.isFinite(e.percent)) {
    satPct = e.percent * 100;
  } else if (rated && rated > 0 && typeof e?.satisfiedCount === 'number') {
    satPct = (e.satisfiedCount / rated) * 100;
  }
  const unsatPct =
    rated && rated > 0 && typeof e?.unsatisfiedCount === 'number' ? (e.unsatisfiedCount / rated) * 100 : null;
  return { rated, satPct, unsatPct };
}

const rows = computed(() => buckets.value.map((b) => ({ bucket: b, ...evalView(b) })));

/** 后端是否返回了每档 evaluation（有办结时间时才可能有） */
const hasEvaluation = computed(() => rows.value.some((r) => r.bucket.evaluation != null));
/** 是否至少一档有真实百分比：只有这种时候才展示满意/不满意两列（不显示假 0、也不摆一排「—」） */
const showEvalColumn = computed(() => rows.value.some((r) => r.satPct !== null));

const evidenceText = computed(() => {
  const e = stats.value?.evidence;
  if (!e) return '';
  const parts: string[] = [];
  if (e.minHours != null && e.maxHours != null) parts.push(`min=${e.minHours}h / max=${e.maxHours}h`);
  if (e.identicalRatio != null) parts.push(`同值占比=${(e.identicalRatio * 100).toFixed(0)}%`);
  return parts.length ? `证据：${parts.join(' · ')}` : '';
});

const coverageText = computed(() => {
  const v = realValue.value;
  if (!v) return '';
  return `本窗口 ${v.total} 条中 ${v.covered} 条有办结时间（覆盖率 ${(v.coverage * 100).toFixed(1)}%）`;
});
</script>

<template>
  <section class="acc-card du">
    <header class="acc-card__head">
      <h2>诉求处理时长统计（24h/48h/72h/&gt;72h）</h2>
      <small v-if="realValue">实际完成时间 − 受理时间</small>
      <small v-else>received_at → 办结时间</small>
    </header>
    <div class="acc-card__body du__body">
      <div v-if="loading" class="acc-card__loading">加载中…</div>
      <div v-else-if="error" class="acc-empty acc-empty--error">
        <b>处理时长加载失败</b>
        <span>{{ error.message }}</span>
        <button type="button" @click="emit('retry')">重新加载</button>
      </div>

      <!-- 有真实办结时间：四档 + 覆盖率 + 超时 -->
      <template v-else-if="realValue">
        <div class="du__rows">
          <div v-if="showEvalColumn" class="du__row du__row--head">
            <span class="du__label">档位</span>
            <span></span>
            <span class="du__count">件数</span>
            <span class="du__pct">满意%</span>
            <span class="du__pct">不满意%</span>
          </div>
          <div v-for="r in rows" :key="r.bucket.label" class="du__row">
            <span class="du__label">{{ r.bucket.label }}</span>
            <span class="du__track">
              <i :style="{ width: (r.bucket.count / maxCount) * 100 + '%' }"></i>
            </span>
            <b class="du__count">{{ r.bucket.count }}</b>
            <span
              v-if="showEvalColumn"
              class="du__pct"
              :title="r.rated === null ? '该档无有效评价（不补 0）' : `该档有效评价 ${r.rated} 件`"
            >{{ r.satPct === null ? '—' : r.satPct.toFixed(1) + '%' }}</span>
            <span
              v-if="showEvalColumn"
              class="du__pct is-unsat"
              :title="r.rated === null ? '该档无有效评价（不补 0）' : `该档有效评价 ${r.rated} 件`"
            >{{ r.unsatPct === null ? '—' : r.unsatPct.toFixed(1) + '%' }}</span>
          </div>
        </div>
        <footer class="du__foot">
          <span>{{ coverageText }}</span>
          <span>
            超时 {{ realValue.overtime }} 件（{{ (realValue.overtimeRate * 100).toFixed(1) }}%，
            实际完成时间晚于规定完成时间）
          </span>
          <span v-if="showEvalColumn" class="du__evalnote">
            每档满意/不满意分母 = 该档有效评价件（满意含基本满意）；该档无评价时显示「—」，不补 0
          </span>
          <span v-else-if="hasEvaluation" class="du__evalnote">
            本窗口四档均无有效评价：后端已按 satisfaction_code 与办结时间交叉统计，但 evaluatedCount 全为 0
            （{{ realValue.covered }} 条有办结时间的诉求 satisfaction_code 为空/未评价）；不展示每档百分比、不补 0
          </span>
          <span v-else class="du__evalnote">本窗口未返回每档评价数据（evaluation 缺失），不展示满意/不满意百分比、不补 0</span>
        </footer>
      </template>

      <!-- 无办结时间：如实显示不可计算 -->
      <div v-else class="du__na">
        <b>数据不可计算：缺可核验办结时间</b>
        <span>{{ stats?.reason ?? '缺可核验的办结时间，不能作为处理时长' }}</span>
        <span v-if="evidenceText" class="du__evidence">{{ evidenceText }}</span>
        <span class="du__na-note">不展示 4 档件数，不补 0。</span>
        <span class="du__na-note">可查看区间：<b>2026-03-10 ~ 2026-09-17</b> / 461 条 source_completed_at（464 条含规定完成时间）；把开始/结束日期改到该区间即可看到真实四档（每档满意度需 satisfaction_code 回填后才有数字）。</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.du__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.du__rows {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 0 8px;
}
.du__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.du__row--head {
  height: 14px;
  gap: 6px;
  font-size: 9.5px;
  color: #7fa9a0;
}
.du__row--head .du__count,
.du__row--head .du__pct {
  font-size: 9.5px;
  color: #7fa9a0;
}
.du__pct {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 10.5px;
  color: #54d5bc;
  font-variant-numeric: tabular-nums;
}
.du__pct.is-unsat {
  width: 50px;
  color: #ec9161;
}
.du__evalnote {
  color: #8ab9b0 !important;
  font-size: 9.5px !important;
}
.du__label {
  flex: none;
  width: 56px;
  font-size: 11px;
  color: #a8d8ce;
  letter-spacing: 0.5px;
}
.du__track {
  flex: 1;
  height: 9px;
  border-radius: 5px;
  background: rgba(134, 251, 231, 0.1);
  overflow: hidden;
}
.du__track i {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, #2ce0c2, #86fbe7);
}
.du__count {
  flex: none;
  width: 42px;
  text-align: right;
  font-size: 12px;
  color: #86fbe7;
  font-variant-numeric: tabular-nums;
}
.du__foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px 2px;
  font-size: 10px;
  color: #8ab9b0;
  border-top: 1px solid rgba(134, 251, 231, 0.12);
}
.du__na {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
}
.du__na b {
  color: #ffd67c;
  font-size: 13px;
  letter-spacing: 0.5px;
}
.du__na span {
  color: #a8d8ce;
  font-size: 11px;
  line-height: 1.5;
}
.du__evidence {
  color: #86fbe7 !important;
  font-size: 10.5px !important;
}
.du__na-note {
  color: #8ab9b0 !important;
  font-size: 10.5px !important;
}
.acc-card__loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8ab9b0;
  font-size: 11px;
}
</style>
