/**
 * 超图版 Cesium（SuperMap iClient3D for WebGL 分发包）按需加载 + 场景装配。
 *
 * 设计要点：
 *  - **不进主 bundle**：引擎放在 `public/lib/Cesium/`（`Cesium.js` 5.4 MB + Workers/Assets/Widgets/ThirdParty），
 *    只有进入 `#/cim3d` 时才用动态 `<script>` 拉取；主屏（`#/accept`）首屏不付这个代价。
 *  - `window.CESIUM_BASE_URL` 必须在脚本执行前设置，否则 Workers/Assets 会 404。
 *  - **license.json / login.json 本地伪造**（照抄宜昌平台自己的预览页 `irs-cesium-preview/previewV4.html`）：
 *    IRS 网关后面这两个元数据地址访问不到（实测 404），但引擎加载 S3M 前一定会先请求它们。
 *    平台预览页的注释原文：「license.json / login.json 在本地伪造：IRS 代理后这两个地址访问不到，
 *    但引擎加载 S3M 前一定会先请求它。」真实鉴权仍由每个数据请求的 `X-ACCESS-TOKEN` 承担
 *    （本项目的 token 由 `/cim` 代理在服务端注入，浏览器不持有）。
 *
 * 实测引擎：`Cesium.VERSION === '1.67'`，`Scene.prototype.addS3MTilesLayerByScp` 存在且可正常出白模。
 */

import { REALS_PACE } from './scenes';

export const CESIUM_BASE_URL = '/lib/Cesium/';

/**
 * 平台自带的引擎（`irs-cesium-preview/Cesium/**`，7.98 MB，比诉求项目那份 1.67 新，渲染细节/亮度更好）。
 * 默认优先用平台引擎（经 `/cim` 代理同源拉取，浏览器不直连 drs）；拉不到时自动回退本地
 * `public/lib/Cesium`（离线可用）。`?engine=local` 可强制本地、`?engine=platform` 强制平台。
 */
export const PLATFORM_CESIUM_BASE_URL = '/cim/irs-cesium-preview/Cesium/';

export function getEngineBases(): string[] {
  try {
    const q = new URLSearchParams(location.search);
    const want = q.get('engine');
    if (want === 'local') return [CESIUM_BASE_URL];
    if (want === 'platform') return [PLATFORM_CESIUM_BASE_URL];
  } catch {
    /* 忽略 */
  }
  return [PLATFORM_CESIUM_BASE_URL, CESIUM_BASE_URL];
}

/** 与平台预览页一致的伪造体（只影响 license/login 两个元数据端点） */
const FAKE_LICENSE_BODY = JSON.stringify({
  iServerBasic: false,
  iServerBasicSpace: false,
  iServerSpace: true,
  productType: 'iServer',
  licenseType: 'iServerSpace',
});
const FAKE_LOGIN_BODY = JSON.stringify({ succeed: true });

/** S3M 瓦片请求统计（真实网络结果，供状态条显示「N 片」） */
export const s3mTileStats = { requested: 0, loaded: 0, failed: 0 };

export function resetS3mTileStats(): void {
  s3mTileStats.requested = 0;
  s3mTileStats.loaded = 0;
  s3mTileStats.failed = 0;
}

function isCimMetadataUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  // 只处理本项目的 /cim 代理（同源）下的元数据，避免污染整个应用
  if (url.indexOf('/cim/') === -1) return false;
  return url.indexOf('license.json') !== -1 || url.indexOf('login.json') !== -1;
}

function fakeBodyFor(url: string): string {
  return url.indexOf('license.json') !== -1 ? FAKE_LICENSE_BODY : FAKE_LOGIN_BODY;
}

let restoreInterceptors: (() => void) | null = null;

/**
 * 安装 fetch / XHR 拦截器（**必须在 Cesium.js 执行前**装好，引擎初始化就可能请求 license.json）：
 *  - `/cim/**` 下的 license.json / login.json → 本地 200 JSON（伪造体来自平台预览页）；
 *  - 其余请求原样放行（token 由 `/cim` 代理服务端注入，前端不需要也不允许持有）；
 *  - 顺带统计 `.s3mb` 瓦片请求成功/失败数。
 * 返回卸载函数，页面卸载时调用，避免污染其它视图。
 */
export function installCimMetadataInterceptors(): () => void {
  if (restoreInterceptors) return restoreInterceptors;
  const w = window as any;
  const origFetch = w.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  w.fetch = function (input: any, init?: any) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (isCimMetadataUrl(url)) {
      return Promise.resolve(
        new Response(fakeBodyFor(url), { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }),
      );
    }
    const isTile = typeof url === 'string' && /\.s3mb(\?|$)/i.test(url);
    if (isTile) s3mTileStats.requested += 1;
    const p = origFetch.call(this, input, init);
    if (isTile && p && typeof p.then === 'function') {
      return p.then(
        (resp: Response) => {
          if (resp && resp.ok) s3mTileStats.loaded += 1;
          else s3mTileStats.failed += 1;
          return resp;
        },
        (err: any) => {
          s3mTileStats.failed += 1;
          throw err;
        },
      );
    }
    return p;
  };

  XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
    const u = String(url || '');
    (this as any).__cimFake = isCimMetadataUrl(u) ? fakeBodyFor(u) : '';
    if (/\.s3mb(\?|$)/i.test(u)) {
      s3mTileStats.requested += 1;
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) s3mTileStats.loaded += 1;
        else s3mTileStats.failed += 1;
      });
      this.addEventListener('error', () => {
        s3mTileStats.failed += 1;
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body?: any) {
    const fake = (this as any).__cimFake;
    if (fake) {
      const xhr = this;
      const vals: Record<string, any> = {
        readyState: 4,
        status: 200,
        statusText: 'OK',
        response: fake,
        responseText: fake,
      };
      for (const k of Object.keys(vals)) {
        try {
          Object.defineProperty(xhr, k, { value: vals[k], writable: true, configurable: true });
        } catch {
          /* 只读属性忽略 */
        }
      }
      window.setTimeout(() => {
        try {
          xhr.onreadystatechange?.();
        } catch {
          /* 忽略 */
        }
        try {
          xhr.onload?.();
        } catch {
          /* 忽略 */
        }
        try {
          xhr.onloadend?.();
        } catch {
          /* 忽略 */
        }
        try {
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        } catch {
          /* 忽略 */
        }
      }, 0);
      return;
    }
    return origSend.call(this, body);
  };

  restoreInterceptors = () => {
    w.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    restoreInterceptors = null;
  };
  return restoreInterceptors;
}

/** 引擎加载结果（惰性单例，dev HMR / 重复进页只加载一次） */
let enginePromise: Promise<any> | null = null;

