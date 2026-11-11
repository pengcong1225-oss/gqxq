/**
 * 三维底图（框架版）
 *
 * 只做一件事：创建 Cesium / mars3d 三维地球并加载一张底图。
 * 不含任何业务图层、点位、弹窗、拾取事件和接口请求。
 *
 * 接入新项目时：
 *   1) 改 scene.center 为项目所在区域；
 *   2) 把 basemaps 第一项换成自己的 WMTS / 超图 / XYZ 服务（配置示例见文件末尾注释）；
 *   3) 需要切换底图时把 control.baseLayerPicker 打开。
 */
import { defineStore } from 'pinia'
import * as mars3d from 'mars3d'

const mapConfig = {
  scene: {
    center: { lat: 30.660314, lng: 111.286864, alt: 1796.1, heading: 1.6, pitch: -21.4 },
    scene3DOnly: false,
    shadows: false,
    removeDblClick: true,
    sceneMode: 3,
    contextOptions: { webgl: { alpha: true } },
    showSun: true,
    showMoon: true,
    showSkyBox: true,
    showSkyAtmosphere: true,
    fog: true,
    fxaa: true,
    requestRenderMode: false,
    globe: {
      depthTestAgainstTerrain: false,
      baseColor: 'rgba(255, 255, 255, 1)',
      showGroundAtmosphere: true,
      enableLighting: false,
    },
    cameraController: {
      zoomFactor: 3.0,
      minimumZoomDistance: 1,
      maximumZoomDistance: 50000000,
      enableRotate: true,
      enableTranslate: true,
      enableTilt: true,
      enableZoom: true,
      enableCollisionDetection: true,
      minimumCollisionTerrainHeight: 15000,
    },
  },
  control: {
    baseLayerPicker: false, // 底图切换按钮（Cesium 原生控件）
    fullscreenButton: true, // 全屏按钮，样式见 Map.vue
    sceneModePicker: false,
    homeButton: true, // 视角复位按钮，样式见 Map.vue
  },
  basemaps: [
    {
      // 公网 XYZ 影像：无需密钥、无需后端代理，开箱即用
      name: '影像底图',
      type: 'xyz',
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      enablePickFeatures: false,
      show: true,
    },
    {
      name: '天地图影像',
      type: 'group',
      layers: [
        { name: '底图', type: 'tdt', layer: 'img_d' },
        { name: '注记', type: 'tdt', layer: 'img_z' },
      ],
    },
  ],
}

export const useMapStore = defineStore('map', {
  state: () => ({
    ready: false,
  }),
  actions: {
    initializeMap() {
      if (window.MAP) return window.MAP
      window.MAP = new mars3d.Map('cesiumContainer', mapConfig)
      this.ready = true
      return window.MAP
    },
    destroyMap() {
      if (window.MAP) {
        window.MAP.destroy?.()
        window.MAP = null
      }
      this.ready = false
    },
  },
})

/*
 * 换成项目自有内网 WMTS 底图时，把 basemaps 第一项替换为（示例）：
 * {
 *   name: '项目影像',
 *   type: 'wmts',
 *   url: `${import.meta.env.VITE_WMTS_BASE}/map/wmts/tile`,
 *   layer: 'your_layer_name',
 *   crs: mars3d.CRS.EPSG4490,
 *   tileMatrixSetID: 'default',
 *   getCapabilities: false,
 *   show: true,
 * }
 * 并在 vite.config.js 的 server.proxy 里配置对应转发。
 */
