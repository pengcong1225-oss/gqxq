<script setup>
/**
 * 弹窗样式演示。
 * 外壳直接使用原项目的 Modal.vue（title.png 标题切图、左右装饰、close.png、
 * 可拖拽标题栏、深色青绿描边），与原弹窗完全一致；
 * 内部只换成 src/demo 的本地假数据（表格 / 表单 / 详情）。
 */
import { computed, ref, watch, nextTick } from 'vue'
import Modal from './Modal.vue'
import { modalTable, modalForm, modalDetail } from './demoData.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  variant: { type: String, default: 'table' },
})
const emit = defineEmits(['close'])

const modalRef = ref(null)
const title = computed(() => {
  if (props.variant === 'form') return modalForm.title
  if (props.variant === 'detail') return modalDetail.title
  return modalTable.title
})

// 原 Modal 通过 expose 的 open()/close() 控制显隐，这里做一层状态桥接
watch(() => props.visible, (v) => {
  nextTick(() => {
    if (v) modalRef.value?.open()
    else modalRef.value?.close()
  })
}, { immediate: true })

const onClose = () => emit('close')
</script>

<template>
  <Modal ref="modalRef" :title="title" :width="880" :height="520" @close="onClose">
    <div class="demo-modal-content">
      <!-- 表格 -->
      <table v-if="variant === 'table'" class="demo-modal-table">
        <thead>
          <tr><th v-for="col in modalTable.columns" :key="col">{{ col }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in modalTable.rows" :key="row.id">
            <td>{{ row.id }}</td>
            <td>{{ row.name }}</td>
            <td>{{ row.value }}</td>
            <td><span class="demo-status" :class="{ 'is-warn': row.status === '关注' }">{{ row.status }}</span></td>
          </tr>
        </tbody>
      </table>

      <!-- 表单 -->
      <div v-else-if="variant === 'form'" class="demo-form">
        <label v-for="field in modalForm.fields" :key="field.label" class="demo-form-row">
          <span class="demo-form-label">{{ field.label }}</span>
          <select v-if="field.type === 'select'" class="demo-form-control">
            <option v-for="opt in field.options" :key="opt">{{ opt }}</option>
          </select>
          <textarea v-else-if="field.type === 'textarea'" class="demo-form-control" rows="3" :placeholder="field.placeholder"></textarea>
          <input v-else class="demo-form-control" type="text" :placeholder="field.placeholder">
        </label>
        <div class="demo-form-actions">
          <button type="button" class="demo-btn" @click="onClose">取消</button>
          <button type="button" class="demo-btn is-primary" @click="onClose">确定</button>
        </div>
      </div>

      <!-- 详情 -->
      <div v-else class="demo-detail">
        <div class="demo-detail-grid">
          <div v-for="item in modalDetail.info" :key="item.label" class="demo-detail-item">
            <span class="demo-detail-label">{{ item.label }}</span>
            <span class="demo-detail-value">{{ item.value }}</span>
          </div>
        </div>
        <p class="demo-detail-summary">{{ modalDetail.summary }}</p>
      </div>
    </div>
  </Modal>
</template>

<style scoped lang="scss">
/* 内容区沿用原弹窗的青绿配色；外框、标题栏、关闭按钮全部来自原 Modal.vue */
.demo-modal-content {
  height: 100%;
  padding: 14px 18px;
  box-sizing: border-box;
  overflow: auto;
  color: #edffff;
  font-size: 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(102, 255, 255, 0.45) transparent;
}

.demo-modal-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th {
    padding: 10px 12px;
    text-align: left;
    font-weight: 500;
    color: #86fbe7;
    background: #19474b;
    border-bottom: 1px solid rgba(102, 255, 255, 0.3);
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(102, 255, 255, 0.09);
    background: rgba(6, 24, 30, 0.96);
    color: #d9f5f3;
  }
  tbody tr:nth-child(odd) td { background: rgba(18, 73, 77, 0.35); }
  tbody tr:hover td { background: rgba(102, 255, 255, 0.1); }
}
.demo-status {
  padding: 2px 10px;
  border: 1px solid rgba(134, 251, 231, 0.5);
  border-radius: 2px;
  font-size: 12px;
  color: #86fbe7;
  &.is-warn { border-color: rgba(255, 178, 122, 0.6); color: #ffb27a; }
}

.demo-form { display: flex; flex-direction: column; gap: 14px; }
.demo-form-row { display: flex; align-items: flex-start; gap: 14px; }
.demo-form-label { flex: 0 0 72px; padding-top: 9px; text-align: right; color: #91b9bb; }
.demo-form-control {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  color: #edffff;
  font-size: 13px;
  background: rgba(18, 73, 77, 0.35);
  border: 1px solid rgba(102, 255, 255, 0.25);
  border-radius: 3px;
  outline: none;
  resize: vertical;
  transition: border-color 0.2s, box-shadow 0.2s;

  &::placeholder { color: rgba(145, 185, 187, 0.6); }
  &:focus { border-color: #66ffff; box-shadow: 0 0 10px rgba(102, 255, 255, 0.2); }
}
select.demo-form-control option { background: #0c2b30; }
.demo-form-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 6px; }
.demo-btn {
  min-width: 84px;
  height: 32px;
  padding: 0 18px;
  font-size: 13px;
  color: #bfe6e4;
  background: rgba(102, 255, 255, 0.06);
  border: 1px solid rgba(102, 255, 255, 0.35);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover { border-color: #66ffff; color: #fff; }
  &.is-primary {
    color: #06211f;
    background: linear-gradient(120deg, #86fbe7, #66ffff);
    border-color: transparent;
    font-weight: 600;
  }
}

.demo-detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.demo-detail-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid rgba(102, 255, 255, 0.16);
  background: linear-gradient(100deg, rgba(18, 73, 77, 0.6), rgba(9, 42, 52, 0.45));
}
.demo-detail-label { flex: 0 0 72px; color: #91b9bb; text-align: right; }
.demo-detail-value { color: #66ffff; font-weight: 600; }
.demo-detail-summary {
  margin-top: 16px;
  padding: 12px 14px;
  line-height: 1.8;
  color: #cfe9e7;
  border-left: 2px solid rgba(102, 255, 255, 0.5);
  background: rgba(102, 255, 255, 0.04);
}
</style>
