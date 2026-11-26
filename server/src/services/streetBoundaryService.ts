/**
 * 街道级网格边界：缓冲区合并（甲方正式边界优先）
 *
 * ===== 背景 =====
 * 街道（9 位码）级边界没有可靠来源：
 *   · 高德 `/v3/config/district` 对街道返回 polyline 为空（实测确认，街道非独立行政区）；
 *   · 后端 `admin_grid.geometry` 124 条全为 NULL（实测确认）。
 * 标书 1.2 节要求「社区网格图层」「区域分布采用真实边界」，街道层必须可见。
 *
 * ===== 为什么不用凸包 =====
 * 凸包在点位沿江/沿路带状分布时会退化成细长条，跨几公里，与街道实际形状严重不符
 * （实测：西陵、点军一带出现黄色/蓝色大长条横贯全图）。
 *
 * ===== 本模块策略：缓冲区合并 =====
 *   ① 对每个街道的小区点位生成圆形缓冲区（半径可配，默认 300m）；
 *   ② 同一街道的缓冲面做 union，合并成一块/多块连通区域；
 *   ③ 相邻街道的缓冲轻微重叠是可接受的（真实街道本就相邻），不做互相裁切。
 *
 * 形状贴近小区点位分布；公开近似面和标注位置由已有抖动点推导。
 * 甲方把正式边界写入 `admin_grid.geometry` 后，自动改用 official，前端不用改。
 */
import buffer from '@turf/buffer';
import union from '@turf/union';
import {point, featureCollection} from '@turf/helpers';
import type {Pool} from 'mysql2/promise';
import {env} from '../config/env';
import {loadBoundaryPack, type BoundaryPack, type BoundaryPackFeature} from './boundaryPackService';

/** 街道级边界（与区县边界同契约） */
export interface StreetBoundary {
  code: string;
  name: string;
  level: 'street';
  /** WGS84 多边形环：[环][点][lon,lat] */
  polygons: number[][][];
  /**
   * official = 甲方正式边界（admin_grid.geometry）
   * pack     = 边界数据包（OSM 底稿 / 商业授权 / 甲方导出 GeoJSON 均可，见 boundaryPackService）
   * buffer   = 点位缓冲区合并（兜底近似）
   */
  source: 'official' | 'pack' | 'buffer';
  /** source=pack 时，数据包声明的提供方（如 osm / amap-adat / official-export），用于前端如实标注 */
  provider?: string;
  /**
   * source=pack 时是否已与 admin_grid 编码对齐。
   * false 表示该面只有几何、没有对应网格编码（诉求量会聚不上），前端必须如实提示，
   * 不能让人误以为「这个网格 0 件诉求」。
   */
  packMatched?: boolean;
  /**
   * 代表点（WGS84 lon/lat）——用于标签与停水停气打点的锚点。
   *
   * 为什么必须由服务端给：缓冲面是"点位各做 420m 圆再 union"得到的，
   * 它的几何质心经常落在江面/库区上（小溪塔街道的小区绕库区分布，质心就在水中）。
   * 前端如果拿几何质心当锚点，标签和打点标识就会"漂在河上"。
   * 使用该网格下离质心最近的已抖动小区点作为地图标注位置。
   */
  anchor?: [number, number];
  /** 参与生成的点位数 */
  pointCount?: number;
  /** 实际使用的缓冲半径（米），便于前端/排查确认自适应结果 */
  bufferMeters?: number;
  /**
   * 该网格下的社区（小区）名称列表。
   *
   * 标书 1.2.4 要求「鼠标滑动至相应网格后可查看**社区名称**、网格名称、当前该网格的诉求量」，
   * 原先只返回 name/code 导致悬停缺社区名（实测 47 个网格样本 0 个含社区名）。
   * 数据来自 `community.name` 按 `admin_grid_code` 聚合；一个街道网格通常含 30~60 个小区，
   * 前端按「最多显示 N 个 + 共 M 个」的方式呈现，避免浮层过长。
   */
  communityNames?: string[];
  /** 社区总数（communityNames 可能被截断，此字段给全量计数） */
  communityCount?: number;
}

interface LonLat {
  lon: number;
  lat: number;
}

