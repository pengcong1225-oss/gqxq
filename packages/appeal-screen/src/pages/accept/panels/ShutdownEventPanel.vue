<script setup lang="ts">
/**
 * 停水停气事件详情（标书 1.2.6）
 *
 * 逐条对齐标书要求：
 *   「点击标识可查看停水停气企业、业务类型、时间范围、涉及户数、该事件产生的诉求量等信息」
 *      → 头部摘要：企业 / 业务类型 / 时间范围 / 涉及户数 / 诉求量
 *   「点击诉求量，可查看诉求详情」
 *      → 诉求量区块：有诉求时列明，链接到诉求详情（complaint.read 权限内）
 *   「点击事件详情查看时，可查看到事件的基本信息，包括企业名称、业务类型、时间范围、涉及户数、
 *     影响区域、应急预案、房屋信息、该网格停水停气历史数据等信息」
 *      → 详情视图：上述全部字段，缺失如实写「未提供」，不补 0、不编造
 *   「若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示」
 *      → 多网格区块：列出该事件涉及的全部网格，并说明地图上已联动高亮
 *
 * ===== 口径（重要，不许粉饰）=====
 * 1. 事件当前来自**来源快照直读**（未落 shutdown_application 主表），面板必须显式标出，
 *    不能让人误以为是正式台账数据。
 * 2. 诉求证据按图层事件版本及当前统计快照核对，匹配结果仅作线索。
 * 3. 应急预案 / 房屋信息：来源字段缺失时如实「未提供」，不编造。
 */
import { computed, nextTick, ref, watch } from 'vue';
import {
  CATEGORY_COLORS,
  CATEGORY_LABEL,
  formatShutdownTime,
  householdsText,
  periodText,
  type ShutdownEvent,
  type ShutdownGridHistory,
  type ShutdownMarker,
} from '@/components/Map/map2d/shutdownLayer';
import {
  CATEGORY_OPTIONS, RealApiError, realFetchShutdownComplaint, realFetchShutdownEvidence,
  type ShutdownComplaintDetail, type ShutdownDemandEvidence, type ShutdownStatsSnapshot,
} from '@/stats/realSource';

const props = defineProps<{
  /** 被点击的打点标识 */
  marker: ShutdownMarker | null;
  /** 对应事件 */
  event: ShutdownEvent | null;
  /** 该事件涉及的网格总数（>1 即多网格联动） */
  gridTotal: number;
  highlightedCount: number;
  /** 该网格的停水停气历史数据 */
  gridHistory: ShutdownGridHistory | null;
  /** 数据来源说明（快照 / 主表） */
  dataSource?: 'snapshot' | 'table' | null;
  dataSourceNote?: string | null;
  snapshot: ShutdownStatsSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string;
}>();
const emit = defineEmits<{ (e: 'refresh'): void }>();
const categoryNames = new Map(CATEGORY_OPTIONS.map(({ code, name }) => [code, name]));

/** 字段展示：空值一律「未提供」（标书要求字段齐全，数据缺失就如实说） */
function shown(v: string | number | null | undefined, suffix = ''): string {
  if (v === null || v === undefined || String(v).trim() === '') return '未提供';
  return suffix ? `${v}${suffix}` : String(v);
}

const category = computed(() => props.event?.category ?? props.marker?.category ?? 'planned_water');
const palette = computed(() => CATEGORY_COLORS[category.value]);
const categoryText = computed(() => CATEGORY_LABEL[category.value]);

/** 审批状态中文（如实透传，不美化） */
const approvalText = computed(() => {
  const s = props.event?.approvalStatus ?? '';
  if (!s) return '未提供';
  if (s === 'approved') return '来源已审批';
  if (s === 'pending') return '来源待审批';
  if (s === 'rejected') return '来源已驳回';
  return `来源状态码 ${s}`;
});
const approvalClass = computed(() => {
  const s = props.event?.approvalStatus ?? '';
  if (s === 'approved') return 'is-ok';
  if (s === 'pending') return 'is-warn';
  return 'is-plain';
});

