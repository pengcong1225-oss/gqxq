/**
 * 影响范围多边形 → 行政网格 的解析工具（共享实现）。
 *
 * 为什么需要它：`admin_grid.geometry` 当前 124 行**全部为 null**，即库里没有官方网格面，
 * 所以「事件影响范围多边形 → 落在哪个网格」无法靠网格面相交来判定。
 *
 * 采用的替代口径（已在 `shutdownLayerService` 验证有效）：
 *   影响范围多边形（GCJ-02 推定转 WGS84）→ 落在多边形内的**小区点位** → 取这些小区所属的
 *   `admin_grid_code` 作为事件涉及网格。
 *
 * 这不是虚构几何：用的是真实上报的多边形和真实的已定位小区，只是把"面与面相交"
 * 降级为"面内点位归属"，并如实标注推定口径（来源坐标系未声明时按 GCJ-02 处理）。
 *
 * 之前这段逻辑在 `shutdownLayerService.ts` 里私有实现，`utilityFeed.ts` 另有一套，
 * 结果后者因为 admin_grid.geometry 全 null 而永远解析不出网格。抽出来统一，避免再次分叉。
 */

/** 来源未声明坐标系时的默认推定口径（高德/小程序来源，宜昌偏移约 680m） */
export const DEFAULT_ASSUME_GCJ02 = true;

/** 读取推定开关（可用 GQXQ_SHUTDOWN_ASSUME_GCJ02=false 退回严格口径） */
export function assumeGcj02Source(): boolean {
  return String(process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02 ?? String(DEFAULT_ASSUME_GCJ02)).toLowerCase() !== 'false';
}

/* ------------------------------------------------------------------ 坐标转换 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** GCJ-02 → WGS84（迭代逼近，往返误差 < 0.5m） */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  // 一次近似后再回代一次，压掉残留误差
  const wgsLng = lng - dLng;
  const wgsLat = lat - dLat;
  return [wgsLng, wgsLat];
}

/* ------------------------------------------------------------------ 几何解析 */

/** 射线法判断点是否在多边形环内 */
export function pointInRing(p: [number, number], r: number[][]): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = Number(r[i]?.[0]);
    const yi = Number(r[i]?.[1]);
    const xj = Number(r[j]?.[0]);
    const yj = Number(r[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 从来源 fields 里解析影响范围多边形。
 *
 * 已知格式（实测 `utility-feed-real`）：
 *   fields.tingshuiRange / tingqiRange = [{ latLog: "111.339,30.737;111.329,30.748;..." }]
 * 也兼容 points 数组形式（[[lng,lat],...] 或 [{longitude,latitude}]）。
 */
export function parseFeedRing(fields: Record<string, unknown>): number[][] | null {
  return parseFeedRings(fields)[0] ?? null;
}

export function parseFeedRings(fields: Record<string, unknown>): number[][][] {
  const raw = fields?.tingshuiRange ?? fields?.tingqiRange ?? fields?.constructionRange ?? fields?.range;
  /**
   * 实测格式：`tingqiRange` 是**字符串套 JSON**
   *   "[{\"latLog\":\"111.339405,30.737366;111.329105,30.748062;...\"}]"
   * 因此先尝试 JSON 解析（最多两轮，兼容双重编码），失败再当作裸字符串处理。
   * 早期实现直接把它当数组用，`Array.isArray(raw)` 为 false → 解析恒为 null，
   * 于是「多边形反推网格」这一步实际上从未执行。
   */
  let decoded: unknown = raw;
  for (let i = 0; i < 2 && typeof decoded === 'string'; i += 1) {
    const text = (decoded as string).trim();
    try {
      decoded = JSON.parse(text);
    } catch {
      break;
    }
  }

  const list = Array.isArray(decoded) ? decoded : decoded ? [decoded] : [];
  const rings: number[][][] = [];
  const number = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  for (const item of list) {
    const row = item as { latLog?: unknown; points?: unknown };
    const text = typeof row?.latLog === 'string' ? row.latLog : '';
    let ring: number[][] = [];
    if (text) {
      ring = text.trim().replace(/;$/, '').split(';').map((pair) => pair.split(',').map(number));
    } else {
      let points = row?.points;
      if (typeof points === 'string') {
        try { points = JSON.parse(points); } catch { continue; }
      }
      if (!Array.isArray(points)) continue;
      ring = (points as unknown[])
        .map((p) => {
          if (Array.isArray(p)) return p.map(number);
          const o = p as { longitude?: unknown; latitude?: unknown; lng?: unknown; lat?: unknown };
          return [number(o?.longitude ?? o?.lng), number(o?.latitude ?? o?.lat)];
        });
    }
    if (ring.length >= 3 && ring.every(p => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) {
      // 闭合环
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
      rings.push(ring);
    }
  }
  return rings;
}

/** 网格边界框粗筛：先排除明显不相交的小区，避免全量点在多边形内判定 */
function ringBBox(ring: number[][]): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    if (p[0] < minLng) minLng = p[0];
    if (p[0] > maxLng) maxLng = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** 小区点位（只需经纬度与所属网格） */
export interface GridPoint {
  lng: number;
  lat: number;
  gridCode: string;
}

/**
 * 影响范围多边形 → 涉及网格列表。
 *
 * @param ring   多边形环（WGS84）；调用方负责在推定模式下先做 GCJ-02 → WGS84 转换
 * @param points 小区点位
 * @returns 命中的网格编码数组（去重、稳定排序）
 */
export function ringToGridCodes(ring: number[][] | null, points: GridPoint[]): string[] {
  if (!ring || ring.length < 4) return [];
  const [minLng, minLat, maxLng, maxLat] = ringBBox(ring);
  const hit: Record<string, true> = {};
  for (const p of points) {
    if (p.lng < minLng || p.lng > maxLng || p.lat < minLat || p.lat > maxLat) continue;
    if (!p.gridCode) continue;
    if (pointInRing([p.lng, p.lat], ring)) hit[p.gridCode] = true;
  }
  return Object.keys(hit).sort();
}