/**
 * 缓冲区半径（米）。
 *
 * 固定半径怎么调都不对，原因是**点位密度差异太大**：
 * · 城区（西陵、伍家岗）小区间距 100~200m，固定 420m 会把连片建成区糊成一整块，
 *   边缘外溢到江面/山体 —— 客户看到「色块铺在河里」就是这种；
 * · 乡镇（长阳、五峰、秭归）小区间距常常 1~3km，半径给小了就碎成七八个孤岛，
 *   街道看起来像撒了一把芝麻。
 *
 * 因此改为**按网格自适应**：
 *   半径 = clamp(0.55 × 该网格点位最近邻距离中位数, MIN, MAX)
 * 城区自然收到 180~200m（贴住建成区，不外溢），
 * 乡镇自动放到 420m（保证连成片）。
 *
 * 仍可用环境变量 `GQXQ_STREET_BUFFER_METERS` 强制指定固定半径（调参/验收对比用）。
 *
 * 注意：这只是「暂无正式街道边界」时的近似表达，前端一律按 source=buffer
 *       画成极淡填充 + 虚线描边，绝不冒充精确网格。
 */
const MIN_BUFFER_METERS = 180;
const MAX_BUFFER_METERS = 420;
const BUFFER_SPACING_RATIO = 0.55;

