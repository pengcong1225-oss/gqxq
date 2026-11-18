<script setup lang="ts">
/**
 * 大屏内联三维白模（验收大屏 `#/accept` 唯一地图视图）
 *
 * 客户原话「白膜为啥和大屏分开了」→ 本组件把 `#/cim3d` 的三维白模**内联**到验收大屏的同一块地图区域里，
 * 不跳页、不新开窗口；统计卡片仍浮在三维画面之上照常显示。
 *
 * 2026-11-16：验收大屏已按客户要求「只保留 3D 不要二维」，本组件成为唯一地图视图；
 * 并新增 `points` prop（父级可传真实小区点位），watch 响应式重绘点位标签，修复“点位数据晚到不显示”的 bug。
 *
 * 复用（不重写）`src/screen/cim3d/**`：
 *  - `cesiumEngine.ts`：license.json / login.json 本地伪造拦截器、引擎按需加载（平台优先 + 本地回退）、
 *    Viewer 创建、相机定位、S3M 白模图层（`datas/<scene>/config` → `addS3MTilesLayerByScp`）、真实瓦片统计；
 *  - `scenes.ts`：10 个区县场景清单、`datas/<scene>/config` 取数与 geoBounds。
 *
 * 生命周期（防 WebGL 上下文泄漏 / 内存涨）：
 *  - onMounted 等两帧布局后建 viewer；onBeforeUnmount 里 `viewer.destroy()` + 清空容器 + 断开 ResizeObserver；
 *  - 容器尺寸变化 / 窗口 resize 时主动 `resize()`（此前探针踩过画布停在 300×150 的坑）。
 *
 * 三条硬规则：不伪造三维几何、token 只由 `/cim` 代理服务端注入、失败必须可解释。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CIM_SCENES, REALS_PACE, datasetConfigUrl, fetchDatasetConfig, findScene, type Bounds } from './cim3d/scenes';
import {
  addStitchedBasemap,
  addWmtsBasemapNative,
  addWhiteModelLayer,
  applyImageryTuning,
  basemapTileStats,
  createViewer,
  fetchDatasetList,
  fetchWmtsCapabilities,
  frameBounds,
  inspectEngine,
  loadCesium,
  pickS3MAttributes,
  probeWmtsMultiLevel,
  readS3MSchema,
  readWmtsConfig,
  removeAllS3MLayers,
  resetS3mTileStats,
  s3mTileStats,
  WMTS_SERVICE_BOUNDS,
  type BasemapResult,
  type LonLatBounds,
  type PickAttempt,
  type S3MSchema,
  type ViewerHandles,
} from './cim3d/cesiumEngine';
import { realCommunityPoints } from '@/stats/realSource';

export interface Inline3dStatus {
  phase: 'boot' | 'loading' | 'ready' | 'error';
  /** 状态条主文案（按真实请求结果写） */
  text: string;
  /** 明细：失败原因 / 引擎 / 场景 / 瓦片 */
  detail: string;
  engine: string;
  scenes: number;
  tiles: number;
  canvas: string;
  /** 底图方案（真实结果；off/失败都要能看见原因） */
  basemap: string;
  /** 底图一句话摘要（3D 小状态卡「底图」行用，含调色生效值） */
  basemapShort: string;
  /** 底图诊断：cim.json 读到什么 + 走了哪个分支（浮层里看） */
  basemapDiag: string;
  /** S3M 楼栋属性核查结论 */
  schema: string;
  /** 底图调色生效值（客户要求：3D 影像不要发白发灰） */
  tuning: string;
  /** 小区三维点位加载情况（3D 小状态卡「小区点位」行用） */
  community: string;
}

/** 父级可传入的小区点位（真实库 spatial.communities；抖动坐标，仅近似定位） */
export interface Inline3dPoint {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  gridId?: string;
}

const props = withDefaults(
  defineProps<{
    scene?: string;
    basemap?: boolean | 'proxy' | 'native' | 'stitch' | 'arcgis' | 'off';
    hideCommunity?: boolean;
    /** 响应式小区点位：传入后 watch 自动重绘；为空时用 realCommunityPoints() 兜底 */
    points?: Inline3dPoint[];
  }>(),
  {
    scene: 'chengqu_jitter',
    basemap: 'proxy',
    hideCommunity: false,
    points: () => [],
  }
);

