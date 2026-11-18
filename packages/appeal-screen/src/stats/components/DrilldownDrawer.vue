<script setup lang="ts">
/**
 * 同条件诉求明细抽屉（下钻）：案件号 / 类型 / 小区 / 录入时间 / 状态 / 是否关联事件 / 评价。
 * 右侧滑出，覆盖在 1920×1080 设计稿内（随整屏一起缩放）；含分页样式与 loading/empty/error 三态。
 */
import { computed } from 'vue';
import type { DrillState } from '../useStatScreen';
import { type PeriodKey, type PeriodMeta } from '../types';

const props = defineProps<{
  drill: DrillState;
  periodMeta: PeriodMeta;
  pageSize: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'page', page: number): void;
  (e: 'retry'): void;
}>();

const query = computed(() => props.drill.query);
const data = computed(() => props.drill.data);
const total = computed(() => data.value?.total ?? 0);
const page = computed(() => data.value?.page ?? query.value?.page ?? 1);
const pages = computed(() => Math.max(1, Math.ceil(total.value / props.pageSize)));

const industryLabel = computed(() => {
  const i = query.value?.industry;
  return i === 'WATER' ? '供水' : i === 'GAS' ? '供气' : '全部行业';
});

const periodLabel = computed(
  () =>
    ({
      today: '今日',
      '7d': '近7天',
      '30d': '近30天',
      quarter: '本季',
      year: '本年',
    } as Record<PeriodKey, string>)[query.value?.period ?? '30d']
);

const conditionChips = computed(() => {
  const q = query.value;
  const chips: { label: string; value: string }[] = [];
  if (q?.typeId) chips.push({ label: '诉求类型', value: q.typeId });
  if (q?.districtCode) chips.push({ label: '区域编码', value: q.districtCode });
  if (q?.communityName) chips.push({ label: '小区', value: q.communityName });
  if (q?.enterpriseId) chips.push({ label: '企业', value: q.enterpriseId });
  if (q?.bucket) chips.push({ label: '处理时长档', value: q.bucket });
  if (q?.eventNo) chips.push({ label: '关联事件', value: q.eventNo });
  if (q?.month) chips.push({ label: '月份', value: `${q.month} 月` });
  if (!chips.length) chips.push({ label: '条件', value: '当前统计期间 + 行业' });
  return chips;
});

const pageList = computed(() => {
  const cur = page.value;
  const max = pages.value;
  const list: number[] = [];
  for (let p = Math.max(1, cur - 2); p <= Math.min(max, cur + 2); p++) list.push(p);
  return list;
});

const go = (p: number) => {
  if (p >= 1 && p <= pages.value && p !== page.value) emit('page', p);
};
</script>