export function loadCesium(): Promise<any> {
  if (enginePromise) return enginePromise;
  // 引擎初始化就会请求 license.json，拦截器必须先装
  installCimMetadataInterceptors();
  enginePromise = new Promise((resolve, reject) => {
    const w = window as any;
    if (w.Cesium) {
      resolve(w.Cesium);
      return;
    }
    const bases = getEngineBases();
    const tried: string[] = [];

    const tryNext = (idx: number) => {
      if (idx >= bases.length) {
        reject(new Error(`三维引擎脚本加载失败（已尝试：${tried.join('、')}）`));
        return;
      }
      const base = bases[idx];
      tried.push(base);
      w.CESIUM_BASE_URL = base;

      const cssId = 'cim3d-cesium-widgets';
      if (!document.getElementById(cssId)) {
        const link = document.createElement('link');
        link.id = cssId;
        link.rel = 'stylesheet';
        link.href = `${base}Widgets/widgets.css`;
        document.head.appendChild(link);
      }

      const script = document.createElement('script');
      script.src = `${base}Cesium.js`;
      script.async = true;
      const timer = window.setTimeout(() => {
        // 超时也走回退（平台引擎经代理时可能较慢/不可用）
        tryNext(idx + 1);
      }, 30_000);
      script.onload = () => {
        window.clearTimeout(timer);
        const C = (window as any).Cesium;
        if (C) {
          w.__CIM3D_ENGINE_BASE__ = base;
          resolve(C);
        } else tryNext(idx + 1);
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        tryNext(idx + 1);
      };
      document.head.appendChild(script);
    };
    tryNext(0);
  });
  // 失败不缓存，允许「重新加载」再试
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

export interface EngineCapabilities {
  version: string;
  s3m: boolean;
  openScene: boolean;
  credential: boolean;
  webgl: boolean;
  webglRenderer: string;
}

export function inspectEngine(C: any): EngineCapabilities {
  let webgl = false;
  let webglRenderer = 'unknown';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      webgl = true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      webglRenderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* 忽略：无 WebGL 时页面会显示原因 */
  }
  return {
    version: String(C?.VERSION ?? (C?.CesiumVERSION ?? 'platform')),
    s3m: typeof C?.Scene?.prototype?.addS3MTilesLayerByScp === 'function',
    openScene: typeof C?.Scene?.prototype?.open === 'function',
    credential: typeof C?.Credential === 'function',
    webgl,
    webglRenderer,
  };
}

export interface ViewerHandles {
  viewer: any;
  destroy: () => void;
}

/** 创建三维视图：深色地球 + 关闭天空/太阳，只承载真实图层 */
export function createViewer(C: any, container: HTMLElement): ViewerHandles {
  const viewer = new C.Viewer(container, {
    // 底图不交给 Cesium 默认 imagery（默认会打公网，内网环境必然失败）
    imageryProvider: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
    contextOptions: { webgl: { alpha: false } },
  });

  const scene = viewer.scene;
  scene.globe.baseColor = C.Color.fromCssColorString('#0a1c2c');
  scene.backgroundColor = C.Color.fromCssColorString('#04101a');
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  // 白模是几何体，开启光照才有立体感；关闭地形深度冲突（S3M 自带高程）
  scene.globe.enableLighting = true;
  scene.globe.depthTestAgainstTerrain = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 5;
  scene.screenSpaceCameraController.maximumZoomDistance = 4.0e7;
  // 去掉双击追踪实体（大屏不需要）
  try {
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  } catch {
    /* 忽略 */
  }
  if (C.PostProcessStageLibrary?.createFxaaStage && scene.postProcessStages?.fxaa) {
    scene.postProcessStages.fxaa.enabled = true;
  }

  return {
    viewer,
    destroy: () => {
      try {
        viewer.destroy();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 相机定位到某个范围（斜视，白模才看得出立体）。
 * @param altitudeOverride 指定高度（米）；不传则按范围跨度自动取
 */
export function frameBounds(
  C: any,
  viewer: any,
  b: { west: number; south: number; east: number; north: number },
  altitudeOverride?: number,
  pitchDeg = -40,
): void {
  const cx = (b.west + b.east) / 2;
  const cy = (b.south + b.north) / 2;
  const widthM = Math.abs(b.east - b.west) * 111_320 * Math.cos((cy * Math.PI) / 180);
  const heightM = Math.abs(b.north - b.south) * 110_540;
  const span = Math.max(widthM, heightM, 800);
  // 单区县默认给「看得见整片建筑群」的高度（约 12km，俯角 50°）；全部区县由调用方显式给高度
  const altitude = altitudeOverride ?? Math.min(Math.max(span * 0.2, 6000), 20_000);
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(cx, cy, altitude),
    orientation: { heading: 0, pitch: C.Math.toRadians(pitchDeg), roll: 0 },
  });
}

export function setCameraTo(C: any, viewer: any, lon: number, lat: number, altitude: number): void {
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(lon, lat, altitude),
    orientation: { heading: 0, pitch: C.Math.toRadians(-45), roll: 0 },
  });
}

/**
 * 加载区县 S3M 白模图层（超图 iClient3D 文档 API）：
 *   `viewer.scene.addS3MTilesLayerByScp('<realspace>/datas/<scene>/config', { name })`
 *
 * 注意：引擎返回的是自带的 thenable —— **没有 .catch**（连 `.then()` 的返回值也没有），
 * 所以必须用 `new Promise((res, rej) => thenable.then(res, rej))` 收敛，不能 `.then().catch()`。
 * 失败时把引擎给出的拒绝原因原样抛出（页面据此显示，不伪造）。
 */
export async function addWhiteModelLayer(C: any, viewer: any, sceneKey: string, configUrl: string, timeoutMs = 30_000): Promise<any> {
  const scene = viewer.scene;
  const add = scene.addS3MTilesLayerByScp;
  if (typeof add !== 'function') {
    throw new Error('当前分发包不支持 S3M（Scene.addS3MTilesLayerByScp 不存在）');
  }
  const started = Date.now();
  const promise = new Promise<any>((resolve, reject) => {
    let out: any;
    try {
      out = add.call(scene, configUrl, { name: sceneKey });
    } catch (e) {
      reject(e);
      return;
    }
    if (!out) {
      reject(new Error('addS3MTilesLayerByScp 没有返回图层对象'));
      return;
    }
    if (typeof out.then === 'function') out.then(resolve, reject);
    else resolve(out);
  });
  let timer: number | undefined;
  try {
    const layer = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`S3M 图层加载超时（${Math.round(timeoutMs / 1000)}s 未收到图层就绪）`));
        }, timeoutMs);
      }),
    ]);
    if (timer) window.clearTimeout(timer);
    return { layer, elapsedMs: Date.now() - started };
  } catch (e) {
    if (timer) window.clearTimeout(timer);
    const raw = (e as any)?.message ?? e;
    throw new Error(`${raw}`);
  }
}

/** S3M 服务集清单（iServer 惯用 `datas.rjson`，退回 `datas.json` 兼容部分网关） */
export async function fetchDatasetList(realspaceBase: string): Promise<{ names: string[]; source: string }> {
  const tryOne = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('清单不是数组');
    const names = data
      .map((d: any) => d?.name)
      .filter((n: any): n is string => typeof n === 'string' && n.length > 0);
    if (!names.length) throw new Error('清单为空');
    return names;
  };
  try {
    return { names: await tryOne(`${realspaceBase}/datas.rjson`), source: 'datas.rjson' };
  } catch {
    return { names: await tryOne(`${realspaceBase}/datas.json`), source: 'datas.json' };
  }
}

