<template>
  <div
      v-if="visible"
      class="modal"
      :style="{
      width: `${props.width}px`,
      height: `${props.height}px`,
      left: `${position.x}px`,
      top: `${position.y}px`,
    }"
      ref="modalRef"
  >
<!--    <div class="hr"></div>-->
    <div
        class="modal_title"
        @mousedown="startDrag"
    >
      <div class="title">
        <img src="/image/modal/right.png" style="margin-right: 15px"/>
        <div class="title_text">{{ props.title }}</div>
        <img src="/image/modal/left.png" style="margin-left: 15px"/>
      </div>
      <img class="modal_title_png no-drag" src="/image/modal/title.png" alt=""/>
      <img
          class="close_png"
          @click.stop="onClose"
          src="/image/modal/close.png"
          alt=""
      />
    </div>
    <div class="modal_content">
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
const props = defineProps({
  title: {
    type: String,
    default: '',
  },
  width: {
    type: Number,
    default: 450,
  },
  height: {
    type: Number,
    default: 320,
  },
});
const emit = defineEmits(['close']);
const modalRef = ref(null);
const position = ref({ x: 0, y: 0 });
const dragStartPos = ref({ x: 0, y: 0 });
const isDragging = ref(false);
const visible = ref(false);

// 初始化居中
onMounted(() => {
  position.value = {
    x: window.innerWidth / 2 - props.width / 2,
    y: window.innerHeight / 2 - props.height / 2,
  };
  // position.value = {
  //   x: window.innerWidth - (460 + props.width),
  //   y: 186
  // };
});

const startDrag = (e) => {
  // 排除关闭按钮
  if (e.target.closest('.close_png')) return;

  isDragging.value = true;
  dragStartPos.value = {
    x: e.clientX - position.value.x,
    y: e.clientY - position.value.y,
  };

  document.addEventListener('mousemove', dragging);
  document.addEventListener('mouseup', stopDrag);
};

const dragging = (e) => {
  if (!isDragging.value) return;
  position.value = {
    x: e.clientX - dragStartPos.value.x,
    y: e.clientY - dragStartPos.value.y,
  };
};

const stopDrag = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', dragging);
  document.removeEventListener('mouseup', stopDrag);
};

const onClose = () => {
  visible.value = false;
  emit("close");
};
const open = () => {
  visible.value = true;
};

const close = () => {
  visible.value = false;
};

defineExpose({
  open,
  close
});
</script>

<style scoped lang="scss">
.modal {
  position: fixed;
  border-radius: 8px;
  background: rgba(6,24,30,0.96);
  border: 1px solid rgba(102,255,255,0.5);
  overflow: hidden;
  pointer-events: auto;
  z-index: 100011;
  user-select: none; /* 防止拖拽时选中文本 */
}
.modal_content{
  padding:  4px 8px 8px 8px;
  overflow: hidden;
  height: calc(100% - 50px);
  color: white;
}
.hr {
  width: 100%;
  height: 6px;
  background: linear-gradient(90deg, rgba(227, 255, 240, 1) 0%, rgba(227, 255, 240, 0) 100%);
}

.modal_title {
  position: relative;
  cursor: move; /* 显示可移动光标 */
  &:active {
    cursor: grabbing; /* 拖拽时显示抓取光标 */
  }
}
.title{
  left: 50%;
  top: 50%;
  transform: translate(-50%,-50%);
  position: absolute;
  display: flex;
}
.title_text {
  font-size: 18px;
  color: white;
  font-weight: 500;
}

.modal_title_png {
  width: 100%;
  height: 50px;
}

.close_png {
  width: 20px;
  height: 20px;
  position: absolute;
  top: 12px;
  right: 12px;
  cursor: pointer;
  pointer-events: auto; /* 确保点击事件有效 */
  &:hover {
    filter: brightness(1.2); /* 悬停反馈 */
  }
}
</style>
