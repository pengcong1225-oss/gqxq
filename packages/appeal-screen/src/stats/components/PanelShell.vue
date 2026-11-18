<script setup lang="ts">
/**
 * 面板统一外壳：标题 + 口径自述 + loading 骨架屏 / 空态 / 错误态（含 traceId）/ 正常内容。
 * 三态真实实现见 docs/layer-screen/18 §四。
 */
import type { PanelState } from '../types';

withDefaults(
  defineProps<{
    title: string;
    caption?: string;
    /** idle 视为 loading（首帧） */
    state?: Pick<PanelState<unknown>, 'status' | 'error'> | null;
    emptyText?: string;
    emptyTitle?: string;
    errorTitle?: string;
  }>(),
  {
    caption: '',
    state: null,
    emptyText: '当前筛选条件下暂无数据',
    emptyTitle: '暂无数据',
    errorTitle: '数据加载失败',
  }
);

const emit = defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <section class="st-panel">
    <header class="st-panel__head">
      <h3 class="st-panel__title">{{ title }}</h3>
      <span v-if="caption" class="st-panel__caption">{{ caption }}</span>
      <div class="st-panel__extra">
        <slot name="extra" />
      </div>
    </header>
    <div class="st-panel__body">
      <!-- loading：骨架屏 -->
      <div v-if="!state || state.status === 'idle' || state.status === 'loading'" class="st-skeleton" aria-busy="true" aria-label="加载中">
        <div class="st-skeleton__bar"></div>
        <div class="st-skeleton__bar"></div>
        <div class="st-skeleton__block"></div>
      </div>

      <!-- empty：空态文案 -->
      <div v-else-if="state.status === 'empty'" class="st-state">
        <span class="st-state__icon">◍</span>
        <span class="st-state__title">{{ emptyTitle }}</span>
        <span class="st-state__text">{{ emptyText }}</span>
        <slot name="empty" />
      </div>

      <!-- error：错误码 + traceId + 重试（对应 06 §5） -->
      <div v-else-if="state.status === 'error'" class="st-state st-state--error">
        <span class="st-state__icon">⚠</span>
        <span class="st-state__title">{{ errorTitle }}</span>
        <span class="st-state__text">{{ state.error?.message }}</span>
        <span class="st-state__trace">code={{ state.error?.code }} · traceId={{ state.error?.traceId }}</span>
        <button class="st-state__retry" type="button" @click="emit('retry')">重新加载</button>
      </div>

      <!-- ready -->
      <slot v-else />
    </div>
  </section>
</template>