/** 环境变量强制固定半径；未设置或非法则返回 null（走自适应） */
function fixedBufferMeters(): number | null {
  const v = Number(env.streetBufferMeters ?? '');
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 按点位最近邻距离中位数算该网格的缓冲半径。
 *
 * 用中位数而不是平均值：一个网格里常混着「城区密集段 + 郊区孤立点」，
 * 平均值会被孤立点拉大，中位数代表主体分布。
 */
function adaptiveBufferMeters(points: LonLat[]): number {
  const fixed = fixedBufferMeters();
  if (fixed !== null) return fixed;
  if (points.length < 2) return MIN_BUFFER_METERS;
  // 点数过多时抽样，避免 O(n²) 拖慢接口
  const step = Math.max(1, Math.floor(points.length / 60));
  const sample: LonLat[] = [];
  for (let i = 0; i < points.length; i += step) sample.push(points[i]);
  const nn: number[] = [];
  for (let i = 0; i < sample.length; i += 1) {
    let best = Infinity;
    for (let j = 0; j < sample.length; j += 1) {
      if (i === j) continue;
      const dLat = (sample[j].lat - sample[i].lat) * 111320;
      const dLng = (sample[j].lon - sample[i].lon) * 111320 * Math.cos((sample[i].lat * Math.PI) / 180);
      const d = Math.sqrt(dLat * dLat + dLng * dLng);
      if (d > 0 && d < best) best = d;
    }
    if (Number.isFinite(best)) nn.push(best);
  }
  if (!nn.length) return MIN_BUFFER_METERS;
  nn.sort((a, b) => a - b);
  const median = nn[Math.floor(nn.length / 2)];
  return Math.min(MAX_BUFFER_METERS, Math.max(MIN_BUFFER_METERS, median * BUFFER_SPACING_RATIO));
}

/**
 * 把一组点转成「缓冲区合并后的多边形环」。
 *
 * 做法：每个点生成一个圆缓冲 → union 全部合并。
 * turf.union 已处理了自相交与重叠，返回 MultiPolygon 时拆成多个 Polygon 环。
 */
function buffersToPolygons(points: LonLat[], radiusMeters: number): number[][][] {
  if (!points.length) return [];

  // 单点：直接就是圆，不需要 union（turf v7 的 union 要求至少 2 个几何）
  if (points.length === 1) {
    const only = buffer(point([points[0].lon, points[0].lat]), radiusMeters, {units: 'meters', steps: 8});
    const rings = only?.geometry?.coordinates;
    const out: number[][][] = [];
    const push = (coords: any) => {
      if (!Array.isArray(coords)) return;
      for (const ring of coords) {
        if (!Array.isArray(ring) || ring.length < 4) continue;
        const clean = ring
          .filter((c: any) => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
          .map((c: any) => [Number(Number(c[0]).toFixed(7)), Number(Number(c[1]).toFixed(7))]);
        if (clean.length >= 4) out.push(clean);
      }
    };
    push(rings);
    return out;
  }

  /**
   * 点位合法性校验 —— 必须在 buffer 之前挡掉，否则一个坏点会把整个面拉成跨半球畸形。
   *
   * 已知脏数据形态（实测存在）：
   *   · (0, 0)  —— 未定位记录被写成零值，落在几内亚湾
   *   · 经纬度互串 —— lon/lat 写反，落在两千公里外
   * 宜昌实际范围约 lon 110.2~112.1 / lat 29.9~31.6，这里用放宽的市域外扩框做粗筛，
   * 只挡「明显不可能是宜昌」的点，不追求精确边界（精确边界由网格面本身负责）。
   */
  const isValidPoint = (lon: unknown, lat: unknown): boolean => {
    const x = Number(lon);
    const y = Number(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x === 0 && y === 0) return false;
    return x >= 109.5 && x <= 112.5 && y >= 29.0 && y <= 32.5;
  };

  const buffered: any[] = [];
  let skipped = 0;
  for (const p of points) {
    if (!isValidPoint(p.lon, p.lat)) {
      skipped += 1;
      continue;
    }
    const b = buffer(point([p.lon, p.lat]), radiusMeters, {units: 'meters', steps: 8});
    if (b) buffered.push(b);
  }
  if (skipped > 0) {
    // 如实记录被丢弃的点数，便于发现上游定位质量问题
    console.warn(`[street-boundary] 跳过 ${skipped} 个非法坐标点位（0,0 / 越界 / 经纬度互串）`);
  }
  if (buffered.length < 2) return [];
  // turf v7 的 union 签名：union(featureCollectionOrFeatureArray) —— 传一个集合，不是两个参数
  let merged: any = null;
  try {
    merged = union(featureCollection(buffered as any) as any);
  } catch (e) {
    console.error('[street-boundary] buffer union 失败:', (e as Error)?.message);
    return [];
  }
  if (!merged) return [];

  const rings: number[][][] = [];
  const pushPolygon = (coords: any) => {
    if (!Array.isArray(coords)) return;
    for (const ring of coords) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const clean = ring
        .filter((c: any) => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
        .filter((c: any) => !(Number(c[0]) === 0 && Number(c[1]) === 0))
        .map((c: any) => [Number(Number(c[0]).toFixed(7)), Number(Number(c[1]).toFixed(7))]);
      if (clean.length < 4) continue;
      // 输出侧再校验一次：环的包围盒必须落在市域框内，否则整环丢弃（不输出畸形面）
      const lons = clean.map((c: number[]) => c[0]);
      const lats = clean.map((c: number[]) => c[1]);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      if (minLon < 109.5 || maxLon > 112.5 || minLat < 29.0 || maxLat > 32.5) {
        console.warn(
          `[street-boundary] 丢弃越界环 bbox=[${minLon.toFixed(3)},${minLat.toFixed(3)},${maxLon.toFixed(3)},${maxLat.toFixed(3)}]`
        );
        continue;
      }
      rings.push(clean);
    }
  };

  const geom = merged.geometry;
  if (geom?.type === 'Polygon') pushPolygon(geom.coordinates);
  else if (geom?.type === 'MultiPolygon') for (const poly of geom.coordinates) pushPolygon(poly);

  return rings;
}

/** 从 GeoJSON geometry 提取多边形环（兼容 Polygon / MultiPolygon），已是 WGS84 */
function polygonsFromGeoJson(geometry: any): number[][][] | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const type = String(geometry.type ?? '');
  if (type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.filter((ring: any[]) => Array.isArray(ring) && ring.length >= 3);
  }
  if (type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    const rings: number[][][] = [];
    for (const poly of geometry.coordinates) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) if (Array.isArray(ring) && ring.length >= 3) rings.push(ring);
    }
    return rings.length ? rings : null;
  }
  return null;
}

