/**
 * 边界数据包（Boundary Pack）加载器 —— 「数据可替换」的唯一接入点
 *
 * ===== 为什么要有这一层 =====
 * 街道/社区级边界目前没有稳定公开来源（高德免费接口街道 polyline 为空；
 * admin_grid.geometry 124 条全 NULL）。OSM 底稿只是**过渡数据**，
 * 后续可能是甲方 SHP 导出、高德企业智图 street/village 接口、或天地图数据。
 * 若把「OSM」写进业务代码，换源就要改路由/前端/契约；因此这里只认一个**格式契约**：
 *
 *   FeatureCollection + metadata{provider,license,srid,adminLevels,fetchedAt,...} + WGS84 多边形
 *
 * 换数据 = 换一个文件 + 改一个环境变量，代码零改动。
 *
 * ===== 设计纪律（与 templates/imports/grid_boundary 同源）=====
 *   1) 只接受 EPSG:4326/WGS84 经纬度；srid 不符**直接拒绝**，绝不做隐式投影
 *      （GCJ-02 与 WGS84 在宜昌差 300~680m，静默换算过一次就不再可追溯）；
 *   2) 环必须闭合、点数 >= 4、包围盒落在市域框内，否则整环丢弃并计数上报，
 *      不输出畸形面；
 *   3) 元数据原样透传给接口/前端，用于如实标注「这不是权威边界」；
 *   4) 文件替换后按 mtime+size 自动重载，不需要重启服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import {env} from '../config/env';

/**
 * 数据包可承载的行政层级。
 * street/community/grid 参与街道层渲染；district 仅作占位（区县面由 adminBoundaryService 负责，
 * 混进街道层会让前端把 6 位码的区县面当街道面画），加载后由 buildStreetBoundaries 跳过。
 */
export type PackLevel = 'street' | 'community' | 'grid' | 'district';

export interface BoundaryPackFeature {
  /** 官方区划/网格编码（9 位优先）；数据包没有编码时为空串 */
  code: string;
  name: string;
  level: PackLevel;
  /**
   * 要素级来源（可选）：同一数据包可以混装不同来源的要素，
   * 例如「OSM 实测乡镇面 + 由小区点位推导的泰森多边形」。
   * 为空时回落到包级 metadata.provider。前端据此逐面标注，不会把推导面说成实测面。
   */
  provider?: string;
  /** WGS84 环：[环][点][lon,lat]，首尾闭合 */
  polygons: number[][][];
  osmRelationId?: number;
  /** 数据包自带标签（division_code / ref 等），便于排查 */
  tags?: Record<string, string>;
}

export interface BoundaryPackMeta {
  dataset?: string;
  provider?: string;
  providerDetail?: string;
  license?: string;
  attribution?: string;
  srid?: number;
  adminLevels?: number[];
  fetchedAt?: string;
  note?: string;
  featureCount?: number;
  [k: string]: unknown;
}

export interface BoundaryPack {
  /** 数据包文件绝对路径 */
  file: string;
  /** 文件 mtime（毫秒）——上层缓存按它失效，换文件后无需重启 */
  mtimeMs: number;
  meta: BoundaryPackMeta;
  features: BoundaryPackFeature[];
  /** 被丢弃的环/要素统计（数据质量如实上报） */
  dropped: {unclosedRing: number; tooFewPoints: number; outOfBoundsRing: number; badGeometry: number};
}

export interface BoundaryPackLoadResult {
  pack: BoundaryPack | null;
  /** 配置了路径但加载失败时的原因（接口原样透出，不静默降级） */
  error: string | null;
  /** 配置的文件路径（未配置为 null） */
  configuredFile: string | null;
}

/** 宜昌市域外扩框（与 streetBoundaryService 的点位校验框一致） */
const YICHANG_BBOX = {minLon: 109.5, maxLon: 112.5, minLat: 29.0, maxLat: 32.5};

let cache: {file: string; mtimeMs: number; size: number; pack: BoundaryPack} | null = null;
let lastError: {file: string; mtimeMs: number; size: number; error: string} | null = null;

/** 配置的文件路径（相对路径按 server 根目录解析，与启动 cwd 无关） */
export function packFilePath(): string | null {
  const raw = String(env.boundaryPack ?? '').trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '../../', raw);
}

function ringsFromGeometry(geometry: any): {rings: number[][][]; bad: boolean} {
  if (!geometry || typeof geometry !== 'object') return {rings: [], bad: true};
  const type = String(geometry.type ?? '');
  const coords = geometry.coordinates;
  const out: number[][][] = [];
  const push = (ring: any) => {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const pts: number[][] = [];
    for (const c of ring) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lon === 0 && lat === 0) continue;
      pts.push([Number(lon.toFixed(7)), Number(lat.toFixed(7))]);
    }
    if (pts.length >= 3) out.push(pts);
  };
  if (type === 'Polygon' && Array.isArray(coords)) for (const ring of coords) push(ring);
  else if (type === 'MultiPolygon' && Array.isArray(coords)) {
    for (const poly of coords) if (Array.isArray(poly)) for (const ring of poly) push(ring);
  } else return {rings: [], bad: true};
  return {rings: out, bad: false};
}

