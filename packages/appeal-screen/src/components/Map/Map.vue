<template>
  <!-- 三维底图容器：只承载地球与底图，不含业务图层 / 弹窗 -->
  <div id="cesiumContainer" class="cesiumContainer"></div>
</template>

<script setup>
import { onMounted, onUnmounted, nextTick } from 'vue'
import 'mars3d/dist/mars3d.css'
import { useMapStore } from '@/stores/map.js'

const map = useMapStore()

onMounted(() => {
  nextTick(() => map.initializeMap())
})
onUnmounted(() => map.destroyMap())
</script>

<style scoped lang="scss">
.cesiumContainer {
  width: 100%;
  height: 110%;
  // 三维瓦片未就绪或完全离线时，用本地深色网格图兜底，保证样式始终可看
  background: url('@/assets/image/map_fallback.png') center / cover no-repeat;
}

::v-deep {
  // 地图控件按钮（视角复位 / 全屏）主题化，与楼栋搜索框同排、同行高。
  // 尺寸对齐规则（改动需与 Index.vue 的 .root-building-search-box 同步）：
  //   · 总行高统一 46px（搜索框 4px padding×2 + 38px 内容 + 1px 边框×2）
  //   · top 统一 100px，两个按钮与搜索框垂直中心一致
  //   · 行宽 510px：搜索框 400px + 空隙 12px + 按钮组 98px（43×2 + gap 12），
  //     与 Index 页 root-top-select-box 主选按钮行（4×120+3×10=510px）对齐
  //   · 圆角统一 8px（外框），内层 6px
  .cesium-viewer-toolbar,
  .cesium-viewer-fullscreenContainer {
    position: absolute;
    top: 100px !important;
    left: calc(50% + 157px) !important;
    transform: none !important;
    z-index: 1;
    height: 46px;
    display: flex;
    align-items: center;
    gap: 12px;
    // 原生 .cesium-viewer-fullscreenContainer 为 29×29 + overflow:hidden，不改会裁掉放大后的图标
    width: auto !important;
    min-width: 0 !important;
    overflow: visible !important;

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(165deg, rgba(12, 56, 52, 0.92) 0%, rgba(5, 24, 22, 0.88) 100%) !important;
      border: 1px solid rgb(54, 137, 129) !important;
      border-radius: 8px;
      box-shadow: 0 0 14px rgba(54, 137, 129, 0.35), inset 0 0 12px rgba(134, 251, 231, 0.06);
      backdrop-filter: blur(4px);
      transition: border-color 0.3s ease, box-shadow 0.3s ease;

      svg {
        display: block;
        width: 28px;
        height: 28px;
        fill: rgb(134, 251, 231);
        stroke: rgb(134, 251, 231);
      }

      &:hover {
        border-color: rgb(134, 251, 231) !important;
        box-shadow: 0 0 18px rgba(134, 251, 231, 0.3), inset 0 0 14px rgba(134, 251, 231, 0.08);

        svg {
          fill: #ffffff;
          stroke: #ffffff;
        }
      }
    }
  }

  // 若全屏按钮独立成容器（Cesium 原生结构），紧排在 toolbar 右侧 43px+12px 处
  .cesium-viewer-fullscreenContainer {
    left: calc(50% + 212px) !important;
  }
}
</style>