export interface StreetBoundaryInput {
  pointsByGrid: Map<string, LonLat[]>;
  verificationPointsByGrid: Map<string, LonLat[]>;
  names: Map<string, string>;
  officialGeometry?: Map<string, any>;
  /** 每个街道网格下的社区（小区）名称，用于标书 1.2.4 的悬停「社区名称」 */
  communityByGrid?: Map<string, string[]>;
  /**
   * 边界数据包（可选）。存在时优先级：official(库内几何) → pack(文件) → buffer(点位缓冲)。
   * 换数据源只需换文件 + 改 GQXQ_BOUNDARY_PACK，不改本函数。
   */
  pack?: BoundaryPack | null;
  /** 少于这个点位的街道不生成面（默认 1：单点也能出小圆） */
  minPoints?: number;
  /** 缓冲区半径（米） */
  bufferMeters?: number;
}

/**
 * 生成街道级边界列表。
 *   有正式几何 → official；否则缓冲区合并 → buffer；点位不足 → 跳过。
 */
/**
 * 在点位集合里取「离均值点最近的那一个真实点位」。
 *
 * 直接返回均值点会落在江面（小区绕库区分布时均值在水里），
 * 所以吸附到最近的真实点位，保证代表点在陆地上。
 */
function nearestToMean(pts: LonLat[]): [number, number] | undefined {
  if (!pts.length) return undefined;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.lon;
    sy += p.lat;
  }
  const mx = sx / pts.length;
  const my = sy / pts.length;
  let best: LonLat = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    const dx = p.lon - mx;
    const dy = p.lat - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return [best.lon, best.lat];
}

/**
 * 多边形代表点（面积最大环的 bbox 中心）。
 * 仅用于「数据包有面但没有小区点位」的网格 —— 有真实点位时一律吸附到最近点位
 * （见 nearestToMean 的注释：几何质心常落在江面）。
 */
function bboxAnchor(polygons: number[][][]): [number, number] | undefined {
  let best: number[][] | null = null;
  let bestArea = -1;
  for (const ring of polygons) {
    if (!Array.isArray(ring) || ring.length < 4) continue;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of ring) {
      if (p[0] < minLon) minLon = p[0];
      if (p[0] > maxLon) maxLon = p[0];
      if (p[1] < minLat) minLat = p[1];
      if (p[1] > maxLat) maxLat = p[1];
    }
    const area = (maxLon - minLon) * (maxLat - minLat);
    if (area > bestArea) { bestArea = area; best = ring; }
  }
  if (!best) return undefined;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of best) {
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  return [Number(((minLon + maxLon) / 2).toFixed(7)), Number(((minLat + maxLat) / 2).toFixed(7))];
}


/**
 * 行政名称归一化（仅用于「退而求其次」的名称匹配）。
 *
 * 现实差异：OSM 写「XX街道」，本库写「XX街道办事处」；民族乡 OSM 常省略族名
 * （「XX土家族乡」vs「XX乡」）。精确匹配失败后再用归一化匹配，避免为了对上名字去改数据。
 */
export function normalizeAdminName(name: string): string {
  return String(name ?? '')
    .replace(/\s+/g, '')
    .replace(/街道办事处$/, '街道')
    .replace(/办事处$/, '')
    .replace(/(维吾尔族|土家族|苗族|侗族|彝族|壮族|回族|白族|傣族|布依族|蒙古族|满族|朝鲜族)(?=乡|镇|街道)/g, '')
    .trim();
}

/** 射线法判断点是否在环内（WGS84 平面近似，宜昌尺度误差可忽略） */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat)) {
      const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lon < x) inside = !inside;
    }
  }
  return inside;
}

/** 点在多边形组内（偶奇规则：多重面 + 洞都按奇偶翻转处理） */
function pointInPolygons(polygons: number[][][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of polygons) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    if (pointInRing(lon, lat, ring)) inside = !inside;
  }
  return inside;
}

/**
 * 数据包没有编码/名称对不上时，用小区点位反推归属网格。
 *
 * 判定：网格点位「面内占比」>= 50%，且在所有候选里面内点数最多。
 * 只有点位、没有面，是因为 admin_grid.geometry 全空 —— 这是当前唯一的空间事实来源；
 * 命中后仍标记 matched=true（编码确实对上了），但 packMatched 的语义是「编码对齐」，
 * 不代表边界权威性，前端文案不会因此改口径。
 */