export function removeAllS3MLayers(viewer: any): void {
  try {
    viewer?.scene?.layers?.removeAll?.(true);
  } catch {
    /* 忽略 */
  }
}

/**
 * 影像底图（CIM WMTS，EPSG:4490）
 *
 * 为什么不用 Cesium 自带的 WebMapTileServiceImageryProvider / UrlTemplateImageryProvider：
 *  实测该分发包（超图 iClient3D · Cesium 1.67）在「1×1 零级网格 + 自定义 GeographicTilingScheme」
 *  下算出的 TileRow/TileCol 是错的（把相机经度的**弧度值**当度数用：宜昌 111.3° → 1.94°），
 *  请求到的都是 0°E / 180°W 一带的瓦片，iServer 一律 400 `Error: Invalid URL`。
 *  这不是数据问题（同一批瓦片用 KVP 直取 200 image/jpeg），是引擎侧的网格换算问题，
 *  且换 2×1 默认网格同样错位，前端无法可靠纠正。
 *
 * 因此这里改为**真实瓦片拼接**：按当前区县范围直接按 iServer 的 4490 全局网格算行列号，
 * 取 8×8 左右的 **真实 WMTS 瓦片**，在 canvas 拼成一张图，再用 SingleTileImageryProvider
 * 按经纬度矩形贴到地球上。瓦片全部来自 CIM 服务（经 /cim 代理），不做任何假影像。
 * 缺点：只覆盖当前区县范围（切区县会重新拼），超出范围能看到地球底色 —— 状态条会写明。
 */
export interface WmtsConfig {
  url: string;
  layer: string;
  style?: string;
  format?: string;
  matrixSet?: string;
  matrixIds?: string[];
  minimumLevel?: number;
  maximumLevel?: number;
}

/** 把配置里的绝对 CIM 地址映射到本机 /cim 代理（前端不直连 drs、不持有 token） */
export function toProxyPath(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl, location.origin);
    const path = u.pathname + u.search;
    if (path.startsWith('/cim')) return path;
    // 原始地址是 https://drs.sc.yichang.gov.cn/<path> 或内网 http://10.x/<path>
    return `/cim${u.pathname}${u.search && u.search.includes('service=') ? '' : ''}`;
  } catch {
    return absoluteUrl;
  }
}