/** 事件是否多网格（标书联动高亮场景） */
const isMulti = computed(() => (props.gridTotal ?? 1) > 1);

/** 该网格历史里，本事件之外的其它事件（标书：该网格停水停气历史数据） */
const historyOthers = computed(() => {
  const h = props.gridHistory;
  const ev = props.event;
  if (!h) return [];
  return h.events.filter((e) => e.eventId !== ev?.eventId);
});

const evidence = ref<Awaited<ReturnType<typeof realFetchShutdownEvidence>> | null>(null);
const evidenceLoading = ref(false);
const evidenceError = ref('');
const expanded = ref(false);
const evidenceSection = ref<HTMLElement | null>(null);
const complaintSection = ref<HTMLElement | null>(null);
const selectedComplaint = ref<ShutdownDemandEvidence | null>(null);
const complaint = ref<ShutdownComplaintDetail | null>(null);
const complaintError = ref('');
let complaintRequest: AbortController | null = null;

function closeComplaint() {
  complaintRequest?.abort();
  complaintRequest = null;
  selectedComplaint.value = null;
  complaint.value = null;
  complaintError.value = '';
}

watch(
  [() => props.event?.eventId, () => props.event?.layerVersion, () => props.snapshot?.contextId],
  async ([eventId, version], _previous, onCleanup) => {
    evidence.value = null;
    evidenceError.value = '';
    evidenceLoading.value = false;
    expanded.value = false;
    closeComplaint();
    const snapshot = props.snapshot;
    if (!eventId || !version || !snapshot) return;
    const expiresIn = Date.parse(snapshot.expiresAt) - Date.now();
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      evidenceError.value = '统计快照已过期，请刷新后重新选择事件。';
      return;
    }
    const request = new AbortController();
    const expiryTimer = window.setTimeout(() => {
      request.abort();
      closeComplaint();
      evidence.value = null;
      expanded.value = false;
      evidenceLoading.value = false;
      evidenceError.value = '统计快照已过期，请刷新后重新选择事件。';
    }, expiresIn);
    onCleanup(() => {
      window.clearTimeout(expiryTimer);
      request.abort();
      closeComplaint();
    });
    evidenceLoading.value = true;
    try {
      const result = await realFetchShutdownEvidence(eventId, version, snapshot, request.signal);
      if (!request.signal.aborted) evidence.value = result;
    } catch (error) {
      if (request.signal.aborted) return;
      evidenceError.value = error instanceof RealApiError && error.code === 404
        ? '当前统计快照未覆盖该事件，或事件已不可见。'
        : error instanceof Error ? error.message : '无法核对相关诉求';
    } finally {
      if (!request.signal.aborted) evidenceLoading.value = false;
    }
  },
  { immediate: true },
);

const evidenceMessage = computed(() => {
  if (props.snapshotLoading || evidenceLoading.value) return '正在核对统计快照…';
  if (evidenceError.value) return evidenceError.value;
  if (props.snapshotError) return props.snapshotError;
  if (evidence.value) return evidence.value.reason;
  if (!props.event?.layerVersion) return '图层缺少事件版本，请刷新图层与统计。';
  return '统计快照尚未就绪。';
});

async function showEvidence() {
  expanded.value = !expanded.value;
  if (!expanded.value) {
    closeComplaint();
    return;
  }
  await nextTick();
  evidenceSection.value?.scrollIntoView({ block: 'nearest' });
}

async function openComplaint(row: ShutdownDemandEvidence) {
  if (!evidence.value || !props.snapshot || Date.parse(props.snapshot.expiresAt) <= Date.now()) return;
  closeComplaint();
  selectedComplaint.value = row;
  const request = new AbortController();
  complaintRequest = request;
  await nextTick();
  if (request.signal.aborted) return;
  complaintSection.value?.scrollIntoView({ block: 'nearest' });
  try {
    const result = await realFetchShutdownComplaint(row, request.signal);
    if (!request.signal.aborted) complaint.value = result;
  } catch (error) {
    if (!request.signal.aborted) complaintError.value = error instanceof Error ? error.message : '无法读取诉求详情';
  }
}
</script>