function matchGridByPoints(polygons: number[][][], pointsByGrid: Map<string, {lon: number; lat: number}[]>): string | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const ring of polygons) for (const [x, y] of ring) {
    if (x < minLon) minLon = x;
    if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
  }
  if (!Number.isFinite(minLon)) return null;
  let bestCode: string | null = null;
  let bestInside = 0;
  let bestRatio = 0;
  for (const [code, pts] of pointsByGrid) {
    if (!pts.length) continue;
    let inside = 0;
    for (const p of pts) {
      // bbox 预筛（面都不在的网格直接跳过）
      if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) continue;
      if (pointInPolygons(polygons, p.lon, p.lat)) inside += 1;
    }
    if (!inside) continue;
    const ratio = inside / pts.length;
    if (ratio < 0.5) continue;
    if (inside > bestInside || (inside === bestInside && ratio > bestRatio)) {
      bestCode = code;
      bestInside = inside;
      bestRatio = ratio;
    }
  }
  return bestCode;
}

/**
 * 生成街道级边界列表。
 *
 * 优先级（同一 code 只出一份，保证大屏上不叠面）：
 *   ① official —— admin_grid.geometry（甲方正式边界，权威）
 *   ② pack     —— 边界数据包（OSM 底稿 / 商业授权 / 甲方导出，由 GQXQ_BOUNDARY_PACK 指定）
 *   ③ buffer   —— 小区点位缓冲合并（兜底近似）
 *
 * pack 的编码对齐顺序：9 位官方码命中 admin_grid → 同名命中 admin_grid → 数据包自带码 → 占位码。
 * 命中率会通过 packMatched 标记回传给接口，前端据此如实说明「有多少网格还没对上编码」。
 */
