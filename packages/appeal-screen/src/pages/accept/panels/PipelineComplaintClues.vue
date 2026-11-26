<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { formatShutdownTime as formatProjectTime } from '@/components/Map/map2d/shutdownLayer';
import {
  realFetchComplaintDetail,
  realFetchPipelineClues,
  type PipelineComplaintClues,
  type RealComplaintDetail,
} from '@/stats/realSource';

type Clue = PipelineComplaintClues['items'][number];
const props = defineProps<{ projectId: string; gridCode: string; sourceRevision?: string | null }>();
const page = ref(1);
const retry = ref(0);
const clues = ref<PipelineComplaintClues | null>(null);
const cluesError = ref('');
const selected = ref<Clue | null>(null);
const detail = ref<RealComplaintDetail | null>(null);
const detailError = ref('');
const detailSection = ref<HTMLElement | null>(null);
let detailRequest: AbortController | null = null;

const totalPages = computed(() => clues.value?.total != null ? Math.max(1, Math.ceil(clues.value.total / clues.value.size)) : 1);

function closeDetail() {
  detailRequest?.abort();
  detailRequest = null;
  selected.value = null;
  detail.value = null;
  detailError.value = '';
}

watch([page, retry], async ([currentPage], _previous, onCleanup) => {
  const request = new AbortController();
  onCleanup(() => { request.abort(); closeDetail(); });
  clues.value = null;
  cluesError.value = '';
  try {
    const result = await realFetchPipelineClues(props.projectId, props.gridCode, currentPage, props.sourceRevision, request.signal);
    if (request.signal.aborted) return;
    const lastPage = Math.max(1, Math.ceil((result.total ?? 0) / result.size));
    if (currentPage > lastPage) page.value = lastPage;
    else clues.value = result;
  } catch (error) {
    if (!request.signal.aborted) cluesError.value = error instanceof Error ? error.message : '无法核对相关诉求';
  }
}, { immediate: true });

async function openDetail(clue: Clue) {
  closeDetail();
  selected.value = clue;
  const request = new AbortController();
  detailRequest = request;
  await nextTick();
  if (request.signal.aborted) return;
  detailSection.value?.scrollIntoView({ block: 'nearest' });
  try {
    const result = await realFetchComplaintDetail(clue, request.signal);
    if (!request.signal.aborted) detail.value = result;
  } catch (error) {
    if (!request.signal.aborted) detailError.value = error instanceof Error ? error.message : '无法读取诉求工单';
  }
}
</script>

<template>
  <section class="pipeline-clues" aria-label="相关诉求">
    <h4>相关诉求 · 时空匹配线索</h4>
    <p v-if="clues?.window" class="pipeline-clues__note">
      {{ gridCode }} 网格 · {{ formatProjectTime(clues.window.from) }} 至 {{ formatProjectTime(clues.window.to) }}
    </p>
    <p class="pipeline-clues__note" role="status">
      <template v-if="cluesError">{{ cluesError }}</template>
      <template v-else-if="clues?.state === 'unavailable'">未核验。{{ clues.reason }}</template>
      <template v-else-if="clues">核对结果 {{ clues.total }} 件。{{ clues.reason }}</template>
      <template v-else>正在核对授权范围内的正式工单…</template>
    </p>
    <button v-if="cluesError" type="button" @click="retry += 1">重试</button>

    <ul v-if="clues?.items.length">
      <li v-for="clue in clues.items" :key="clue.id">
        <button type="button" :aria-expanded="selected?.id === clue.id" @click="openDetail(clue)">
          {{ clue.complaintNo || clue.id }}
        </button>
        <span>{{ clue.title || '标题未提供' }} · {{ formatProjectTime(clue.occurredAt) }}</span>
      </li>
    </ul>
    <nav v-if="totalPages > 1" aria-label="诉求线索分页">
      <button type="button" :disabled="page <= 1" @click="page -= 1">上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" :disabled="page >= totalPages" @click="page += 1">下一页</button>
    </nav>

    <article v-if="selected" ref="detailSection" class="pipeline-clues__receipt" aria-label="诉求工单详情">
      <header>
        <b>诉求工单 {{ selected.complaintNo || selected.id }}</b>
        <button type="button" @click="closeDetail">关闭详情</button>
      </header>
      <template v-if="detail">
        <strong>{{ detail.title }}</strong>
        <dl>
          <dt>业务类型</dt><dd>{{ detail.businessTypeName || '未提供' }}</dd>
          <dt>诉求类型</dt><dd>{{ detail.complaintTypeName || '未提供' }}</dd>
          <dt>来源状态</dt><dd>{{ detail.sourceEventStatusName || '未提供' }}</dd>
          <dt>责任企业</dt><dd>{{ detail.enterpriseName || '未提供' }}</dd>
          <dt>诉求内容</dt><dd>{{ detail.content || '未提供' }}</dd>
        </dl>
      </template>
      <p v-else class="pipeline-clues__note" role="status">{{ detailError || '正在读取正式工单…' }}</p>
    </article>
  </section>
</template>

<style scoped>
.pipeline-clues__note { margin: 5px 0; color: #a8d8ce; font-size: 11px; }
ul { margin: 7px 0; padding: 0; list-style: none; }
li, nav, header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px 8px; }
li + li { margin-top: 5px; }
button {
  padding: 2px 6px;
  color: #86fbe7;
  background: rgba(13, 58, 53, 0.9);
  border: 1px solid rgba(134, 251, 231, 0.5);
  font: inherit;
  cursor: pointer;
}
button:hover:not(:disabled) { background: #1b7466; }
button:disabled { opacity: 0.55; cursor: default; }
.pipeline-clues__receipt { margin-top: 8px; padding: 8px; border: 1px solid rgba(89, 204, 183, 0.45); }
header { justify-content: space-between; margin-bottom: 6px; }
dl { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 4px 8px; margin: 5px 0 0; }
dt { color: #a8d8ce; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