export async function readWmtsConfig(): Promise<WmtsConfig | null> {
  try {
    const res = await fetch('/config/cim.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const cfg = (await res.json()) as { wmts?: any };
    const w = cfg?.wmts;
    if (!w?.url || !w?.layer) return null;
    return {
      url: toProxyPath(String(w.url)).split('?')[0],
      layer: String(w.layer),
      style: w.style || 'default',
      format: w.format || 'image/jpgpng',
      matrixSet: w.matrixSet || 'default',
      matrixIds: Array.isArray(w.matrixIds) ? w.matrixIds.map(String) : undefined,
      maximumLevel: Array.isArray(w.matrixIds) ? w.matrixIds.length - 1 : 20,
    };
  } catch {
    return null;
  }
}

export interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MosaicResult {
  /** 服务端 WMTS 级别（4490 网格） */
  level: number;
  /** 地球侧（Cesium tilingScheme）对应级别 */
  globeLevel: number;
  cols: number;
  rows: number;
  tiles: number;
  failures: number;
  rectangle: LonLatBounds;
  /** 拼接好的真实影像（JPEG dataURL），页面作为「影像对照图」显示 */
  dataUrl: string;
}

const TILE = 256;

function tileUrl(cfg: WmtsConfig, level: number, row: number, col: number): string {
  const p = new URLSearchParams({
    service: 'WMTS',
    request: 'GetTile',
    version: '1.0.0',
    layer: cfg.layer,
    style: cfg.style || 'default',
    tilematrixset: cfg.matrixSet || 'default',
    format: cfg.format || 'image/jpgpng',
    TileMatrix: String(level),
    TileRow: String(row),
    TileCol: String(col),
  });
  return `${cfg.url}?${p.toString().replace(/\+/g, '%20')}`;
}

/** 4490 全局网格：level L → 2^L 列 / 2^(L-1) 行（已用 level 7/8/9/12 的真实瓦片核对过） */
function tileRange(b: LonLatBounds, level: number) {
  const cols = 2 ** level;
  const rows = 2 ** (level - 1);
  const x0 = Math.floor(((b.west + 180) / 360) * cols);
  const x1 = Math.floor(((b.east + 180) / 360) * cols);
  const y0 = Math.floor(((90 - b.north) / 180) * rows);
  const y1 = Math.floor(((90 - b.south) / 180) * rows);
  return { cols, rows, x0, x1, y0, y1, countX: x1 - x0 + 1, countY: y1 - y0 + 1 };
}

async function fetchBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/*' } });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * 用**真实 CIM WMTS 瓦片**拼一张当前区县范围的影像（8×6 张左右），返回 JPEG dataURL。
 *
 * 用途：作为页面右下角的「影像对照图」。之所以不直接贴进 Cesium：
 * 该分发包（超图 iClient3D · Cesium 1.67）的三维地球对 EPSG:4490 这类
 * 「1×1 零级 + 非 2:1 行数」的自定义网格换算有误（把相机经度的弧度值当度数用），
 * 贴图会整体错位/拉伸（详见 cetusEngine 上方 WmtsConfig 注释与 docs/layer-screen/20）。
 * 拼接本身完全按服务端网格行列号取**真实瓦片**，不含任何假影像。
 *
 * @param maxSide 每条边最多取多少张瓦片（默认 9 → 最多 81 张，够 1080p 大屏看）
 */
export async function buildWmtsMosaic(C: any, viewer: any, cfg: WmtsConfig, b: LonLatBounds, maxSide = 9): Promise<MosaicResult> {
  const scheme = viewer?.scene?.globe?.tilingScheme;
  const n0x: number = scheme?.numberOfLevelZeroTilesX ?? 1;
  const n0y: number = scheme?.numberOfLevelZeroTilesY ?? 1;
  const offset = Math.round(Math.log2(n0x));
  if (n0y !== 1 || 2 ** offset !== n0x) {
    throw new Error(`三维地球网格 ${n0x}×${n0y} 与 CIM 4490 网格（1×1 零级）不对齐，跳过影像（不伪造）`);
  }

  // 先按「服务端网格」选一个不超过 maxSide 的最细级别
  let level = 12;
  let range = tileRange(b, level);
  for (let lv = 13; lv >= 6; lv--) {
    const r = tileRange(b, lv);
    if (r.countX <= maxSide && r.countY <= maxSide) {
      level = lv;
      range = r;
      break;
    }
  }
  // 地球侧级别（provider 的 minimum/maximumLevel 用它）
  const globeLevel = level - offset;

  const canvas = document.createElement('canvas');
  canvas.width = range.countX * TILE;
  canvas.height = range.countY * TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas 2d，无法拼接影像');

  const jobs: { row: number; col: number }[] = [];
  for (let row = range.y0; row <= range.y1; row++) {
    for (let col = range.x0; col <= range.x1; col++) jobs.push({ row, col });
  }

  let failures = 0;
  let done = 0;
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const bmp = await fetchBitmap(tileUrl(cfg, level, job.row, job.col));
      if (!bmp) {
        failures += 1;
      } else {
        ctx.drawImage(bmp, (job.col - range.x0) * TILE, (job.row - range.y0) * TILE, TILE, TILE);
        bmp.close?.();
      }
      done += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  if (done - failures === 0) throw new Error(`影像瓦片全部失败（${failures}/${jobs.length}），不显示假影像`);

  const west = (range.x0 / range.cols) * 360 - 180;
  const east = ((range.x1 + 1) / range.cols) * 360 - 180;
  const north = 90 - (range.y0 / range.rows) * 180;
  const south = 90 - ((range.y1 + 1) / range.rows) * 180;

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  // 注意：本轮**不把影像贴进 Cesium**（贴图尝试过 3 种 provider，都会错位，见 docs 20 文档「已知限制」）。
  // 这里只把真实瓦片拼图交回页面，作为「当前区县影像对照图」显示；三维画面本身不显示假影像。
  return {
    level,
    globeLevel,
    cols: range.countX,
    rows: range.countY,
    tiles: jobs.length,
    failures,
    rectangle: { west, south, east, north },
    dataUrl,
  };
}
/* ============================================================================
 * 底图：把真实 WMTS 瓦片拼成**单张大图**，用 SingleTileImageryProvider 按精确矩形贴到地球上
 *
 * 为什么走这条路：
 *  该分发包的地球对 EPSG:4490「1×1 零级 + 非 2:1 行数」网格换算有误，用
 *  UrlTemplateImageryProvider / WebMapTileServiceImageryProvider 贴图会整体错位（把相机经度
 *  弧度当度数用）。而 SingleTileImageryProvider 只吃「一张图 + 一个 Rectangle」，
 *  **完全不依赖引擎的瓦片网格换算**，所以对齐天然正确。
 *
 * 瓦片仍是经 /cim 代理取的真实 CIM 影像（不生成假影像）；取不到就如实报错，页面显示降级底。
 * ========================================================================== */

export interface BasemapResult {
  /** 使用的方案（当前只有 singleTile 一条能保证对齐） */
  method: 'singleTile';
  /** 服务端 WMTS 级别（4490 网格） */
  level: number;
  cols: number;
  rows: number;
  tiles: number;
  failures: number;
  rectangle: LonLatBounds;
  width: number;
  height: number;
  elapsedMs: number;
}

/** 按当前 bbox 选一个瓦片数受控的级别（默认 ≤ 8×8 = 64 张） */
function pickMosaicLevel(b: LonLatBounds, maxSide: number): { level: number; range: ReturnType<typeof tileRange> } {
  let level = 13;
  let range = tileRange(b, level);
  for (let lv = 14; lv >= 6; lv--) {
    const r = tileRange(b, lv);
    if (r.countX <= maxSide && r.countY <= maxSide) {
      level = lv;
      range = r;
      break;
    }
  }
  return { level, range };
}

/**
 * 把真实 WMTS 瓦片拼成一张大图，并按**精确经纬度矩形**贴到三维地球上（默认贴到最底层）。
 *
 * @param maxSide 每条边最多取多少张瓦片（默认 8 → ≤64 张，拼接通常 1~4s）
 */
export async function addStitchedBasemap(
  C: any,
  viewer: any,
  cfg: WmtsConfig,
  b: LonLatBounds,
  maxSide = 8,
): Promise<BasemapResult> {
  const t0 = performance.now();
  const { level, range } = pickMosaicLevel(b, maxSide);

  const canvas = document.createElement('canvas');
  canvas.width = range.countX * TILE;
  canvas.height = range.countY * TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas 2d，无法拼接影像');

  // 先铺一层深色底，瓦片有缺时不会露出刺眼白块（数据本身不伪造）
  ctx.fillStyle = '#0a1620';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jobs: { row: number; col: number }[] = [];
  for (let row = range.y0; row <= range.y1; row++) {
    for (let col = range.x0; col <= range.x1; col++) jobs.push({ row, col });
  }

  let failures = 0;
  let cursor = 0;
  const CONCURRENCY = 6;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const bmp = await fetchBitmap(tileUrl(cfg, level, job.row, job.col));
      if (!bmp) failures += 1;
      else {
        ctx!.drawImage(bmp, (job.col - range.x0) * TILE, (job.row - range.y0) * TILE, TILE, TILE);
        bmp.close?.();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  if (jobs.length - failures === 0) {
    throw new Error(`底图瓦片全部失败（${failures}/${jobs.length}），不显示假影像`);
  }

  const west = (range.x0 / range.cols) * 360 - 180;
  const east = ((range.x1 + 1) / range.cols) * 360 - 180;
  const north = 90 - (range.y0 / range.rows) * 180;
  const south = 90 - ((range.y1 + 1) / range.rows) * 180;
  const rectangle = { west, south, east, north };
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

  const Rectangle = C?.Rectangle;
  if (!Rectangle?.fromDegrees) throw new Error('引擎缺少 Cesium.Rectangle，无法贴影像');
  if (typeof C?.SingleTileImageryProvider !== 'function') {
    throw new Error('引擎缺少 SingleTileImageryProvider，无法贴单张拼接影像');
  }

  const provider = new C.SingleTileImageryProvider({
    url: dataUrl,
    rectangle: Rectangle.fromDegrees(west, south, east, north),
    tileWidth: canvas.width,
    tileHeight: canvas.height,
    credit: '宜昌一张图 0.5m 影像',
  });

  viewer.imageryLayers.addImageryProvider(provider);
  // 影像必须在白模下面
  const layers = viewer.imageryLayers;
  if (typeof layers?.lowerToBottom === 'function') layers.lowerToBottom(layers.get(0));
  if (viewer.scene?.globe) viewer.scene.globe.show = true;

  return {
    method: 'singleTile',
    level,
    cols: range.countX,
    rows: range.countY,
    tiles: jobs.length,
    failures,
    rectangle,
    width: canvas.width,
    height: canvas.height,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/* ============================================================================
 * S3M 数据集属性（楼栋字段）
 *
 * 实测（2026-11-12，经代理）：
 *   GET {REALS_PACE}datas/chengqu_jitter/data/path/attribute.json  → 200，3.3KB
 *     { layerInfos:[{ idRange:{minID:1,maxID:115884}, layerName:'chengqu_jitter',
 *                     fieldInfos:[ {name:'bmid',alias:'白模ID'}, {name:'fwjzmc',alias:'房屋建筑名称'},
 *                                  {name:'tybzdz',alias:'统一标准地址'}, {name:'dscs',alias:'建筑层数(地上)'},
 *                                  {name:'jzgd',alias:'建筑高度'}, {name:'jzlb',alias:'建筑类别'} … ] }] }
 *   注意：**必须带 `.json` 后缀**（`.../attribute` 无后缀返回 404）。
 * ========================================================================== */

export interface S3MField {
  name: string;
  alias: string;
  type: string;
}

export interface S3MSchema {
  scene: string;
  /** 构件数（idRange 上界，真实值） */
  count: number;
  fields: S3MField[];
  /** 便于展示的关键字段（有则列出） */
  highlights: { label: string; field: string }[];
}

export function datasetAttributeUrl(scene: string): string {
  return `${REALS_PACE}/datas/${encodeURIComponent(scene)}/data/path/attribute.json`;
}

/** 读取某个 S3M 数据集的字段清单（真实请求；失败返回 null，不编造字段） */
export async function readS3MSchema(scene: string): Promise<S3MSchema | null> {
  try {
    const res = await fetch(datasetAttributeUrl(scene), { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const info = body?.layerInfos?.[0];
    if (!info?.fieldInfos) return null;
    const fields: S3MField[] = (info.fieldInfos as any[]).map((f) => ({
      name: String(f.name),
      alias: String(f.alias ?? f.name),
      type: String(f.type ?? ''),
    }));
    const count = Number(info?.idRange?.maxID ?? 0) - Number(info?.idRange?.minID ?? 0) + 1;
    const wanted: { label: string; field: string }[] = [
      { label: '房屋建筑名称', field: 'fwjzmc' },
      { label: '统一标准地址', field: 'tybzdz' },
      { label: '建筑层数(地上)', field: 'dscs' },
      { label: '建筑高度', field: 'jzgd' },
      { label: '建筑类别', field: 'jzlb' },
      { label: '结构类型', field: 'jglx' },
      { label: '白模ID', field: 'bmid' },
    ];
    const highlights = wanted.filter((w) => fields.some((f) => f.name === w.field));
    return { scene, count: count > 0 ? count : 0, fields, highlights };
  } catch {
    return null;
  }
}

/* ============================================================================
 * 楼栋拾取（点击白模构件 → 取属性）
 *
 * 引擎侧：`S3MTilesLayer.getAttributesById(id)`（超图 iClient3D 提供，已确认存在于两个分发包）。
 * 事件侧：`scene.pick(position)` 取构件，再按多种可能的 id 形态尝试（引擎版本间有差异），
 * 全部失败时把**真实的 pick 结果结构**回传给页面用于诊断（不伪造楼栋信息）。
 * ========================================================================== */

export interface PickAttempt {
  /** 命中的构件 id（拿到才有后续属性） */
  id: string | null;
  /** 属性键值（真实返回） */
  attributes: Record<string, unknown> | null;
  /** 失败原因（id 没拿到 / 属性为空 / 接口异常） */
  reason: string;
  /** 引擎 pick 返回对象的形状摘要（诊断用） */
  shape: string;
}

function describeShape(obj: any, depth = 0): string {
  if (obj == null) return String(obj);
  if (depth > 1) return typeof obj;
  if (typeof obj !== 'object') return `${typeof obj}:${String(obj)}`;
  const keys = Object.keys(obj).slice(0, 10);
  return `{${keys.join(',')}}`;
}

function candidateIds(picked: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (v == null) return;
    if (typeof v === 'number' || typeof v === 'string') {
      const s = String(v);
      if (s && s !== '[object Object]' && !out.includes(s)) out.push(s);
    }
  };
  push(picked?.id);
  push(picked?.id?.name);
  push(picked?.primitive?.id);
  push(picked?.primitive?._id);
  push(picked?.primitive?.name);
  push(picked?.object?.id);
  push(picked?.content?.id);
  return out;
}

/** 在给定的一组 S3M 图层里，用 pick 结果反查属性 */
export async function pickS3MAttributes(
  C: any,
  viewer: any,
  layers: any[],
  position: { x: number; y: number },
): Promise<PickAttempt> {
  let picked: any = null;
  try {
    picked = viewer.scene.pick(new C.Cartesian2(position.x, position.y));
  } catch (e) {
    return { id: null, attributes: null, reason: `scene.pick 抛错：${(e as Error)?.message ?? e}`, shape: '' };
  }
  const shape = describeShape(picked);
  if (!picked) return { id: null, attributes: null, reason: '该位置没有三维构件', shape };
  const ids = candidateIds(picked);
  if (!ids.length) return { id: null, attributes: null, reason: `pick 命中但无可识别 id（结构 ${shape}）`, shape };

  for (const layer of layers) {
    if (typeof layer?.getAttributesById !== 'function') continue;
    for (const id of ids) {
      try {
        const raw = await layer.getAttributesById(id);
        if (!raw) continue;
        const attrs = (raw?.data ?? raw?.attributes ?? raw) as Record<string, unknown>;
        if (attrs && typeof attrs === 'object' && Object.keys(attrs).length) {
          return { id, attributes: attrs, reason: '', shape };
        }
      } catch {
        /* 换下一个候选 id / 图层 */
      }
    }
  }
  return { id: ids[0], attributes: null, reason: '命中构件但 getAttributesById 未返回属性', shape };
}

/** 点击拾取绑定（返回解绑函数） */
export function bindS3MPick(
  C: any,
  viewer: any,
  getLayers: () => any[],
  onPick: (attempt: PickAttempt) => void,
): { destroy: () => void } {
  const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: any) => {
    const pos = movement?.position;
    if (!pos) return;
    void pickS3MAttributes(C, viewer, getLayers(), { x: pos.x, y: pos.y }).then(onPick);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  return { destroy: () => { try { handler.destroy(); } catch { /* 忽略 */ } } };
}


/* ============================================================================
 * 底图（主方案）：原生 WMTS + GeographicTilingScheme + 级别偏移 1
 *
 * 参数**原样照抄**宜昌平台官方预览页 `irs-cesium-preview/previewV4.html`（2026-11-12 实抓）：
 *   LEGACY_BASE_CONFIG = { layer:'yichang20260922_0d5', style:'default', format:'image/jpgpng',
 *                          tileMatrixSet:'default', offset:1, minLevel:6, maxLevel:16 }
 *   var scheme = new Cesium.GeographicTilingScheme();          // 2×1 零级（不是自定义 4490 1×1 网格）
 *   labels[lv] = String(lv + offset);                          // 服务层级 = Cesium 层级 + 1
 *   new Cesium.WebMapTileServiceImageryProvider({ …, tileMatrixLabels: labels, tilingScheme: scheme, … })
 *
 * 这正是"官方清晰、我们糊"的差别：按相机 LOD 拉原生瓦片，而不是把一张 z12 大图放大。
 * token 由 `/cim` 代理在服务端注入，前端不需要 customRequestHeaders。
 * ========================================================================== */

export interface NativeBasemapResult {
  method: 'native';
  /** Cesium 侧层级范围 */
  cesiumLevels: [number, number];
  /** 对应的服务端 TileMatrix 标签范围（= Cesium 层级 + offset） */
  serviceLevels: [number, number];
  offset: number;
  rectangle: LonLatBounds;
}

/** 官方页实测参数（照抄，不要自行调整） */
const NATIVE_WMTS = { offset: 1, minLevel: 8, maxLevel: 16 };

/** 底图瓦片失败统计（失败监听写入，供诊断行使用） */
export const basemapTileStats = { failed: 0, firstUrl: '', reset() { this.failed = 0; this.firstUrl = ''; } };
/** 服务 bbox（GetCapabilities 实测） */
export const WMTS_SERVICE_BOUNDS: LonLatBounds = {
  west: 108.27336142,
  south: 28.96832129,
  east: 116.22278768,
  north: 33.37884143,
};

/**
 * 原生 WMTS 底图（主方案）。成功返回层级信息；失败抛错，由调用方回退拼接方案。
 * @param rect 影像覆盖矩形，默认用服务 bbox（官方页做法是先粗后准，收窄 rectangle 可少发请求）
 */
export async function addWmtsBasemapNative(
  C: any,
  viewer: any,
  cfg: WmtsConfig,
  rect: LonLatBounds = WMTS_SERVICE_BOUNDS,
): Promise<NativeBasemapResult> {
  if (typeof C?.WebMapTileServiceImageryProvider !== 'function') {
    throw new Error('引擎缺少 WebMapTileServiceImageryProvider');
  }
  if (typeof C?.GeographicTilingScheme !== 'function') {
    throw new Error('引擎缺少 GeographicTilingScheme');
  }
  if (!C?.Rectangle?.fromDegrees) throw new Error('引擎缺少 Rectangle');

  const scheme = new C.GeographicTilingScheme();
  const { offset, minLevel, maxLevel } = NATIVE_WMTS;
  const labels: string[] = [];
  for (let lv = minLevel; lv <= maxLevel; lv++) labels[lv] = String(lv + offset);

  const provider = new C.WebMapTileServiceImageryProvider({
    url: cfg.url,
    layer: cfg.layer,
    style: cfg.style || 'default',
    format: cfg.format || 'image/jpgpng',
    tileMatrixSetID: cfg.matrixSet || 'default',
    tileMatrixLabels: labels,
    tilingScheme: scheme,
    minimumLevel: minLevel,
    maximumLevel: maxLevel,
    rectangle: C.Rectangle.fromDegrees(rect.west, rect.south, rect.east, rect.north),
    credit: 'IRS CIM Platform',
  });

  viewer.imageryLayers.addImageryProvider(provider);
  const layers = viewer.imageryLayers;
  if (typeof layers?.lowerToBottom === 'function') layers.lowerToBottom(layers.get(0));
  if (viewer.scene?.globe) viewer.scene.globe.show = true;

  // 等 provider 就绪（Cesium 1.67 有 readyPromise；没有就跳过，别把页面卡死）
  if (provider?.readyPromise?.then) {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('WMTS provider 就绪超时（15s）')), 15_000);
      provider.readyPromise.then(
        () => { window.clearTimeout(timer); resolve(); },
        (e: unknown) => { window.clearTimeout(timer); reject(new Error(`WMTS provider 就绪失败：${(e as any)?.message ?? e}`)); },
      );
    });
  }

  return {
    method: 'native',
    cesiumLevels: [minLevel, maxLevel],
    serviceLevels: [minLevel + offset, maxLevel + offset],
    offset,
    rectangle: rect,
  };
}

/**
 * 自检：按 GeographicTilingScheme(2×1) 算一张 Cesium L11 → 服务 TileMatrix 12 的瓦片 URL 并真实请求。
 * 用于状态卡证明"瓦片确实能出图"（官方实测坐标 TileCol=3312 / TileRow=677）。
 */
export async function probeNativeWmtsTile(cfg: WmtsConfig): Promise<{ ok: boolean; status: number; url: string }> {
  const col = 3312;
  const row = 677;
  const serviceMatrix = 12;
  const p = new URLSearchParams({
    layer: cfg.layer,
    style: cfg.style || 'default',
    tilematrixset: cfg.matrixSet || 'default',
    Service: 'WMTS',
    Request: 'GetTile',
    Version: '1.0.0',
    Format: 'image/jpgpng',
    TileMatrix: String(serviceMatrix),
    TileCol: String(col),
    TileRow: String(row),
  });
  const base = cfg.url.split('?')[0];
  const url = `${base}?${p.toString().replace(/\+/g, '%20')}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/*' } });
    return { ok: res.ok, status: res.status, url };
  } catch (e) {
    return { ok: false, status: 0, url };
  }
}

/* ============================================================================
 * 底图（正式方案）：**GetCapabilities 驱动**，不硬编码层级
 *
 * 照搬平台官方 `previewV4.html` 的四个手法：
 *  ① tilingScheme 由 CRS 决定（经纬度 → GeographicTilingScheme，3857 → WebMercatorTilingScheme）
 *  ② 层级用**网格尺寸**反推（2 的幂 + 经纬度宽=2×高），**不用 ScaleDenominator**
 *     —— 源码注释原文：该风格矩阵集比例尺偏大约 5.8%，按比例尺算永远差一点点，
 *        每一级都被判对不齐，整份能力文档装配失败（CIM 转发的 WMTS 就踩过这个坑）
 *  ③ 先探 3×3 瓦片（401/403 说明 token 不对就不挂），命中后用命中瓦片反推 rectangle
 *     —— 注释原文：「不交 rectangle 就等于整地球都要，这正是请求非常多、失败非常多的来源」
 *  ④ provider 建好后强制校正 `_minimumLevel` / `_maximumLevel`
 * ========================================================================== */

export interface WmtsMatrix {
  /** TileMatrix 标识（服务端原始，例如 '1'..'18'） */
  id: string;
  matrixWidth: number;
  matrixHeight: number;
  scaleDenominator: number;
  topLeft: { lon: number; lat: number };
}

export interface WmtsCapabilities {
  layer: string;
  style: string;
  format: string;
  matrixSet: string;
  crs: string;
  matrices: WmtsMatrix[];
  /** 能力文档原始字节数（真实值，用于诊断） */
  bytes: number;
}

/** ① CRS → tilingScheme（官方同款正则） */
export function wmtsTilingSchemeFor(C: any, crs: string): { scheme: any; kind: 'mercator' | 'geographic' } {
  const isMerc = /3857|900913|10210[0-9]|102113/i.test(String(crs || ''));
  if (isMerc) return { scheme: new C.WebMercatorTilingScheme(), kind: 'mercator' };
  return { scheme: new C.GeographicTilingScheme(), kind: 'geographic' };
}

/**
 * ② 网格尺寸 → Cesium 层级（官方规则）
 *  - matrixWidth 必须是 2 的整数次幂；
 *  - 经纬度网格要求 matrixHeight === matrixWidth / 2；墨卡托要求相等；
 *  - 经纬度：Cesium L0 = 2×1 → L = log2(w) - 1；墨卡托：L0 = 1×1 → L = log2(w)。
 * 返回 null 表示该 matrix 无法映射（调用方跳过并记入诊断）。
 */
export function wmtsLevelFromGrid(m: WmtsMatrix, kind: 'mercator' | 'geographic'): number | null {
  const w = m.matrixWidth;
  const h = m.matrixHeight;
  if (!(w >= 1) || (w & (w - 1)) !== 0) return null;
  if (kind === 'mercator') {
    if (h !== w) return null;
    return Math.round(Math.log2(w));
  }
  if (h !== w / 2) return null;
  return Math.round(Math.log2(w)) - 1;
}

/**
 * ②-b 近似映射（CIM 转发的 WMTS 实测必需）
 *
 * 实测 `yichang20260922_0d5` 的 TileMatrix 网格是 **1×1、2×1、4×1、7×2、14×3、27×6、53×11 …**
 * —— 不是 2 的整数次幂（iServer 按比例尺算出来的），所以官方那条「必须 2^n」的精确规则会被**全部拒绝**，
 * 导致能力文档装配失败。这里改用「最近 2 次幂」映射：经纬度网格 L = round(log2(w)) - 1，
 * 墨卡托 L = round(log2(w))，并校验宽高比确实是 2:1（经纬度）或 1:1（墨卡托）。
 */
export function wmtsLevelFromGridApprox(m: WmtsMatrix, kind: 'mercator' | 'geographic'): number | null {
  const w = m.matrixWidth;
  const h = m.matrixHeight;
  if (!(w >= 1) || !(h >= 1)) return null;
  const ratio = w / h;
  if (kind === 'mercator' ? Math.abs(ratio - 1) > 0.02 : Math.abs(ratio - 2) > 0.02) return null;
  const lv = Math.round(Math.log2(w)) - (kind === 'mercator' ? 0 : 1);
  return lv >= 0 ? lv : null;
}
/** 解析 GetCapabilities（真实请求；失败抛错并带状态码） */
export async function fetchWmtsCapabilities(cfg: WmtsConfig): Promise<WmtsCapabilities> {
  const base = cfg.url.split('?')[0];
  const qs = new URLSearchParams({ service: 'WMTS', request: 'GetCapabilities' });
  const url = `${base}?${qs.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'text/xml,application/xml' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GetCapabilities HTTP ${res.status}（${text.slice(0, 120)}）`);

  const doc = new DOMParser().parseFromString(text, 'text/xml');
  /** 命名空间容忍：CIM 转发的能力文档大量用 `ows:Identifier` 这类前缀 */
  const tags = (parent: Element | Document, tag: string): Element[] => {
    const ns = Array.from(parent.getElementsByTagNameNS('*', tag) as any) as Element[];
    if (ns.length) return ns;
    return Array.from(parent.getElementsByTagName(tag) as HTMLCollectionOf<Element>);
  };
  const firstText = (parent: Element | Document | null | undefined, tag: string): string =>
    parent ? (tags(parent, tag)[0]?.textContent ?? '').trim() : '';

  const layerEl = tags(doc, 'Layer')[0] ?? null;
  const layer = firstText(layerEl, 'Identifier') || cfg.layer;
  const style = firstText(layerEl, 'Style') || cfg.style || 'default';
  const format = firstText(layerEl ?? doc, 'Format') || cfg.format || 'image/jpgpng';
  const matrixSet = firstText(layerEl ?? doc, 'TileMatrixSet') || cfg.matrixSet || 'default';
  const crsEls = tags(doc, 'SupportedCRS');
  const crs = (crsEls[0]?.textContent ?? '').trim() || 'urn:ogc:def:crs:EPSG::4490';

  const matrices: WmtsMatrix[] = tags(doc, 'TileMatrix').map((el) => {
    const topLeft = firstText(el, 'TopLeftCorner').split(/\s+/).map(Number);
    return {
      id: firstText(el, 'Identifier'),
      matrixWidth: Number(firstText(el, 'MatrixWidth') || 0),
      matrixHeight: Number(firstText(el, 'MatrixHeight') || 0),
      scaleDenominator: Number(firstText(el, 'ScaleDenominator') || 0),
      topLeft: { lon: topLeft[0] ?? NaN, lat: topLeft[1] ?? NaN },
    };
  });
  if (!matrices.length) throw new Error('GetCapabilities 里没有 TileMatrix（能力文档结构不认识）');
  return { layer, style, format, matrixSet, crs, matrices, bytes: text.length };
}

/** ③ 瓦片范围 → Rectangle（官方同款） */
function tileRangeToRectangle(C: any, scheme: any, level: number, minX: number, minY: number, maxX: number, maxY: number) {
  const nw = scheme.tileXYToRectangle(minX, minY, level);
  const se = scheme.tileXYToRectangle(maxX, maxY, level);
  return new C.Rectangle(nw.west, se.south, se.east, nw.north);
}

/** ④ 强改已挂 provider 的层级（官方同款；两种 provider 存的字段位置不同） */
export function applyProviderLevels(provider: any, mn: number, mx: number): boolean {
  const targets: any[] = [provider];
  if (provider && provider._tileProvider) targets.push(provider._tileProvider);
  let okMin = false;
  let okMax = false;
  for (const t of targets) {
    if (!t) continue;
    try { if ('_minimumLevel' in t) { t._minimumLevel = mn; okMin = true; } } catch { /* 忽略 */ }
    try { if ('_maximumLevel' in t) { t._maximumLevel = mx; okMax = true; } } catch { /* 忽略 */ }
  }
  return okMin && okMax;
}

export interface CapabilityBasemapResult {
  method: 'capacity';
  caps: WmtsCapabilities;
  /** 网格尺寸反推出的层级映射：cesiumLevel → 服务端 TileMatrix 标识 */
  labels: Record<number, string>;
  cesiumLevels: [number, number];
  serviceIds: [string, string];
  schemeKind: 'mercator' | 'geographic';
  rectangle: LonLatBounds;
  /** 3×3 探测：状态码列表与命中数（真实网络结果） */
  probe: { level: number; statuses: number[]; hits: number };
  /** 无法映射而被跳过的 matrix 数（诊断用） */
  skippedMatrices: number;
  /** 建好后是否成功强改层级 */
  levelsApplied: boolean;
}

function tileUrlFor(cfg: WmtsConfig, matrixId: string, row: number, col: number, layer: string, style: string, format: string, matrixSet: string) {
  const p = new URLSearchParams({
    layer,
    style,
    tilematrixset: matrixSet,
    Service: 'WMTS',
    Request: 'GetTile',
    Version: '1.0.0',
    Format: format,
    TileMatrix: matrixId,
    TileCol: String(col),
    TileRow: String(row),
  });
  // Format 里的斜杠必须编码（iServer 要求 image%2Fjpgpng）
  return `${cfg.url.split('?')[0]}?${p.toString().replace(/\+/g, '%20')}`;
}

/**
 * 能力驱动的底图：读能力文档 → 网格尺寸反推层级 → 3×3 探测 → 反推 rectangle → 建 provider → 强改层级
 */
export async function addWmtsBasemapFromCapabilities(
  C: any,
  viewer: any,
  cfg: WmtsConfig,
  sceneBounds: LonLatBounds,
): Promise<CapabilityBasemapResult> {
  const caps = await fetchWmtsCapabilities(cfg);
  const { scheme, kind } = wmtsTilingSchemeFor(C, caps.crs);

  // ② 逐 matrix 映射层级：先精确 2^n，全被拒则退「最近 2 次幂」
  let labels: Record<number, string> = {};
  let skipped = 0;
  let rule: 'exact' | 'approx' = 'exact';
  for (const m of caps.matrices) {
    const lv = wmtsLevelFromGrid(m, kind);
    if (lv === null || lv < 0) {
      skipped += 1;
      continue;
    }
    labels[lv] = m.id;
  }
  if (!Object.keys(labels).length) {
    labels = {};
    skipped = 0;
    rule = 'approx';
    for (const m of caps.matrices) {
      const lv = wmtsLevelFromGridApprox(m, kind);
      if (lv === null) {
        skipped += 1;
        continue;
      }
      if (labels[lv] === undefined) labels[lv] = m.id;
    }
  }
  const levels = Object.keys(labels).map(Number).sort((a, b) => a - b);
  if (!levels.length) {
    throw new Error(
      `能力文档 ${caps.matrices.length} 个 TileMatrix 全部无法按网格尺寸映射（crs=${caps.crs} kind=${kind}）`,
    );
  }
  const minLevel = levels[0];
  const maxLevel = levels[levels.length - 1];

  // ③ 选探测级别（中间偏粗，3×3 覆盖范围更大），按场景中心定位
  const probeLevel = Math.min(maxLevel, Math.min(minLevel + 2, levels[Math.floor(levels.length / 2)]));
  const centerLon = (sceneBounds.west + sceneBounds.east) / 2;
  const centerLat = (sceneBounds.south + sceneBounds.north) / 2;
  const center = C.Cartographic.fromDegrees(centerLon, centerLat);
  const t0 = scheme.positionToTileXY(center, probeLevel);
  if (!t0) throw new Error(`按场景中心算不出瓦片坐标（level=${probeLevel}）`);

  const statuses: number[] = [];
  let hits = 0;
  const jobs: Promise<void>[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.max(0, t0.x + dx);
      const y = Math.max(0, t0.y + dy);
      jobs.push(
        fetch(tileUrlFor(cfg, labels[probeLevel], y, x, caps.layer, caps.style, caps.format, caps.matrixSet), { headers: { Accept: 'image/*' } })
          .then(async (r) => {
            statuses.push(r.status);
            if (r.ok) {
              const b = await r.blob();
              if (b.size > 200) hits += 1;
            }
          })
          .catch(() => {
            statuses.push(0);
          }),
      );
    }
  }
  await Promise.all(jobs);
  if (statuses.every((s) => s === 401 || s === 403)) {
    throw new Error(`底图鉴权失败（3×3 探测全部 ${statuses[0]}，token 与该底图资源不匹配）`);
  }
  if (!hits) {
    throw new Error(`底图瓦片探测全部失败（状态码 ${statuses.join('/')}，级别 ${probeLevel}→TileMatrix ${labels[probeLevel]}）`);
  }

  // 用命中范围（外扩一圈）反推 rectangle，避免"整地球都要"
  const rect = tileRangeToRectangle(
    C,
    scheme,
    probeLevel,
    Math.max(0, t0.x - 2),
    Math.max(0, t0.y - 2),
    t0.x + 2,
    t0.y + 2,
  );
  const rectangle: LonLatBounds = {
    west: (rect.west * 180) / Math.PI,
    south: (rect.south * 180) / Math.PI,
    east: (rect.east * 180) / Math.PI,
    north: (rect.north * 180) / Math.PI,
  };

  const provider = new C.WebMapTileServiceImageryProvider({
    url: cfg.url.split('?')[0],
    layer: caps.layer,
    style: caps.style,
    format: caps.format,
    tileMatrixSetID: caps.matrixSet,
    tileMatrixLabels: labels,
    tilingScheme: scheme,
    minimumLevel: minLevel,
    maximumLevel: maxLevel,
    rectangle: tileRangeToRectangle(C, scheme, probeLevel, Math.max(0, t0.x - 2), Math.max(0, t0.y - 2), t0.x + 2, t0.y + 2),
    credit: 'IRS CIM Platform',
  });
  viewer.imageryLayers.addImageryProvider(provider);
  const layers = viewer.imageryLayers;
  if (typeof layers?.lowerToBottom === 'function') layers.lowerToBottom(layers.get(0));
  if (viewer.scene?.globe) viewer.scene.globe.show = true;

  const levelsApplied = applyProviderLevels(provider, minLevel, maxLevel);

  return {
    method: 'capacity',
    caps,
    labels,
    cesiumLevels: [minLevel, maxLevel],
    serviceIds: [labels[minLevel], labels[maxLevel]],
    schemeKind: kind,
    rectangle,
    probe: { level: probeLevel, statuses, hits },
    skippedMatrices: skipped,
    levelsApplied,
    rule,
  };
}




/* ---------------------------------------------------------------------------
 * 底图调色（客户贴图对比后可一次调准；URL 可覆盖）
 * ------------------------------------------------------------------------- */
export interface ImageryTuning {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
}

export const IMAGERY_TUNING_DEFAULTS: ImageryTuning = { brightness: 1.0, contrast: 1.0, saturation: 1.0, gamma: 1.0 };

/** 把调色参数应用到最底层（影像）图层；返回实际生效值 */
export function applyImageryTuning(viewer: any, tuning: Partial<ImageryTuning>): ImageryTuning {
  const t: ImageryTuning = { ...IMAGERY_TUNING_DEFAULTS, ...tuning };
  const layer = viewer?.imageryLayers?.get?.(0);
  if (!layer) return t;
  try { layer.brightness = t.brightness; } catch { /* 忽略 */ }
  try { layer.contrast = t.contrast; } catch { /* 忽略 */ }
  try { layer.saturation = t.saturation; } catch { /* 忽略 */ }
  try { layer.gamma = t.gamma; } catch { /* 忽略 */ }
  return t;
}

/**
 * 多级探测：证明「深层级也在出图」。
 * 用验证过的 Cesium L → 服务 matrix 偏移 1 的确定性映射：
 *   L11 → matrix 12, col=3310, row=673
 *   L13 → matrix 14, col=13242, row=2696
 */
export async function probeWmtsMultiLevel(
  cfg: WmtsConfig,
): Promise<{ name: string; status: number; bytes: number }[]> {
  const cases = [
    { name: 'L11→m12', matrix: '12', col: 3310, row: 673 },
    { name: 'L13→m14', matrix: '14', col: 13242, row: 2696 },
  ];
  const base = cfg.url.split('?')[0];
  const out: { name: string; status: number; bytes: number }[] = [];
  for (const c of cases) {
    const p = new URLSearchParams({
      layer: cfg.layer,
      style: cfg.style || 'default',
      tilematrixset: cfg.matrixSet || 'default',
      Service: 'WMTS',
      Request: 'GetTile',
      Version: '1.0.0',
      Format: cfg.format || 'image/jpgpng',
      TileMatrix: c.matrix,
      TileCol: String(c.col),
      TileRow: String(c.row),
    });
    const url = `${base}?${p.toString().replace(/\+/g, '%20')}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'image/*' } });
      let bytes = 0;
      try { bytes = (await res.clone().blob()).size; } catch { bytes = 0; }
      out.push({ name: c.name, status: res.status, bytes });
    } catch {
      out.push({ name: c.name, status: 0, bytes: 0 });
    }
  }
  return out;
}
