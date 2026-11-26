import ImageLayer from 'ol/layer/Image.js';
import type OlMap from 'ol/Map.js';
import ImageStatic from 'ol/source/ImageStatic.js';
import { ref, watch } from 'vue';

export const CIM_BOUNDARY_LEVELS = {
  sqwg: '社区网格',
  sqjcglqy: '社区居村管理区域',
  xzj: '乡镇街',
  qx: '区县',
  sz: '市州',
} as const;

type CimBoundaryLevel = keyof typeof CIM_BOUNDARY_LEVELS;
const CIM_CITY_BBOX = [110.251, 29.935, 112.089, 31.572];

type BoundaryMap = Pick<OlMap, 'getSize' | 'getView' | 'addLayer' | 'removeLayer'>;
type OverlayStatus = { text: string; retry?: boolean };

export function useCimBoundaryOverlay(
  getMap: () => BoundaryMap | null,
  apiBase: string,
) {
  const level = ref<CimBoundaryLevel | ''>('sqwg');
  const status = ref<OverlayStatus>({ text: '等待地图准备' });
  let layer: ImageLayer<ImageStatic> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  function cancelPending() {
    clearTimeout(timer);
    timer = undefined;
    request?.abort();
    request = undefined;
  }

  function clearLayer() {
    if (!layer) return;
    getMap()?.removeLayer(layer);
    layer = null;
  }

  function unavailable(text: string, retry = false) {
    clearLayer();
    status.value = retry ? { text, retry } : { text };
  }

  async function refresh() {
    cancelPending();
    const selected = level.value;
    if (!selected) return unavailable('已关闭');
    const label = CIM_BOUNDARY_LEVELS[selected];
    const map = getMap();
    const size = map?.getSize();
    if (!map || !size || !size.every(value => value > 0)) return unavailable('等待地图准备');

    const extent = map.getView().calculateExtent(size);
    const west = Math.max(extent[0], CIM_CITY_BBOX[0]);
    const south = Math.max(extent[1], CIM_CITY_BBOX[1]);
    const east = Math.min(extent[2], CIM_CITY_BBOX[2]);
    const north = Math.min(extent[3], CIM_CITY_BBOX[3]);
    const spanLon = east - west;
    const spanLat = north - south;
    if (!(spanLon > 0.001 && spanLat > 0.001)) return unavailable('当前视野的宜昌市域范围不足');

    let token: string | null = null;
    try { token = sessionStorage.getItem('gqxq-token'); } catch { /* 浏览器禁用存储 */ }
    if (!token) return unavailable('请登录后查看');

    // CIM 出图使用等度像素。按地面米修正纵横比会让服务端扩边，导致栅格与底图错位。
    const ratio = spanLat / spanLon;
    const height = Math.max(160, Math.min(1024, Math.round(1024 * ratio)));
    const width = Math.max(128, Math.min(2048, Math.round(height / ratio)));
    const imageExtent = [west, south, east, north];
    const bbox = imageExtent.map(value => value.toFixed(5)).join(',');
    const params = new URLSearchParams({ level: selected, bbox, w: String(width), h: String(height) });
    const pending = new AbortController();
    request = pending;
    status.value = { text: `${label}加载中…` };

    try {
      const response = await fetch(`${apiBase}/cim/grid-overlay?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      if (response.status === 401) return unavailable('请登录后查看');
      if (response.status === 403) return unavailable('当前账号无权查看 CIM 参考边界');
      if (!response.ok) return unavailable(`${label}加载失败（HTTP ${response.status}）`, true);

      const bitmap = await createImageBitmap(await response.blob());
      try {
        if (pending.signal.aborted) return;
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) return unavailable(`${label}加载失败`, true);
        // CIM 出图为透明底黄线，转为青绿以便和业务边界区分。
        context.filter = 'hue-rotate(150deg) saturate(1.15)';
        context.globalAlpha = 0.9;
        context.drawImage(bitmap, 0, 0);
        const source = new ImageStatic({
          url: canvas.toDataURL('image/png'),
          imageExtent,
          projection: 'EPSG:4326',
        });
        const opacity = spanLon > 1.2 ? 0.28 : spanLon > 0.6 ? 0.45 : 0.72;
        if (layer) {
          layer.setSource(source);
          layer.setOpacity(opacity);
        } else {
          layer = new ImageLayer({ source, opacity, zIndex: 3, className: 'cim-grid-layer' });
          map.addLayer(layer);
        }
        status.value = { text: `${label}已显示 · 只读栅格${response.headers.has('x-cim-note') ? ' · 缓存' : ''}` };
      } finally {
        bitmap.close();
      }
    } catch {
      if (!pending.signal.aborted) unavailable(`${label}加载失败`, true);
    } finally {
      if (request === pending) request = undefined;
    }
  }

  function schedule(delay = 400) {
    cancelPending();
    if (level.value) timer = setTimeout(() => { void refresh(); }, delay);
  }

  function stop() {
    cancelPending();
    clearLayer();
  }

  watch(level, () => {
    clearLayer();
    void refresh();
  }, { flush: 'sync' });

  return { level, status, refresh, schedule, stop };
}
