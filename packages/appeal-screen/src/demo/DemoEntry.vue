<script setup>
/**
 * 本地样式预览入口（仅演示用，不参与业务）
 * 首页所有业务按钮仍保持「无点击方法」，演示交互集中在这里。
 * 接新项目时删掉本组件，以及 Index.vue 中的 <DemoEntry/> 一行即可。
 */
import { ref } from 'vue'
import DemoModal from './DemoModal.vue'

const expanded = ref(false)
const variant = ref('')
const open = (v) => { variant.value = v }
const close = () => { variant.value = '' }

const buttons = [
  { key: 'table', label: '表格弹窗' },
  { key: 'form', label: '表单弹窗' },
  { key: 'detail', label: '详情弹窗' },
]
</script>

<template>
  <div class="demo-entry">
    <Transition name="demo-panel-fade">
      <div v-if="expanded" class="demo-panel">
        <div class="demo-panel-head">
          <i class="demo-panel-accent"></i>
          样式预览
          <span>DEMO</span>
        </div>
        <button
            v-for="btn in buttons"
            :key="btn.key"
            type="button"
            class="demo-panel-btn"
            @click="open(btn.key)"
        >{{ btn.label }}</button>
        <p class="demo-panel-tip">全部为本地假数据 · 无登录 / 无后端</p>
      </div>
    </Transition>

    <button type="button" class="demo-trigger" @click="expanded = !expanded">
      {{ expanded ? '收起预览' : '样式预览' }}
    </button>
  </div>

  <DemoModal :visible="!!variant" :variant="variant || 'table'" @close="close"/>
</template>

<style scoped lang="scss">
.demo-entry {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 250;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  font-size: 13px;
}

.demo-trigger {
  height: 34px;
  padding: 0 18px;
  color: #86fbe7;
  letter-spacing: 1px;
  background: linear-gradient(165deg, rgba(12, 56, 52, 0.94), rgba(5, 24, 22, 0.92));
  border: 1px solid rgb(54, 137, 129);
  border-radius: 4px;
  box-shadow: 0 0 14px rgba(54, 137, 129, 0.35);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;

  &:hover {
    border-color: #66ffff;
    box-shadow: 0 0 18px rgba(134, 251, 231, 0.4);
  }
}

.demo-panel {
  width: 190px;
  padding: 12px;
  background: linear-gradient(165deg, rgba(12, 56, 52, 0.96), rgba(5, 24, 22, 0.95));
  border: 1px solid rgb(54, 137, 129);
  border-radius: 6px;
  box-shadow: 0 0 20px rgba(54, 137, 129, 0.35);
}
.demo-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 10px;
  color: #edffff;
  border-bottom: 1px solid rgba(102, 255, 255, 0.2);

  span {
    margin-left: auto;
    font-size: 10px;
    letter-spacing: 1px;
    color: rgba(134, 251, 231, 0.55);
  }
}
.demo-panel-accent {
  width: 3px;
  height: 14px;
  background: #66ffff;
  box-shadow: 0 0 6px #66ffff;
}
.demo-panel-btn {
  display: block;
  width: 100%;
  height: 32px;
  margin-bottom: 8px;
  color: #bfe6e4;
  background: rgba(102, 255, 255, 0.06);
  border: 1px solid rgba(102, 255, 255, 0.28);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    color: #06211f;
    background: linear-gradient(120deg, #86fbe7, #66ffff);
    border-color: transparent;
  }
}
.demo-panel-tip {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: rgba(145, 185, 187, 0.8);
}

.demo-panel-fade-enter-active,
.demo-panel-fade-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.demo-panel-fade-enter-from,
.demo-panel-fade-leave-to { opacity: 0; transform: translateY(8px); }
</style>