function normalizeRing(ring: number[][]): {ring: number[][]; closed: boolean; inBounds: boolean} {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const same = first && last && Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7;
  const closedRing = same ? ring : [...ring, [first[0], first[1]]];
  let inBounds = true;
  for (const [lon, lat] of closedRing) {
    if (lon < YICHANG_BBOX.minLon || lon > YICHANG_BBOX.maxLon || lat < YICHANG_BBOX.minLat || lat > YICHANG_BBOX.maxLat) {
      inBounds = false;
      break;
    }
  }
  return {ring: closedRing, closed: !!same, inBounds};
}

function parsePack(file: string, raw: string, mtimeMs: number): BoundaryPack {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error('不是 FeatureCollection（顶层 type/features 缺失）');
  }
  const meta: BoundaryPackMeta = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
  const srid = Number(meta.srid ?? 4326);
  if (srid !== 4326) {
    throw new Error('数据包坐标系为 EPSG:' + srid + '，本加载器只接受 4326(WGS84)；请先用受控流程转换并记录依据');
  }

  const dropped = {unclosedRing: 0, tooFewPoints: 0, outOfBoundsRing: 0, badGeometry: 0};
  const features: BoundaryPackFeature[] = [];
  for (const f of parsed.features) {
    const props = f?.properties ?? {};
    const {rings, bad} = ringsFromGeometry(f?.geometry);
    if (bad) { dropped.badGeometry += 1; continue; }
    const kept: number[][][] = [];
    for (const ring of rings) {
      if (ring.length < 3) { dropped.tooFewPoints += 1; continue; }
      const n = normalizeRing(ring);
      if (!n.closed) dropped.unclosedRing += 1;
      if (!n.inBounds) { dropped.outOfBoundsRing += 1; continue; }
      kept.push(n.ring);
    }
    if (!kept.length) { dropped.badGeometry += 1; continue; }
    const levelRaw = String(props.level ?? '').trim();
    const level: PackLevel =
      levelRaw === 'community' ? 'community' : levelRaw === 'grid' ? 'grid' : levelRaw === 'district' ? 'district' : 'street';
    features.push({
      code: String(props.code ?? '').trim(),
      name: String(props.name ?? props.code ?? '').trim(),
      level,
      provider: props.provider ? String(props.provider).trim() : undefined,
      polygons: kept,
      osmRelationId: Number.isFinite(Number(props.osmRelationId)) ? Number(props.osmRelationId) : undefined,
      tags: props.tags && typeof props.tags === 'object' ? props.tags : undefined,
    });
  }
  return {file, mtimeMs, meta, features, dropped};
}

/**
 * 读取边界数据包。文件不存在/格式不对时返回 error，而不是抛异常 ——
 * 边界是**展示增强**，不应让整个大屏接口 500；但错误必须如实透出。
 */
export function loadBoundaryPack(): BoundaryPackLoadResult {
  const file = packFilePath();
  if (!file) return {pack: null, error: null, configuredFile: null};
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {pack: null, error: '数据包文件不存在: ' + file, configuredFile: file};
  }
  const maxMb = Number(env.boundaryPackMaxMb ?? '32') || 32;
  if (stat.size > maxMb * 1024 * 1024) {
    return {pack: null, error: '数据包超过 ' + maxMb + 'MB 上限: ' + file, configuredFile: file};
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return {pack: cache.pack, error: null, configuredFile: file};
  }
  if (lastError && lastError.file === file && lastError.mtimeMs === stat.mtimeMs && lastError.size === stat.size) {
    return {pack: null, error: lastError.error, configuredFile: file};
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const pack = parsePack(file, raw, stat.mtimeMs);
    cache = {file, mtimeMs: stat.mtimeMs, size: stat.size, pack};
    lastError = null;
    console.info(
      '[boundary-pack] 已加载 ' + file + ' features=' + pack.features.length +
      ' provider=' + (pack.meta.provider ?? 'unknown') + ' fetchedAt=' + (pack.meta.fetchedAt ?? '-')
    );
    return {pack, error: null, configuredFile: file};
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    lastError = {file, mtimeMs: stat.mtimeMs, size: stat.size, error: '数据包解析失败: ' + msg};
    cache = null;
    console.error('[boundary-pack] 加载失败 ' + file + ' -> ' + msg);
    return {pack: null, error: lastError.error, configuredFile: file};
  }
}

export function resetBoundaryPackCache(): void {
  cache = null;
  lastError = null;
}

/** 供接口透出：数据包配置与元信息（不含几何） */
export function boundaryPackSummary(): Record<string, unknown> | null {
  const {pack, error, configuredFile} = loadBoundaryPack();
  if (!configuredFile) return null;
  if (!pack) return {configured: true, file: configuredFile, error};
  return {
    configured: true,
    file: pack.file,
    dataset: pack.meta.dataset ?? null,
    provider: pack.meta.provider ?? null,
    providerDetail: pack.meta.providerDetail ?? null,
    license: pack.meta.license ?? null,
    attribution: pack.meta.attribution ?? null,
    srid: pack.meta.srid ?? 4326,
    adminLevels: pack.meta.adminLevels ?? null,
    fetchedAt: pack.meta.fetchedAt ?? null,
    featureCount: pack.features.length,
    dropped: pack.dropped,
    note: pack.meta.note ?? null,
  };
}