<template>
  <div class="sd">
    <!-- 数据来源横幅：快照直读必须可见 -->
    <p v-if="props.dataSource" class="sd__src">
      <b>{{ props.dataSource === 'snapshot' ? '事件来源快照' : '停供业务台账' }}</b>
      <span>{{ props.dataSourceNote }}</span>
    </p>

    <!-- ---------- 事件摘要（标书：企业/业务类型/时间范围/涉及户数/诉求量）---------- -->
    <section class="sd__summary" :style="{ borderLeftColor: palette.fill }">
      <div class="sd__catrow">
        <span class="sd__cat" :style="{ background: palette.fill }">{{ categoryText }}</span>
        <span class="sd__approval" :class="approvalClass">{{ approvalText }}</span>
        <span v-if="isMulti" class="sd__multi">多网格事件</span>
      </div>
      <h3 class="sd__name">{{ shown(props.event?.enterpriseName) }}</h3>
      <ul class="sd__kv">
        <li>
          <em>业务类型</em>
          <b :class="props.event?.businessType === 'gas' ? 'is-gas' : 'is-water'">
            {{ props.event?.businessType === 'gas' ? '燃气（停气）' : '供水（停水）' }}
          </b>
        </li>
        <li>
          <em>时间范围</em>
          <b>{{ props.event ? periodText(props.event) : '未提供' }}</b>
        </li>
        <li>
          <em>涉及户数</em>
          <b>{{ props.event ? householdsText(props.event) : '未提供' }}</b>
        </li>
        <li>
          <em>时空匹配诉求</em>
          <button v-if="evidence?.total" type="button" class="sd__action" :aria-expanded="expanded" @click="showEvidence">
            {{ evidence.total }} 件
          </button>
          <b v-else-if="evidence?.total === 0">0 件</b>
          <b v-else class="is-muted">{{ props.snapshotLoading || evidenceLoading ? '核对中' : '未核验' }}</b>
        </li>
        <li>
          <em>涉及网格</em>
          <b>{{ props.event?.gridCodes?.length ?? 0 }} 个</b>
        </li>
      </ul>
    </section>

    <section ref="evidenceSection" class="sd__block" aria-label="相关诉求">
      <header class="sd__blockhead">
        <b>相关诉求</b>
        <span v-if="snapshot">统计窗口 {{ snapshot.from }} 至 {{ snapshot.to }}</span>
      </header>
      <p v-if="evidence?.total === 0" class="sd__tip">当前快照范围内未找到符合条件的诉求。</p>
      <p class="sd__tip" aria-live="polite">{{ evidenceMessage }}</p>
      <button
        v-if="!evidence && !snapshotLoading && !evidenceLoading"
        type="button" class="sd__action" @click="emit('refresh')"
      >刷新图层与统计</button>
      <ul v-if="expanded && evidence?.items.length" class="sd__complaints">
        <li v-for="row in evidence.items" :key="row.id">
          <button type="button" class="sd__action is-mono" :aria-expanded="selectedComplaint?.id === row.id"
            @click="openComplaint(row)">{{ row.complaintNo || row.id }}</button>
          <span>{{ formatShutdownTime(row.occurredAt) }} · {{ row.gridId }} · {{ categoryNames.get(row.type) ?? '类型未映射' }}</span>
        </li>
      </ul>
      <article v-if="selectedComplaint" ref="complaintSection" class="sd__receipt" aria-label="诉求工单详情">
        <header class="sd__blockhead">
          <b>诉求工单 {{ selectedComplaint.complaintNo || selectedComplaint.id }}</b>
          <button type="button" class="sd__action" @click="closeComplaint">关闭详情</button>
        </header>
        <template v-if="complaint">
          <strong>{{ complaint.title }}</strong>
          <dl class="sd__dl">
            <dt>业务类型</dt><dd>{{ shown(complaint.businessTypeName) }}</dd>
            <dt>诉求类型</dt><dd>{{ shown(complaint.complaintTypeName) }}</dd>
            <dt>来源状态</dt><dd>{{ shown(complaint.sourceEventStatusName) }}</dd>
            <dt>责任企业</dt><dd>{{ shown(complaint.enterpriseName) }}</dd>
            <dt>诉求内容</dt><dd class="sd__content">{{ shown(complaint.content) }}</dd>
          </dl>
        </template>
        <p v-else class="sd__tip" aria-live="polite">{{ complaintError || '正在读取正式工单…' }}</p>
      </article>
    </section>

    <!-- ---------- 多网格联动高亮说明（标书核心要求）---------- -->
    <section v-if="isMulti" class="sd__block sd__block--link">
      <header class="sd__blockhead">
        <b>多网格联动高亮</b>
        <span>涉及 {{ gridTotal }} 个网格 · 当前图层高亮 {{ highlightedCount }} 个标识</span>
      </header>
      <div class="sd__grids">
        <span
          v-for="g in props.event?.gridCodes ?? []"
          :key="g"
          class="sd__gridchip"
          :class="{ 'is-current': g === props.marker?.gridCode }"
        >
          {{ g }}
          <small v-if="g === props.marker?.gridCode">当前</small>
        </span>
      </div>
    </section>

    <!-- ---------- 事件基本信息（标书：影响区域/应急预案/房屋信息）---------- -->
    <section class="sd__block">
      <header class="sd__blockhead">
        <b>事件基本信息</b>
      </header>
      <dl class="sd__dl">
        <dt>企业名称</dt>
        <dd>{{ shown(props.event?.enterpriseName) }}</dd>
        <dt>业务类型</dt>
        <dd>{{ props.event?.businessType === 'gas' ? '燃气（停气）' : '供水（停水）' }}</dd>
        <dt>时间范围</dt>
        <dd>{{ props.event ? periodText(props.event) : '未提供' }}</dd>
        <dt>涉及户数</dt>
        <dd>{{ props.event ? householdsText(props.event) : '未提供' }}</dd>
        <dt>影响区域</dt>
        <dd>{{ shown(props.event?.affectedArea) }}</dd>
        <dt>应急预案</dt>
        <dd :class="{ 'is-missing': !props.event?.emergencyPlan }">{{ shown(props.event?.emergencyPlan) }}</dd>
        <dt>房屋信息</dt>
        <dd :class="{ 'is-missing': !props.event?.housingInfo }">{{ shown(props.event?.housingInfo) }}</dd>
        <dt>来源申请号</dt>
        <dd class="is-mono">{{ shown(props.event?.sourceApplyNo) }}</dd>
        <dt>审批状态</dt>
        <dd>{{ approvalText }}</dd>
      </dl>
    </section>

    <!-- ---------- 该网格停水停气历史数据（标书明确要求）---------- -->
    <section class="sd__block">
      <header class="sd__blockhead">
        <b>该网格停水停气历史</b>
        <span v-if="props.gridHistory">
          {{ props.gridHistory.gridName ?? props.gridHistory.gridCode }} · 共
          {{ props.gridHistory.total }} 起
        </span>
        <span v-else>该网格暂无历史记录</span>
      </header>
      <template v-if="props.gridHistory">
        <ul class="sd__historycat">
          <li v-for="c in (['planned_water', 'planned_gas', 'emergency_water', 'emergency_gas'] as const)" :key="c">
            <i :style="{ background: CATEGORY_COLORS[c].fill }"></i>
            {{ CATEGORY_LABEL[c] }}
            <b>{{ props.gridHistory.byCategory[c] ?? 0 }}</b>
          </li>
        </ul>
        <div v-if="historyOthers.length" class="sd__histtable">
          <div class="sd__histtable-head">
            <span>类型</span><span>企业</span><span>时间范围</span><span>户数</span>
          </div>
          <div v-for="h in historyOthers" :key="h.eventId + h.startTime" class="sd__histtable-row">
            <span>
              <i :style="{ background: CATEGORY_COLORS[h.category].fill }"></i>{{ h.categoryLabel }}
            </span>
            <span>{{ h.enterpriseName ?? '未提供' }}</span>
            <span class="is-mono">{{ formatShutdownTime(h.startTime) }} ~ {{ formatShutdownTime(h.endTime) }}</span>
            <span>{{ h.affectedHouseholds ?? '未提供' }}</span>
          </div>
        </div>
        <p v-else class="sd__tip">该网格除本事件外暂无其它停水停气记录。</p>
      </template>
      <div v-else class="sd__empty"><span>该网格尚未关联到其它停水停气事件。</span></div>
    </section>
  </div>
