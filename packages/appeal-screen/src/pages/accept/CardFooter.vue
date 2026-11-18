<script setup lang="ts">
/**
 * 验收大屏 · 卡片底部信息带（5 张卡共用，不耦合 OverviewCard 的 .ov__*）
 *
 * 设计目标：
 *  - 统一视觉：每张卡底部一条信息带（细线 + 口径/质量项 + 可选「明细 ›」），贴住卡片底边（margin-top:auto），
 *    把原卡片下半部的大块空白变成有用的口径 / 质量信息；
 *  - 数值口径：所有 value 都由各卡片从现有 props 推导后以字符串传入；算不出来传「—」，
 *    组件本身不产出任何数字，也不把 0 当兜底；
 *  - 交互保留：某些条目有原有点击入口（如「未定位」只开明细不定位地图），用 itemKey 透传，
 *    由卡片监听 item-click 后 emit 自己的事件，不改变原有交互语义。
 */

type FootItem = {
  label: string;
  value: string;
  /** 质量项异常（未定位 > 0 / 缺户数 > 0 等）用暖色强调 */
  warn?: boolean;
  /** 悬浮解释该条目的口径 / 不可计算原因 */
  title?: string;
  /** 有 itemKey 时该条目可点击（行内按钮），点击 emit('item-click', key) */
  itemKey?: string;
};

defineProps<{
  items: FootItem[];
  /** 右侧明细入口文案（如「明细」）；不传则不出按钮 */
  drillLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'drill'): void;
  (e: 'item-click', key: string): void;
}>();
</script>

<template>
  <footer class="acc-card__foot">
    <template v-for="item in items" :key="item.itemKey ?? item.label">
      <button
        v-if="item.itemKey"
        type="button"
        class="acc-card__foot-item is-link"
        :class="{ 'is-warn': item.warn }"
        :title="item.title ?? `${item.label}：${item.value}`"
        @click="emit('item-click', item.itemKey)"
      >
        <em>{{ item.label }}</em><b>{{ item.value }}</b>
      </button>
      <span
        v-else
        class="acc-card__foot-item"
        :class="{ 'is-warn': item.warn }"
        :title="item.title ?? `${item.label}：${item.value}`"
      >
        <em>{{ item.label }}</em><b>{{ item.value }}</b>
      </span>
    </template>
    <button v-if="drillLabel" type="button" class="acc-card__foot-drill" @click="emit('drill')">{{ drillLabel }} ›</button>
  </footer>
</template>