export function buildStreetBoundaries(input: StreetBoundaryInput): StreetBoundary[] {
  const minPoints = input.minPoints ?? 1;
  const boundaries = new Map<string, StreetBoundary>();

  const officialCodes = [...(input.officialGeometry?.keys() ?? [])];
  const pointCodes = [...input.pointsByGrid.keys()];
  const allCodes = new Set<string>([...officialCodes, ...pointCodes]);

  // 名称 → 9 位网格码（用于数据包无编码时按名称对齐）
  const nameToCode = new Map<string, string>();
  for (const [code, name] of input.names) {
    if (!name || nameToCode.has(name)) continue;
    nameToCode.set(name, code);
  }

  // ① 正式边界（权威，最高优先）
  for (const code of allCodes) {
    const officialRings = polygonsFromGeoJson(input.officialGeometry?.get(code));
    if (!officialRings) continue;
    const commNames = input.communityByGrid?.get(code) ?? [];
    boundaries.set(code, {
      code,
      name: input.names.get(code) ?? code,
      level: 'street',
      polygons: officialRings,
      source: 'official',
      anchor: nearestToMean(input.pointsByGrid.get(code) ?? []) ?? bboxAnchor(officialRings),
      communityNames: commNames.slice(0, 12),
      communityCount: commNames.length,
    });
  }

  // ② 边界数据包（可替换数据源）
  const pack = input.pack ?? null;
  const packProvider = String(pack?.meta?.provider ?? 'pack');
  const normalizedNames = new Map<string, string>();
  for (const [code, name] of nameToCode) {
    const key = normalizeAdminName(name);
    if (key && !normalizedNames.has(key)) normalizedNames.set(key, code);
  }
  const putPackFeature = (feat: BoundaryPackFeature, code: string, matched: boolean) => {
    if (!feat.polygons.length || boundaries.has(code)) return;
    const pts = input.pointsByGrid.get(code) ?? [];
    const commNames = input.communityByGrid?.get(code) ?? [];
    boundaries.set(code, {
      code,
      name: input.names.get(code) ?? feat.name ?? code,
      level: 'street',
      polygons: feat.polygons,
      source: 'pack',
      // 要素级来源优先：一个包里可以混装实测面与推导面，前端逐面如实标注
      provider: feat.provider ?? packProvider,
      packMatched: matched,
      anchor: nearestToMean(pts) ?? bboxAnchor(feat.polygons),
      communityNames: commNames.slice(0, 12),
      communityCount: commNames.length,
    });
  };

  const unresolved: BoundaryPackFeature[] = [];
  let packIndex = 0;
  for (const feat of pack?.features ?? []) {
    packIndex += 1;
    // 区县级数据包（level=district）不参与街道层：区县面由 adminBoundaryService 负责，
    // 混在一起会让前端把 6 位码的区县面当街道面渲染。
    if (feat.level === 'district') continue;
    const rawCode = String(feat.code ?? '').trim();
    // ① 数据包自带 9 位官方码且与本库网格一致
    if (/^\d{9}$/.test(rawCode) && input.names.has(rawCode)) {
      putPackFeature(feat, rawCode, true);
      continue;
    }
    // ② 名称精确匹配 → ③ 名称归一化后匹配（如「XX街道办事处」对「XX街道」）
    const exact = feat.name ? nameToCode.get(feat.name) : undefined;
    if (exact) { putPackFeature(feat, exact, true); continue; }
    const norm = feat.name ? normalizedNames.get(normalizeAdminName(feat.name)) : undefined;
    if (norm) { putPackFeature(feat, norm, true); continue; }
    // ④ 数据包自带非 9 位编码（商业包可能是 12 位 streetid 等）——保留原码但标记未对齐
    if (rawCode) { putPackFeature(feat, rawCode, false); continue; }
    unresolved.push(feat);
  }

  /**
   * ⑤ 空间匹配：数据包没有编码也没有可对上的名称时，用本库小区点位判断面归属。
   *
   * 判定规则：某 9 位网格的小区点位有 >= 50% 落在该面内，且该面内网格里它的命中数最高 → 认定归属。
   * 用点位而不是面质心，是因为我们**只有点位**（admin_grid 无几何），点位是当前唯一的空间事实。
   * 匹配不上的面用 PK-<osmId> 占位码输出（packMatched=false），前端会如实提示「未对齐编码」。
   */
  for (const feat of unresolved) {
    const best = matchGridByPoints(feat.polygons, input.verificationPointsByGrid);
    if (best) putPackFeature(feat, best, true);
    else putPackFeature(feat, 'PK-' + (feat.osmRelationId ?? packIndex), false);
  }

  // ③ 缓冲区兜底（只补仍然没有面的网格）
  for (const code of pointCodes) {
    if (boundaries.has(code)) continue;
    const pts = input.pointsByGrid.get(code) ?? [];
    if (pts.length < minPoints) continue;
    // 半径按该网格点位密度自适应（也可用 GQXQ_STREET_BUFFER_METERS 强制固定）
    const radius = input.bufferMeters ?? adaptiveBufferMeters(pts);
    const polygons = buffersToPolygons(pts, radius);
    if (!polygons.length) continue;
    const communityNames = input.communityByGrid?.get(code) ?? [];
    boundaries.set(code, {
      code,
      name: input.names.get(code) ?? code,
      level: 'street',
      polygons,
      source: 'buffer',
      anchor: nearestToMean(pts),
      bufferMeters: Math.round(radius),
      pointCount: pts.length,
      communityNames: communityNames.slice(0, 12),
      communityCount: communityNames.length,
    });
  }

  return [...boundaries.values()];
}

/**
 * 从数据库读取街道网格与小区点位。
 * 点位来源与 `spatial.communities` 一致，只使用已有的成功抖动结果。
 */