</template>

<style scoped>
.sd {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  font-size: 11.5px;
  color: #d6f6ef;
}

/* 数据来源横幅：快照直读必须显眼 */
.sd__src {
  flex: none;
  margin: 0;
  padding: 6px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.42);
  border: 1px dashed rgba(255, 214, 124, 0.5);
  font-size: 10.5px;
  line-height: 1.5;
}
.sd__src b {
  color: #ffd67c;
  font-size: 11.5px;
}

/* 摘要卡 */
.sd__summary {
  flex: none;
  padding: 8px 10px;
  border-left: 3px solid #3498db;
  background: rgba(4, 28, 27, 0.6);
  border-top: 1px solid rgba(52, 139, 124, 0.34);
  border-right: 1px solid rgba(52, 139, 124, 0.34);
  border-bottom: 1px solid rgba(52, 139, 124, 0.34);
}
.sd__catrow {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.sd__cat {
  padding: 2px 9px;
  border-radius: 2px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}
.sd__approval {
  padding: 1px 7px;
  border-radius: 2px;
  font-size: 10px;
  border: 1px solid transparent;
}
.sd__approval.is-ok {
  color: #8ff0c0;
  background: rgba(22, 92, 62, 0.5);
  border-color: rgba(143, 240, 192, 0.45);
}
.sd__approval.is-warn {
  color: #ffd67c;
  background: rgba(61, 48, 12, 0.5);
  border-color: rgba(255, 214, 124, 0.45);
}
.sd__approval.is-plain {
  color: #a8d8ce;
  background: rgba(30, 60, 56, 0.5);
  border-color: rgba(168, 216, 206, 0.3);
}
.sd__multi {
  padding: 1px 7px;
  border-radius: 2px;
  color: #ffe57a;
  background: rgba(58, 48, 6, 0.6);
  border: 1px solid rgba(255, 229, 122, 0.5);
  font-size: 10px;
}
.sd__name {
  margin: 7px 0 6px;
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-weight: 400;
  font-size: 16px;
  letter-spacing: 1px;
  color: #b9fff3;
}
.sd__kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sd__kv li {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.sd__kv em {
  flex: none;
  font-style: normal;
  font-size: 10px;
  color: #7fa9a0;
}
.sd__kv b {
  font-weight: 400;
  color: #eafffa;
}
.sd__kv b.is-gas {
  color: #ffc58a;
}
.sd__kv b.is-water {
  color: #9ed3f7;
}
.sd__kv b.is-muted {
  color: #7fa9a0;
}
.sd__action {
  padding: 2px 4px;
  border: 1px solid rgba(255, 229, 122, 0.45);
  border-radius: 3px;
  background: rgba(255, 229, 122, 0.08);
  color: #ffe57a;
  font: inherit;
  cursor: pointer;
}
.sd__action:focus-visible,
.sd__action:hover {
  border-color: #ffe57a;
  background: rgba(255, 229, 122, 0.18);
}

/* 通用区块 */
.sd__block {
  flex: none;
  padding: 8px 10px;
  border: 1px solid rgba(52, 139, 124, 0.42);
  background: rgba(4, 28, 27, 0.5);
}
.sd__block--link {
  border-color: rgba(255, 229, 122, 0.42);
  background: rgba(48, 40, 6, 0.34);
}
.sd__blockhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(52, 139, 124, 0.28);
}
.sd__blockhead b {
  font-family: 'YouSheBiaoTiHei', 'Bahnschrift', sans-serif;
  font-weight: 400;
  font-size: 14px;
  letter-spacing: 1px;
  color: #b9fff3;
  flex: none;
}
.sd__blockhead span {
  margin-left: auto;
  font-size: 9.5px;
  color: #7fa9a0;
  text-align: right;
}

/* 多网格网格芯片 */
.sd__grids {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.sd__gridchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.3);
  background: rgba(6, 30, 29, 0.9);
  color: #a8d8ce;
  font-size: 10.5px;
}
.sd__gridchip.is-current {
  border-color: #ffe57a;
  color: #ffe57a;
  background: rgba(58, 48, 6, 0.7);
}
.sd__gridchip small {
  font-size: 9px;
  opacity: 0.8;
}
.sd__tip {
  margin: 6px 0 0;
  font-size: 9.5px;
  line-height: 1.5;
  color: #7fa9a0;
}