const emit = defineEmits<{
  (e: 'status', payload: Inline3dStatus): void;
  (e: 'pick', payload: PickAttempt): void;
}>();

const container = ref<HTMLDivElement | null>(null);
/**
 * 3D 影像默认调色（客户 2026-11-13 反馈：3D 影像发白发灰，二供屏偏暗更自然）
 * 仍可用 URL 覆盖：?bmBrightness=&bmContrast=&bmSaturation=&bmGamma=
 */
const DEFAULT_TUNING = { brightness: 0.92, contrast: 1.12, saturation: 1.12, gamma: 0.85 } as const;

const status = ref<Inline3dStatus>({
  phase: 'boot',
  text: '三维引擎加载中…',
  detail: '',
  engine: '',
  scenes: 0,
  tiles: 0,
  canvas: '',
  basemap: '检测中…',
  basemapShort: '检测中…',
  basemapDiag: '未开始',
  schema: '检测中…',
  tuning: '未生效（底图未加载）',
  community: '未上报',
});

let disposed = false;
let Cesium: any = null;
let viewer: any = null;
let handles: ViewerHandles | null = null;
let bounds: Bounds | null = null;
let ro: ResizeObserver | null = null;
let resizeTimer: number | null = null;
/** 已加载的 S3M 图层（拾取用） */
let s3mLayers: any[] = [];
let pickBinding: { destroy: () => void } | null = null;
/** viewer 未就绪时暂存的小区点位（等 ready 后补绘） */
let pendingCommunity: Inline3dPoint[] | null = null;

function setStatus(patch: Partial<Inline3dStatus>) {
  status.value = { ...status.value, ...patch };
  const el = document.documentElement;
  el.dataset.inline3dState = status.value.phase;
  el.dataset.inline3dCanvas = status.value.canvas;
  el.dataset.inline3dTiles = String(status.value.tiles);
  emit('status', status.value);
}

function currentCanvasSize(): string {
  const canvas = container.value?.querySelector('canvas') as HTMLCanvasElement | null;
  return canvas ? `${canvas.width}x${canvas.height}` : 'none';
}

/** 主动 resize（viewer 就绪后；容器尺寸变化 / window resize 都会触发） */
function resizeViewer() {
  if (disposed || !viewer) return;
  const el = container.value;
  if (!el || !el.clientWidth || !el.clientHeight) return;
  try {
    if (typeof viewer.resize === 'function') viewer.resize();
    else if (viewer.cesiumWidget && typeof viewer.cesiumWidget.resize === 'function') viewer.cesiumWidget.resize();
    else window.dispatchEvent(new Event('resize'));
  } catch {
    /* 忽略：引擎不支持主动 resize 时靠 window resize 兜底 */
  }
  const size = currentCanvasSize();
  if (size !== status.value.canvas) {
    setStatus({ canvas: size });
  }
}

function scheduleResize() {
  if (resizeTimer != null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    resizeViewer();
  }, 160);
}

/** 区县场景选择：all = 全部区县；否则单场景（不存在的场景名回退城区） */
function sceneTargets(names: string[]): string[] {
  if (props.scene === 'all') return CIM_SCENES.filter((s) => names.includes(s.key)).map((s) => s.key);
  const key = findScene(props.scene) ? props.scene : 'chengqu_jitter';
  return names.includes(key) ? [key] : [];
}

/** 多场景 geoBounds 合并 */
function unionOfBounds(list: (Bounds | null)[]): Bounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const b of list) {
    if (!b) continue;
    west = Math.min(west, b.west);
    south = Math.min(south, b.south);
    east = Math.max(east, b.east);
    north = Math.max(north, b.north);
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/** 相机复位到当前场景范围 */
function resetView() {
  if (!Cesium || !viewer || !bounds) return;
  if (props.scene === 'all') frameBounds(Cesium, viewer, bounds, 78_000, -85);
  else frameBounds(Cesium, viewer, bounds, undefined, -50);
}

/** 验收大屏底部「相机复位」按钮调用（语义化别名；实际复用 resetView） */
function resetCamera() {
  resetView();
}

/** 相机飞向单点（经纬度）；viewer 未就绪返回 false */
function flyToLonLat(lon: number, lat: number, altitude = 2600): boolean {
  if (!viewer || !Cesium?.Cartesian3) return false;
  try {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(600, Math.min(20_000, altitude))),
      orientation: { heading: Cesium.Math.toRadians(0), pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 1.4,
    });
    return true;
  } catch {
    return false;
  }
}