export async function loadStreetBoundaryInput(
  db: Pool,
  options?: {districtCodes?: string[]; minPoints?: number; bufferMeters?: number}
): Promise<StreetBoundaryInput> {
  const names = new Map<string, string>();
  const officialGeometry = new Map<string, any>();
  const pointsByGrid = new Map<string, LonLat[]>();
  const verificationPointsByGrid = new Map<string, LonLat[]>();

  const [gridRows] = await db.query<import('mysql2').RowDataPacket[]>(
    'SELECT code, name, geometry FROM admin_grid WHERE CHAR_LENGTH(code) = 9'
  );
  for (const g of gridRows) {
    const code = String(g.code);
    names.set(code, String(g.name ?? code));
    if (g.geometry) {
      try {
        officialGeometry.set(code, typeof g.geometry === 'string' ? JSON.parse(g.geometry) : g.geometry);
      } catch {
        /* 坏 JSON 忽略，走缓冲兜底 */
      }
    }
  }

  const [rows] = await db.query<import('mysql2').RowDataPacket[]>(
    'SELECT admin_grid_code AS gridCode, name AS communityName, ' +
      'jitter_lng AS jitterLng, jitter_lat AS jitterLat, jitter_state AS jitterState, ' +
      'location_lng AS lng, location_lat AS lat ' +
      'FROM community WHERE admin_grid_code IS NOT NULL'
  );
  const communityByGrid = new Map<string, string[]>();
  for (const r of rows) {
    const gid = String(r.gridCode ?? '');
    if (gid.length !== 9) continue;

    // 社区名聚合（标书 1.2.4 悬停要显示社区名称）：去重后按名称排序，稳定可读
    const cname = String(r.communityName ?? '').trim();
    if (cname) {
      const list = communityByGrid.get(gid) ?? [];
      if (!list.includes(cname)) list.push(cname);
      communityByGrid.set(gid, list);
    }

    const original = {lon: Number(r.lng), lat: Number(r.lat)};
    if (r.lng != null && r.lat != null && Number.isFinite(original.lon) && Number.isFinite(original.lat)) {
      const points = verificationPointsByGrid.get(gid) ?? [];
      points.push(original);
      verificationPointsByGrid.set(gid, points);
    }

    if (r.jitterState !== 'succeeded' || r.jitterLng == null || r.jitterLat == null) continue;
    const lon = Number(r.jitterLng);
    const lat = Number(r.jitterLat);
    if (!(lon >= 110 && lon <= 112.3 && lat >= 29.5 && lat <= 31.8)) continue;
    const arr = pointsByGrid.get(gid) ?? [];
    arr.push({lon, lat});
    pointsByGrid.set(gid, arr);
  }
  // 社区名排序（中文按本地化比较），保证每次返回顺序一致
  for (const [gid, list] of communityByGrid) {
    list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    communityByGrid.set(gid, list);
  }

  const allow = options?.districtCodes?.length ? new Set(options.districtCodes) : null;
  if (allow) {
    for (const code of [...pointsByGrid.keys()]) if (!allow.has(code.slice(0, 6))) pointsByGrid.delete(code);
    for (const code of [...verificationPointsByGrid.keys()]) if (!allow.has(code.slice(0, 6))) verificationPointsByGrid.delete(code);
    for (const code of [...names.keys()]) if (!allow.has(code.slice(0, 6))) names.delete(code);
  }

  return {
    pointsByGrid,
    verificationPointsByGrid,
    names,
    officialGeometry,
    communityByGrid,
    minPoints: options?.minPoints,
    bufferMeters: options?.bufferMeters,
  };
}

/* ---------------------------------------------------------------- 结果缓存 */

/**
 * 街道边界缓存。
 * 边界是准静态数据（小区点位不常变、甲方几何不常灌），但缓冲区合并是 CPU 密集操作
 * （33 个街道 × 每街道 N 个点做 union），每次大屏刷新重算会拖慢接口 1~2 秒。
 * 这里缓存 30 分钟；点位或几何变更后可调用 `invalidateStreetBoundaryCache()` 立即失效。
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: {at: number; data: StreetBoundary[]; packSig: string} | null = null;
let inflight: Promise<StreetBoundary[]> | null = null;

export function invalidateStreetBoundaryCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 带缓存的街道边界获取（单飞，避免并发重复计算）。
 *
 * 缓存键里带上数据包签名（路径 + mtime）：换/更新数据包文件后**不需要重启服务**，
 * 下一次请求自动按新文件重算 —— 这就是「数据可替换」的落地点之一。
 */
export async function getStreetBoundariesCached(db: Pool): Promise<StreetBoundary[]> {
  const packResult = loadBoundaryPack();
  if (packResult.error) console.warn('[street-boundary] ' + packResult.error);
  const packSig = packResult.pack ? packResult.pack.file + ':' + packResult.pack.mtimeMs : 'none';
  if (cache && Date.now() - cache.at < CACHE_TTL_MS && cache.packSig === packSig) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const input = await loadStreetBoundaryInput(db);
    const data = buildStreetBoundaries({...input, pack: packResult.pack});
    cache = {at: Date.now(), data, packSig};
    inflight = null;
    return data;
  })().catch((e) => {
    inflight = null;
    console.error('[street-boundary] 生成失败:', (e as Error)?.message);
    return [] as StreetBoundary[];
  });
  return inflight;
}