/* 详情定义列表 */
.sd__dl {
  display: grid;
  grid-template-columns: 82px 1fr;
  gap: 4px 10px;
  margin: 0;
}
.sd__dl dt {
  font-size: 10.5px;
  color: #7fa9a0;
}
.sd__dl dd {
  margin: 0;
  color: #d6f6ef;
  word-break: break-all;
}
.sd__dl dd.is-missing {
  color: #7fa9a0;
  font-style: italic;
}
.sd__dl dd.is-mono {
  font-family: 'Consolas', monospace;
  font-size: 10.5px;
  color: #9ed3f7;
}

/* 空态 */
.sd__empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px dashed rgba(255, 214, 124, 0.42);
  background: rgba(61, 48, 12, 0.28);
  color: #ffe0a3;
  font-size: 10.5px;
  line-height: 1.55;
}
.sd__empty b {
  color: #ffd67c;
  font-size: 11.5px;
}
.sd__empty em {
  font-style: normal;
  color: #ffd67c;
}

/* 历史数据 */
.sd__historycat {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0 0 7px;
  padding: 0;
  list-style: none;
  font-size: 10.5px;
  color: #a8d8ce;
}
.sd__historycat li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sd__historycat i,
.sd__histtable i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;
}
.sd__historycat b {
  color: #eafffa;
  font-weight: 600;
}
.sd__histtable {
  border: 1px solid rgba(52, 139, 124, 0.28);
}
.sd__histtable-head,
.sd__histtable-row {
  display: grid;
  grid-template-columns: 76px 1fr 128px 52px;
  gap: 6px;
  padding: 4px 6px;
  font-size: 10.5px;
}
.sd__histtable-head {
  color: #7fa9a0;
  border-bottom: 1px solid rgba(52, 139, 124, 0.35);
  background: rgba(6, 38, 36, 0.6);
}
.sd__histtable-row {
  color: #b8ded6;
  border-bottom: 1px solid rgba(52, 139, 124, 0.16);
}
.sd__histtable-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd__histtable-row .is-mono {
  font-family: 'Consolas', monospace;
  font-size: 9.5px;
  color: #9ed3f7;
}
.sd__complaints {
  margin: 0;
  padding: 0;
  list-style: none;
}
.sd__complaints li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 6px 0;
}
.sd__receipt {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid rgba(89, 204, 183, 0.45);
}
.sd__receipt strong { display: block; margin-bottom: 6px; }
.sd__content { white-space: pre-wrap; }
</style>