/** 相机框选一组点（小区/网格/区县批量定位）；viewer 未就绪返回 false */
function flyToPoints(points: { longitude: number; latitude: number }[], altitude = 2600): boolean {
  if (!points.length) return false;
  const lon = points.reduce((a, p) => a + p.longitude, 0) / points.length;
  const lat = points.reduce((a, p) => a + p.latitude, 0) / points.length;
  const spanLon = Math.max(...points.map((p) => p.longitude)) - Math.min(...points.map((p) => p.longitude));
  const spanLat = Math.max(...points.map((p) => p.latitude)) - Math.min(...points.map((p) => p.latitude));
  const span = Math.max(spanLon, spanLat);
  const altitudeFit = Math.min(20_000, Math.max(altitude, span * 111_000 * 2.2));
  return flyToLonLat(lon, lat, altitudeFit);
}

/* ------------------------------------------------------------ 小区点位（响应式重绘） */

interface NormalizedPoint {
  communityId: string;
  name: string;
  jitter: { longitude: number; latitude: number };
  offsetMeters: number | null;
}

function normalizePoints(list: (Inline3dPoint | NormalizedPoint)[]): NormalizedPoint[] {
  return list
    .map((raw: any) => {
      const lon = Number(raw?.longitude ?? raw?.jitter?.longitude);
      const lat = Number(raw?.latitude ?? raw?.jitter?.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return {
        communityId: String(raw.communityId ?? raw.id ?? ''),
        name: String(raw.name ?? raw.id ?? ''),
        jitter: { longitude: lon, latitude: lat },
        offsetMeters: typeof raw.offsetMeters === 'number' ? raw.offsetMeters : null,
      } as NormalizedPoint;
    })
    .filter((p): p is NormalizedPoint => !!p);
}

/** 当前数据源：props.points 优先；为空则用真实缓存 realCommunityPoints() 兜底 */
function resolveCommunityPoints(list?: Inline3dPoint[] | null): NormalizedPoint[] {
  const fromProps = normalizePoints((list ?? props.points ?? []) as any[]);
  if (fromProps.length) return fromProps;
  return normalizePoints(realCommunityPoints() as any[]);
}

/** 小区点位绘制时的额外视觉偏移（米）；0 = 严格使用后端抖动坐标，不做二次偏移 */
const POINT_DX = 0;
const POINT_DY = 0;

/**
 * 绘制/重绘小区点位：
 *  - viewer 未就绪时只缓存 pending，等 boot ready 后补绘；
 *  - 每次重绘会先清除旧 community 实体，避免重复叠加；
 *  - 返回用于状态卡的小区点位文案。
 */
function drawCommunities(list?: Inline3dPoint[] | null): string {
  if (props.hideCommunity) {
    pendingCommunity = [];
    const text = '已关闭（不落点）';
    if (viewer) setStatus({ community: text });
    return text;
  }
  const points = resolveCommunityPoints(list);
  if (!Cesium || !viewer?.entities) {
    pendingCommunity = (list ?? props.points ?? []) as Inline3dPoint[];
    return status.value.community;
  }
  // 清除上一批社区实体（不影响白模楼栋）
  for (const ent of [...viewer.entities.values]) {
    if ((ent as any).communityData) viewer.entities.remove(ent);
  }
  let added = 0;
  for (const c of points) {
    const ent = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(c.jitter.longitude + POINT_DX / (111320 * Math.cos((c.jitter.latitude * Math.PI) / 180)), c.jitter.latitude + POINT_DY / 110540, 30),
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString('#86fbe7'),
        outlineColor: Cesium.Color.fromCssColorString('#062a26'),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference?.NONE,
      },
      label: {
        text: c.name,
        font: '12px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#d6f6ef'),
        outlineColor: Cesium.Color.fromCssColorString('#04141a'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { communityId: c.communityId, kind: 'community', offsetMeters: c.offsetMeters },
    });
    ent.communityData = c;
    added += 1;
  }
  let text = `${added}/${points.length} 个（平台抖动偏移 —，近似位置）`;
  if (!points.length) text = '未加载（props.points 与真实缓存均为空）';
  else if (!added) text = `0/${points.length} 个（抖动均未成功，不落点）`;
  pendingCommunity = null;
  setStatus({ community: text });
  return text;
}