<template>
  <div v-if="drill.open" class="drill" role="dialog" aria-modal="true" aria-label="同条件诉求明细">
    <div class="drill__mask" @click="emit('close')"></div>
    <aside class="drill__panel">
      <header class="drill__head">
        <div class="drill__title-wrap">
          <span class="drill__tag">下钻明细</span>
          <h2 class="drill__title">{{ query?.title ?? '同条件诉求明细' }}</h2>
          <span class="drill__source">来源：{{ query?.source ?? '—' }}</span>
        </div>
        <button type="button" class="drill__close" aria-label="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="drill__conditions">
        <span class="st-chip">统计期间 <b>{{ periodLabel }} · {{ periodMeta.range }}</b></span>
        <span class="st-chip">行业 <b>{{ industryLabel }}</b></span>
        <span v-for="c in conditionChips" :key="c.label + c.value" class="st-chip">{{ c.label }} <b>{{ c.value }}</b></span>
        <span class="st-chip">快照 <b>{{ data?.meta.snapshotId ?? '—' }}</b></span>
        <button type="button" class="drill__retry" @click="emit('retry')">重新查询</button>
      </div>

      <div class="drill__body">
        <!-- loading -->
        <div v-if="drill.status === 'loading' || drill.status === 'idle'" class="drill__skeleton" aria-busy="true">
          <div v-for="i in 8" :key="i" class="drill__skeleton-row">
            <i v-for="j in 8" :key="j"></i>
          </div>
        </div>

        <!-- error -->
        <div v-else-if="drill.status === 'error'" class="st-state">
          <span class="st-state__icon">⚠</span>
          <span class="st-state__title">明细加载失败</span>
          <span class="st-state__text">{{ drill.error?.message }}</span>
          <span class="st-state__trace">code={{ drill.error?.code }} · traceId={{ drill.error?.traceId }}</span>
          <button type="button" class="st-state__retry" @click="emit('retry')">重试</button>
        </div>

        <!-- empty -->
        <div v-else-if="total === 0" class="st-state">
          <span class="st-state__icon">◍</span>
          <span class="st-state__title">该条件下无诉求明细</span>
          <span class="st-state__text">当前条件未命中任何案件（空态，不代表 0 件统计口径）</span>
        </div>

        <!-- ready -->
        <template v-else>
          <div class="drill__table">
            <div class="drill__row drill__row--head">
              <span>案件号</span>
              <span>行业</span>
              <span>诉求类型</span>
              <span>小区</span>
              <span>录入时间</span>
              <span>状态</span>
              <span>关联事件</span>
              <span>评价</span>
            </div>
            <div
              v-for="item in data?.items ?? []"
              :key="item.caseNo"
              class="drill__row"
              :class="{ 'is-related': item.relatedEvent }"
            >
              <span class="c-case">{{ item.caseNo }}</span>
              <span>
                <i class="drill__ind" :class="item.industry === 'WATER' ? 'is-water' : 'is-gas'">
                  {{ item.industry === 'WATER' ? '供水' : '供气' }}
                </i>
              </span>
              <span class="c-type">{{ item.typeName }}</span>
              <span class="c-comm" :title="item.communityName">{{ item.communityName }}</span>
              <span class="c-time">{{ item.intakeTime }}</span>
              <span>
                <i class="drill__status" :class="`is-${item.status === '已办结' ? 'done' : item.status === '处理中' ? 'doing' : 'pending'}`">
                  {{ item.status }}
                </i>
              </span>
              <span class="c-event">
                <template v-if="item.relatedEvent">🔗 {{ item.eventNo }}</template>
                <template v-else>—</template>
              </span>
              <span>
                <i class="drill__sat" :class="`is-${item.satisfaction === '满意' ? 'good' : item.satisfaction === '不满意' ? 'bad' : 'na'}`">
                  {{ item.satisfaction }}
                </i>
              </span>
            </div>
          </div>
        </template>
      </div>

      <footer class="drill__foot">
        <span class="drill__total">
          共 <b>{{ total }}</b> 件 · 每页 {{ pageSize }} 件 · 第 <b>{{ page }}</b>/{{ pages }} 页
          <em v-if="total > 0">（明细分页从 /screen/demands 获取）</em>
        </span>
        <div class="drill__pager">
          <button type="button" :disabled="page <= 1" @click="go(page - 1)">‹ 上一页</button>
          <button
            v-for="p in pageList"
            :key="p"
            type="button"
            :class="{ 'is-current': p === page }"
            @click="go(p)"
          >
            {{ p }}
          </button>
          <button type="button" :disabled="page >= pages" @click="go(page + 1)">下一页 ›</button>
        </div>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.drill {
  position: absolute;
  inset: 0;
  z-index: 900;
}
.drill__mask {
  position: absolute;
  inset: 0;
  background: rgba(1, 7, 14, 0.55);
  animation: drill-fade 0.18s ease;
}
@keyframes drill-fade {
  from {
    opacity: 0;
  }
}
.drill__panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 900px;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(8, 30, 52, 0.99), rgba(4, 14, 26, 0.99));
  border-left: 1px solid var(--st-border-strong);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.6);
  animation: drill-in 0.22s ease;
}
@keyframes drill-in {
  from {
    transform: translateX(40px);
    opacity: 0;
  }
}
.drill__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid rgba(53, 224, 255, 0.2);
  background: linear-gradient(90deg, rgba(24, 92, 134, 0.35), transparent);
}
.drill__title-wrap {
  min-width: 0;
}
.drill__tag {
  display: inline-block;
  padding: 1px 7px;
  margin-right: 8px;
  font-size: 11px;
  color: #04121f;
  background: var(--st-cyan);
}
.drill__title {
  display: inline;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #f2fbff;
  letter-spacing: 0.5px;
}
.drill__source {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--st-muted);
}
.drill__close {
  margin-left: auto;
  flex: none;
  width: 28px;
  height: 28px;
  font-size: 14px;
  color: #a9cbe2;
  background: transparent;
  border: 1px solid rgba(169, 203, 226, 0.35);
  cursor: pointer;
}
.drill__close:hover {
  color: #fff;
  border-color: var(--st-cyan);
}
.drill__conditions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 18px;
  border-bottom: 1px dashed rgba(53, 224, 255, 0.16);
}
.drill__conditions b {
  color: #e6f7ff;
  font-weight: 500;
}
.drill__retry {
  margin-left: auto;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--st-cyan);
  background: rgba(53, 224, 255, 0.08);
  border: 1px solid rgba(53, 224, 255, 0.4);
  cursor: pointer;
}
.drill__body {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 10px 18px;
  overflow: auto;
}
.drill__table {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.drill__row {
  display: grid;
  grid-template-columns: 148px 54px 104px 120px 128px 78px 122px 62px;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 8px;
  border-bottom: 1px dashed rgba(53, 224, 255, 0.1);
}
.drill__row--head {
  height: 30px;
  font-size: 12px;
  color: var(--st-muted);
  background: rgba(53, 224, 255, 0.06);
  border-bottom: 1px solid rgba(53, 224, 255, 0.16);
}
.drill__row.is-related {
  background: rgba(255, 159, 67, 0.05);
}
.c-case {
  color: #9ff2ff;
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}
.c-type {
  color: #e6f7ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-comm {
  color: var(--st-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-time {
  color: var(--st-sub);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.c-event {
  color: #ffcf9a;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drill__ind,
.drill__status,
.drill__sat {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11.5px;
  font-style: normal;
  white-space: nowrap;
}
.drill__ind.is-water {
  color: #7fe6f7;
  border: 1px solid rgba(25, 211, 240, 0.4);
}
.drill__ind.is-gas {
  color: #ffce8a;
  border: 1px solid rgba(245, 166, 35, 0.4);
}
.drill__status.is-done {
  color: #8ef0b4;
  border: 1px solid rgba(46, 204, 113, 0.4);
}
.drill__status.is-doing {
  color: #ffd0a0;
  border: 1px solid rgba(255, 159, 67, 0.4);
}
.drill__status.is-pending {
  color: #ffb3b3;
  border: 1px solid rgba(255, 91, 91, 0.4);
}
.drill__sat.is-good {
  color: #8ef0b4;
}
.drill__sat.is-bad {
  color: #ff9d9d;
}
.drill__sat.is-na {
  color: var(--st-muted);
}
.drill__skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.drill__skeleton-row {
  display: grid;
  grid-template-columns: 148px 54px 104px 120px 128px 78px 122px 62px;
  gap: 6px;
  height: 44px;
  align-items: center;
}
.drill__skeleton-row i {
  display: block;
  height: 14px;
  background: linear-gradient(90deg, rgba(53, 224, 255, 0.08), rgba(53, 224, 255, 0.22), rgba(53, 224, 255, 0.08));
  background-size: 220% 100%;
  animation: st-shimmer 1.25s ease-in-out infinite;
}
.drill__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  border-top: 1px solid rgba(53, 224, 255, 0.2);
  background: rgba(6, 22, 40, 0.9);
}
.drill__total {
  font-size: 12px;
  color: var(--st-muted);
}
.drill__total b {
  color: #e6f7ff;
  font-weight: 600;
}
.drill__total em {
  font-style: normal;
  font-size: 11px;
  color: #5d7f9b;
}
.drill__pager {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.drill__pager button {
  min-width: 28px;
  height: 26px;
  padding: 0 7px;
  font-size: 12px;
  font-family: inherit;
  color: #a9cbe2;
  background: rgba(10, 40, 64, 0.7);
  border: 1px solid rgba(53, 224, 255, 0.2);
  cursor: pointer;
}
.drill__pager button:hover:not(:disabled) {
  border-color: var(--st-cyan);
  color: #eaf8ff;
}
.drill__pager button:disabled {
  opacity: 0.35;
  cursor: default;
}
.drill__pager button.is-current {
  color: #04121f;
  background: var(--st-cyan);
  border-color: var(--st-cyan);
  font-weight: 600;
}
</style>