/** 响应式：父级传入 points 变化（例如真实 bootstrap 晚到）立即重绘 */
watch(
  () => props.points,
  (list) => {
    drawCommunities(list as Inline3dPoint[]);
  },
  { immediate: true, deep: true }
);

/* ------------------------------------------------------------ 启动 / 状态 */

async function boot() {
  const startedAt = performance.now();
  try {
    setStatus({ phase: 'boot', text: '三维引擎按需加载（超图 Cesium / S3M）…' });
    Cesium = await loadCesium();
    if (disposed) return;
    const caps = inspectEngine(Cesium);
    const engineBase = String((window as any).__CIM3D_ENGINE_BASE__ || '');
    const engineFrom = engineBase.includes('irs-cesium-preview') ? '平台引擎' : '本地 1.67';
    const engineText = `Cesium ${caps.version} · ${engineFrom}`;
    if (!caps.webgl) throw new Error('当前浏览器/环境未启用 WebGL，无法创建三维场景（headless 请加 --enable-unsafe-swiftshader）');
    if (!caps.s3m) throw new Error('分发包缺少 Scene.addS3MTilesLayerByScp，无法加载 S3M 白模');

    const el = container.value;
    if (!el) throw new Error('三维容器未挂载');
    handles = createViewer(Cesium, el);
    viewer = handles.viewer;
    resizeViewer();
    setStatus({ phase: 'loading', text: '白模场景与数据集配置加载中…', engine: engineText });

    /* ---------- 场景清单 + geoBounds ---------- */
    const datasetList = await fetchDatasetList(REALS_PACE);
    if (disposed) return;
    const targets = sceneTargets(datasetList.names);
    if (!targets.length) {
      throw new Error(`场景清单 ${datasetList.names.length} 个数据集中没有目标区县（${props.scene}）`);
    }
    const targetInfos = await Promise.all(
      targets.map(async (key) => {
        try {
          const cfg = await fetchDatasetConfig(key);
          const g = cfg.geoBounds;
          const b =
            g && [g.left, g.right, g.bottom, g.top].every((v) => Number.isFinite(v))
              ? { west: g.left, south: g.bottom, east: g.right, north: g.top }
              : null;
          return { key, bounds: b, tiles: Array.isArray(cfg.tiles) ? cfg.tiles.length : 0, error: '' };
        } catch (e) {
          return { key, bounds: null, tiles: 0, error: (e as Error)?.message ?? String(e) };
        }
      })
    );
    if (disposed) return;
    const framedBounds = unionOfBounds(targetInfos.map((t) => t.bounds));
    if (!framedBounds) throw new Error('目标区县都没有取到 geoBounds，无法定位相机');

    bounds = framedBounds;
    resetView();
    removeAllS3MLayers(viewer);
    resetS3mTileStats();

    /* ---------- S3M 白模（逐场景加载；失败重试一次；仍失败则如实报错） ---------- */
    const loadedKeys: string[] = [];
    const failures: { key: string; reason: string }[] = [];
    const loadOne = async (key: string) => {
      const result = await addWhiteModelLayer(Cesium, viewer, key, datasetConfigUrl(key));
      if (result?.layer) s3mLayers.push(result.layer);
      loadedKeys.push(key);
    };
    for (const key of targets) {
      try {
        await loadOne(key);
      } catch (e) {
        failures.push({ key, reason: (e as Error)?.message ?? String(e) });
      }
    }
    if (failures.length) {
      const retry = failures.splice(0, failures.length);
      for (const item of retry) {
        try {
          await loadOne(item.key);
        } catch (e) {
          failures.push({ key: item.key, reason: (e as Error)?.message ?? String(e) });
        }
      }
    }
    // 给 S3M 瓦片一点时间发起/完成请求，再统计真实 loaded 数
    await new Promise<void>((resolve) => window.setTimeout(resolve, 2600));
    if (disposed) return;
    const tileLoaded = s3mTileStats.loaded;
    const tileConfigured = targetInfos.reduce((a, t) => a + t.tiles, 0);
    if (!loadedKeys.length) {
      const first = failures[0];
      throw new Error(`白模图层加载失败：${first?.reason ?? '未知原因'}`);
    }
    const sceneLabel =
      targets.length === 1 ? (findScene(targets[0])?.district ?? targets[0]) : `${targets.length} 个区县`;

    /* ---------- 底图（native / stitch / arcgis / off） ---------- */
    const urlQuery = location.hash.includes('?')
      ? location.hash.slice(location.hash.indexOf('?') + 1)
      : location.search.replace(/^\?/, '');
    const params = new URLSearchParams(urlQuery);
    const basemapArg = params.get('basemap');
const basemapMode: 'proxy' | 'native' | 'stitch' | 'arcgis' | 'off' =
      props.basemap === false || props.basemap === 'off' || basemapArg === 'off'
        ? 'off'
        : props.basemap === 'stitch' || basemapArg === 'stitch'
          ? 'stitch'
          : props.basemap === 'native' || basemapArg === 'native'
            ? 'native'
            : props.basemap === 'arcgis' || basemapArg === 'arcgis'
              ? 'arcgis'
              : 'proxy';
    const nativeStrict = props.basemap === 'native' || basemapArg === 'native';
        const arcgisTemplate = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const useArcgis = props.basemap === 'arcgis' || basemapArg === 'arcgis';

    let basemapText = '未请求';
    let basemapShort = '未请求';
    let tuningText = '未应用（底图未加载）';
    let basemapDiag = `分支待定 · mode=${basemapMode} · strict=${nativeStrict}`;

    if (basemapMode === 'off') {
      basemapText = '底图已关闭（?basemap=off）';
      basemapShort = '已关闭（?basemap=off）';
      basemapDiag = '分支=skip（?basemap=off 主动关闭）';
    } else {
      try {
        // cim.json 原始读取诊断（与 dist 文案一致，便于定位配置问题）
        let rawStatus = 0;
        let rawText = '';
        try {
          const raw = await fetch('/config/cim.json', { headers: { Accept: 'application/json' }, cache: 'no-store' });
          rawStatus = raw.status;
          rawText = raw.ok ? await raw.text() : '';
        } catch (e) {
          rawStatus = -1;
          rawText = `fetch 异常：${(e as Error)?.message ?? e}`;
        }
        let rawWmts: any = null;
        try {
          rawWmts = rawText ? (JSON.parse(rawText) as any)?.wmts : null;
        } catch {
          rawWmts = null;
        }
        const cimDiag =
          `cim.json HTTP ${rawStatus}` +
          (rawWmts
            ? ` · wmts.url=${String(rawWmts.url ?? '（空）').slice(0, 90)} · status=${String(rawWmts.status ?? '（无）')} · layer=${String(rawWmts.layer ?? '（空）')}`
            : ` · wmts=${rawText ? '解析失败/无 wmts 字段' : '内容为空'}`);

        const cfg = await readWmtsConfig();
        if (!cfg) {
          basemapText = '底图未配置（cim.json 无 WMTS 或字段不全）';
          basemapShort = '底图未配置';
          basemapDiag = `分支=skip（readWmtsConfig 返回 null）· ${cimDiag}`;
} else if (basemapMode === 'proxy') {
          // 第三方 WMTS 网关（同一图层 yichang20260922_0d5）：WebMercator 标准网格，tilematrix=层级
          // 经 vite /cimtile 同源代理转发（原网关无 CORS 头，浏览器直连会被拦）
          try {
            const provider = new (Cesium as any).WebMapTileServiceImageryProvider({
              url: '/cimtile',
              layer: 'yichang20260922_0d5',
              style: 'default',
              tileMatrixSetID: 'default',
              format: 'image/jpgpng',
              // 实测网关 tilematrix 比 Cesium Geographic 层级大 1（z15↔Cesium L14），用 labels 做映射
              tilingScheme: new (Cesium as any).GeographicTilingScheme(),
              tileMatrixLabels: Array.from({ length: 20 }, (_, i) => String(i + 1)),
              minimumLevel: 7,
              maximumLevel: 18,
              credit: 'CIM 影像（第三方网关代理）',
            });
            viewer.imageryLayers.addImageryProvider(provider);
            viewer.imageryLayers.lowerToBottom(viewer.imageryLayers.get(0));
            basemapText = '底图：CIM 0.5 米影像（第三方网关代理 · Geographic · L8–L18）';
            basemapShort = 'CIM 影像（第三方网关代理）';
            basemapDiag += ' · 分支=proxy · WebMapTileServiceImageryProvider 已挂载 · tileMatrixLabels+1';
          } catch (eProxy) {
            const msg = (eProxy as Error)?.message ?? String(eProxy);
            basemapText = `底图：代理影像失败（${msg}）`;
            basemapShort = '代理影像失败';
            basemapDiag += ` · 分支=proxy · 异常=${msg}`;
          }
        } else if (basemapMode === 'arcgis') {
          try {
            const provider = new Cesium.UrlTemplateImageryProvider({
              url: arcgisTemplate,
              maximumLevel: 19,
              credit: 'Esri World Imagery',
            });
            viewer.imageryLayers.addImageryProvider(provider);
            viewer.imageryLayers.lowerToBottom(viewer.imageryLayers.get(0));
            basemapText = '底图：ArcGIS World Imagery（公网 XYZ，无密钥）';
            basemapShort = 'ArcGIS World Imagery';
            basemapDiag += ' · 分支=arcgis · UrlTemplateImageryProvider 已挂载';
          } catch (eArc) {
            basemapText = `底图：ArcGIS 影像失败（${(eArc as Error)?.message ?? eArc}）`;
            basemapShort = 'ArcGIS 影像失败';
            basemapDiag += ` · 分支=arcgis · 异常=${(eArc as Error)?.message ?? eArc}`;
          }
        } else if (basemapMode === 'stitch') {
          basemapDiag = `分支=stitch（强制）· ${cimDiag}`;
          const result: BasemapResult = await addStitchedBasemap(Cesium, viewer, cfg, bounds, 8);
          basemapText =
            `底图：拼接影像（?basemap=stitch 强制）· z${result.level} · ${result.tiles} 张` +
            (result.failures ? `（失败 ${result.failures}）` : '');
          basemapShort = `拼接影像 · z${result.level} · ${result.tiles} 张`;
          tuningText = '未应用（拼接影像未走调色）';
        } else {
          basemapDiag =
            `分支=native · ${cimDiag} · GeographicTilingScheme=${typeof Cesium.GeographicTilingScheme}` +
            ` · Provider=${typeof Cesium.WebMapTileServiceImageryProvider} · imageryLayers=${typeof viewer?.imageryLayers?.addImageryProvider}`;
          let capsText = '（未取）';
          try {
            const caps = await fetchWmtsCapabilities(cfg);
            capsText = `${caps.bytes}B · crs=${caps.crs} · 矩阵 ${caps.matrices.length} 个 · set=${caps.matrixSet}`;
          } catch (eCaps) {
            capsText = `失败：${(eCaps as Error)?.message ?? String(eCaps)}`;
          }
          try {
            const nativeResult = await addWmtsBasemapNative(Cesium, viewer, cfg, bounds ?? WMTS_SERVICE_BOUNDS);
            const tuning = applyImageryTuning(viewer, {
              brightness: Number(params.get('bmBrightness') ?? DEFAULT_TUNING.brightness),
              contrast: Number(params.get('bmContrast') ?? DEFAULT_TUNING.contrast),
              saturation: Number(params.get('bmSaturation') ?? DEFAULT_TUNING.saturation),
              gamma: Number(params.get('bmGamma') ?? DEFAULT_TUNING.gamma),
            });
            const tuningShort = `${tuning.brightness}/${tuning.contrast}/${tuning.saturation}/${tuning.gamma}`;
            tuningText = `亮 ${tuning.brightness} · 对比 ${tuning.contrast} · 饱和 ${tuning.saturation} · Gamma ${tuning.gamma}`;
            basemapShort = `native WMTS · Cesium L${nativeResult.cesiumLevels[0]}–L${nativeResult.cesiumLevels[1]} · 调色 ${tuningShort}`;
            const probe = await probeWmtsMultiLevel(cfg);
            basemapText =
              `底图：native WMTS · Geographic · Cesium L${nativeResult.cesiumLevels[0]}–L${nativeResult.cesiumLevels[1]}` +
              `（服务 TileMatrix ${nativeResult.serviceLevels[0]}–${nativeResult.serviceLevels[1]}，偏移 ${nativeResult.offset}）` +
              ` · rect 跟随场景 · 探测 ${probe.map((p) => `${p.name} = ${p.status}/${p.bytes}B`).join(' · ')}` +
              ` · 失败瓦片 ${basemapTileStats.failed}`;
            basemapDiag +=
              ` · caps 诊断：${capsText} · rectangle ${nativeResult.rectangle.west.toFixed(4)},${nativeResult.rectangle.south.toFixed(4)}` +
              `~${nativeResult.rectangle.east.toFixed(4)},${nativeResult.rectangle.north.toFixed(4)}` +
              ` · 调色 b=${tuning.brightness} c=${tuning.contrast} s=${tuning.saturation} g=${tuning.gamma}` +
              (basemapTileStats.firstUrl ? ` · 首个失败瓦片 ${basemapTileStats.firstUrl}` : '');
          } catch (eNative) {
            const reason = (eNative as Error)?.message ?? String(eNative);
            basemapDiag += ` · native 异常=${reason}`;
            console.warn('[inline3d] native WMTS 底图失败：', eNative);
            if (nativeStrict) {
              basemapText = `底图：native WMTS 失败（${reason}）· 未回退（?basemap=native 强制）`;
              basemapShort = 'native WMTS 失败（未回退）';
              tuningText = '未生效（底图加载失败）';
            } else {
              const result: BasemapResult = await addStitchedBasemap(Cesium, viewer, cfg, bounds, 8);
              basemapText =
                `底图：拼接影像（native 失败：${reason}）· z${result.level} · ${result.tiles} 张` +
                (result.failures ? `（失败 ${result.failures}）` : '');
              basemapShort = `拼接影像（native 失败）· z${result.level} · ${result.tiles} 张`;
              tuningText = '未应用（回退拼接影像）';
            }
          }
        }
      } catch (e) {
        basemapText = `底图失败：${(e as Error)?.message ?? e}（已回退无影像，未伪造）`;
        basemapShort = '底图失败（未伪造影像）';
        tuningText = '未生效（底图加载失败）';
      }
    }

    /* ---------- 底图自检（?basemapprobe=1） ---------- */
    if (params.get('basemapprobe') === '1') {
      try {
        const list = await probeWmtsMultiLevel({
          url: '/cim/api/restapi/prod/IC42050020261004000001/tip-gateway/proxy/74d67b414b5b77f8b72ceb8af1047500/server/rest/services/yichang20260922_0d5/MapServer/WMTS',
          layer: 'yichang20260922_0d5',
        } as any);
        const text = list.map((p) => `${p.name} → HTTP ${p.status}/${p.bytes}B`).join(' · ');
        document.documentElement.dataset.basemapProbe = text;
        basemapText += ` · 自检 ${text}`;
      } catch (e) {
        const text = `自检异常：${(e as Error)?.message ?? e}`;
        document.documentElement.dataset.basemapProbe = text;
        basemapText += ` · ${text}`;
      }
    }
    if (disposed) return;

    /* ---------- S3M 楼栋属性核查 ---------- */
    let schemaText = '未取到属性定义';
    let schema: S3MSchema | null = null;
    try {
      schema = await readS3MSchema(targets[0]);
      if (schema) {
        schemaText =
          `S3M 含楼栋属性：${schema.count.toLocaleString()} 个构件 · ` +
          `关键字段 ${schema.highlights.map((h) => h.label).join('/')}（共 ${schema.fields.length} 字段）`;
      }
    } catch {
      /* 保持默认文案 */
    }
    if (disposed) return;

    /* ---------- 小区点位（props.points 优先，真实缓存兜底；数据晚到由 watch 重绘） ---------- */
    const communityText = drawCommunities((pendingCommunity as any) ?? props.points);

    /* ---------- 点击拾取：先判小区实体，再判白模构件 → 楼栋属性 ---------- */
    pickBinding?.destroy();
    const pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    pickHandler.setInputAction((movement: any) => {
      const pos = movement?.position;
      if (!pos) return;
      let picked: any = null;
      try {
        picked = viewer.scene.pick(pos);
      } catch {
        picked = null;
      }
      const ent = picked?.id;
      const cd = ent?.communityData;
      if (cd) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(cd.jitter.longitude, cd.jitter.latitude, 1200),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
          duration: 1.2,
        });
        emit('pick', {
          id: cd.communityId,
          attributes: {
            fwjzmc: `${cd.name}（三维抖动坐标 · 近似位置）`,
            tybzdz: `偏移 ${cd.offsetMeters}m · 平台脱敏偏移坐标，仅作近似定位`,
          },
          reason: '',
          shape: 'community-entity',
        } as PickAttempt);
        return;
      }
      void pickS3MAttributes(Cesium, viewer, s3mLayers, { x: pos.x, y: pos.y }).then((a) => emit('pick', a));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    pickBinding = {
      destroy: () => {
        try {
          pickHandler.destroy();
        } catch {
          /* 忽略 */
        }
      },
    };

    setStatus({
      phase: 'ready',
      text: `白模已渲染（${sceneLabel} · ${loadedKeys.length} 个场景 / ${tileLoaded} 片瓦片）`,
      detail: [
        `引擎 ${engineText}`,
        `配置瓦片 ${tileConfigured} 片 · 已加载 ${tileLoaded} 片`,
        `画布 ${currentCanvasSize()} · 耗时 ${Math.round(performance.now() - startedAt)}ms`,
        failures.length ? `失败：${failures.map((f) => f.key).join(',')}` : '',
        communityText,
      ]
        .filter(Boolean)
        .join(' · '),
      engine: engineText,
      scenes: loadedKeys.length,
      tiles: tileLoaded,
      canvas: currentCanvasSize(),
      basemap: basemapText,
      basemapShort,
      basemapDiag,
      schema: schemaText,
      tuning: tuningText,
      community: communityText,
    });
    (window as any).__INLINE3D__ = { Cesium, viewer, scene: targets[0], tiles: tileLoaded, layers: s3mLayers, schema };

    /* ---------- 楼栋拾取自检（?pickprobe=1） ---------- */
    if (params.get('pickprobe') === '1') {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
      const canvas = container.value?.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas && !disposed) {
        const attempt = await pickS3MAttributes(Cesium, viewer, s3mLayers, {
          x: canvas.width / 2,
          y: canvas.height / 2,
        });
        document.documentElement.dataset.inline3dPick = JSON.stringify(attempt).slice(0, 400);
        emit('pick', attempt);
      }
    }
    document.documentElement.dataset.inline3dCreated = String(
      Number(document.documentElement.dataset.inline3dCreated ?? '0') + 1
    );
  } catch (e) {
    if (disposed) return;
    const message = (e as Error)?.message ?? String(e);
    setStatus({
      phase: 'error',
      text: `白模加载失败：${message}`,
      detail: `${status.value.engine ? `引擎 ${status.value.engine} · ` : ''}` +
        `${(e as Error)?.stack?.split('\n').slice(0, 2).join(' ') ?? ''}`.slice(0, 400),
      canvas: currentCanvasSize(),
      basemap: '底图未执行（白模加载失败）',
      basemapShort: '底图未执行（白模加载失败）',
      basemapDiag: '白模加载在底图之前失败，底图分支未执行',
      tuning: '未应用（底图未加载）',
      community: '未上报',
    });
  }
}

onMounted(async () => {
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (disposed) return;
  ro = new ResizeObserver(() => scheduleResize());
  if (container.value) ro.observe(container.value);
  window.addEventListener('resize', scheduleResize);
  await boot();
});

onBeforeUnmount(() => {
  disposed = true;
  if (resizeTimer != null) window.clearTimeout(resizeTimer);
  resizeTimer = null;
  window.removeEventListener('resize', scheduleResize);
  ro?.disconnect();
  ro = null;
  try {
    handles?.destroy();
  } catch {
    /* 忽略 */
  }
  handles = null;
  pickBinding?.destroy();
  pickBinding = null;
  s3mLayers = [];
  viewer = null;
  Cesium = null;
  try {
    container.value?.replaceChildren();
  } catch {
    /* 忽略 */
  }
  (window as any).__INLINE3D__ = null;
  document.documentElement.dataset.inline3dState = 'destroyed';
  document.documentElement.dataset.inline3dCanvas = 'none';
  document.documentElement.dataset.inline3dDestroyed = String(
    Number(document.documentElement.dataset.inline3dDestroyed ?? '0') + 1
  );
});

defineExpose({ resetView, resetCamera, resize: resizeViewer, status, flyToLonLat, flyToPoints });
</script>

<template>
  <div class="inline3d">
    <div ref="container" class="inline3d__stage" />
  </div>
</template>

<style scoped>
.inline3d {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  background: radial-gradient(circle at 50% 42%, #0b2438 0%, #04101a 72%);
}
.inline3d__stage {
  position: absolute;
  inset: 0;
}
.inline3d__stage :deep(.cesium-viewer),
.inline3d__stage :deep(.cesium-widget),
.inline3d__stage :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
}
.inline3d__stage :deep(.cesium-viewer-bottom),
.inline3d__stage :deep(.cesium-widget-credits) {
  display: none !important;
}
</style>

