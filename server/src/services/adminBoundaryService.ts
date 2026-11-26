/**
 * 高德行政区边界（标书 1.2 节「社区网格图层」「区域分布采用真实边界」）。
 *
 * 为什么放在后端：
 *   1) `GQXQ_AMAP_KEY` 是后端 .env 里已配置的凭证，前端不应持有 map key；
 *   2) 高德返回 **GCJ-02**，必须转成 **WGS84** 才能与 CIM 影像、抖动坐标对齐（否则偏移数百米），
 *      而 WGS84 转换已在 `domain/utilityCoordinates` 中实现，后端复用同一套，避免两处公式漂移；
 *   3) 行政区边界是低频数据，服务端缓存可避免每次大屏刷新都打高德（免费额度 QPS 很低）。
 *
 * 现状说明：高德对**街道级**返回的 `polyline` 为空（街道不是独立行政区），
 * 因此本接口只提供区县级真实边界；街道层级改用「小区点位质心 + 件数」表达（前端实现）。
 * 甲方网格边界接口就绪后，替换本模块的实现即可，路由与前端契约不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import {env} from '../config/env';
import {utilityGcj02ToWgs84} from '../domain/utilityCoordinates';

export interface AdminBoundary {
  /** 行政区划码（6 位区县码） */
  code: string;
  name: string;
  level: 'district';
  /** WGS84 多边形环：[环][点][lon,lat] */
  polygons: number[][][];
  /** 边界来源，前端据此标注 */
  /** amap=高德实时；snapshot=本地快照（高德不可用时的降级，行政区划准静态） */
  source: 'amap' | 'snapshot';
}

/** 宜昌市下辖区县（与 admin_grid 的 6 位码一致；高新区为兜底码，高德无独立边界） */
export const YICHANG_DISTRICTS: { code: string; name: string }[] = [
  {code: '420502', name: '西陵区'},
  {code: '420503', name: '伍家岗区'},
  {code: '420504', name: '点军区'},
  {code: '420505', name: '猇亭区'},
  {code: '420506', name: '夷陵区'},
  {code: '420525', name: '远安县'},
  {code: '420526', name: '兴山县'},
  {code: '420527', name: '秭归县'},
  {code: '420528', name: '长阳土家族自治县'},
  {code: '420529', name: '五峰土家族自治县'},
  {code: '420581', name: '宜都市'},
  {code: '420582', name: '当阳市'},
  {code: '420583', name: '枝江市'},
];

/** 缓存：边界极少变化，缓存 12 小时 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache: {at: number; data: AdminBoundary[]} | null = null;
let inflight: Promise<AdminBoundary[]> | null = null;

/** 高德免费额度 QPS 很低，串行 + 最小间隔，与 amapGeocoder 同口径 */
const MIN_INTERVAL_MS = 400;
let lastCallAt = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function amapKey(): string | null {
  const key = String(env.amapKey ?? '').trim();
  return key || null;
}

/** 解析高德 polyline（GCJ-02）→ WGS84 多边形环 */
function parsePolylineToWgs84(polyline: string): number[][][] {
  const rings: number[][][] = [];
  for (const ringText of polyline.split('|')) {
    const ring: number[][] = [];
    for (const pair of ringText.split(';')) {
      const [lonText, latText] = pair.split(',');
      const gcjLng = Number(lonText);
      const gcjLat = Number(latText);
      if (!Number.isFinite(gcjLng) || !Number.isFinite(gcjLat)) continue;
      const [lng, lat] = utilityGcj02ToWgs84(gcjLng, gcjLat);
      ring.push([lng, lat]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** 拉单个区县边界；失败返回 null（不抛，调用方过滤） */
async function fetchOne(adcode: string): Promise<AdminBoundary | null> {
  const key = amapKey();
  if (!key) return null;
  const gap = Date.now() - lastCallAt;
  if (gap < MIN_INTERVAL_MS) await wait(MIN_INTERVAL_MS - gap);
  lastCallAt = Date.now();

  const url = new URL('/v3/config/district', env.amapBaseUrl);
  url.searchParams.set('key', key);
  url.searchParams.set('keywords', adcode);
  // 关键：subdistrict=0 拿本级完整边界；=1 时子级（街道）polyline 为空
  url.searchParams.set('subdistrict', '0');
  url.searchParams.set('extensions', 'all');
  url.searchParams.set('output', 'JSON');

  // 高德免费额度 QPS 很低，批量拉 13 个区县必然触发 CUQPS 限流；退避重试最多 4 次
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(12000), headers: {Accept: 'application/json'}});
      if (!res.ok) return null;
      const body = (await res.json()) as any;
      const info = String(body?.info ?? '');
      if (String(body?.status) !== '1') {
        if (/CUQPS|QPS|LIMIT|FREQUENT/i.test(info)) {
          await wait(500 * (attempt + 1) * 2);
          lastCallAt = Date.now();
          continue;
        }
        return null;
      }
      const hit = Array.isArray(body.districts) ? body.districts[0] : null;
      const polyline = hit?.polyline ? String(hit.polyline) : '';
      if (!polyline) return null;
      const polygons = parsePolylineToWgs84(polyline);
      if (!polygons.length) return null;
      const meta = YICHANG_DISTRICTS.find((d) => d.code === adcode);
      return {
        code: adcode,
        name: meta?.name ?? String(hit.name ?? adcode),
        level: 'district',
        polygons,
        source: 'amap',
      };
    } catch {
      await wait(300 * (attempt + 1));
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 本地快照降级 */

/**
 * 区县边界本地快照。
 *
 * 为什么需要：区县边界是**准静态**数据（行政区划调整按年计），但高德是外部依赖 ——
 * 政务内网出口被限、key 过期/欠费、QPS 打满时，实时接口拿不到边界，整层就没了。
 * 快照的作用就是"高德挂了也不白屏"：同样的 13 个区县多边形，source 标成 snapshot，
 * 前端据此如实提示"来自本地快照（日期）"，不冒充实时数据。
 *
 * 生成/更新：npm run boundary:districts（用当前可用的高德结果覆盖快照）。
 */
interface SnapshotCache {file: string; mtimeMs: number; data: AdminBoundary[]; fetchedAt: string | null}
let snapshotCache: SnapshotCache | null = null;

function snapshotFile(): string {
  const raw = String(env.districtSnapshot ?? '').trim() || 'data/boundaries/yichang-districts-snapshot.geojson';
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '../../', raw);
}

/** 读取快照（按 mtime 缓存；文件不存在返回空数组） */
export function loadDistrictSnapshot(): {data: AdminBoundary[]; fetchedAt: string | null} {
  const file = snapshotFile();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return {data: [], fetchedAt: null};
  }
  if (snapshotCache && snapshotCache.file === file && snapshotCache.mtimeMs === st.mtimeMs) {
    return {data: snapshotCache.data, fetchedAt: snapshotCache.fetchedAt};
  }
  try {
    const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const srid = Number(fc?.metadata?.srid ?? 4326);
    if (srid !== 4326) throw new Error('快照坐标系为 EPSG:' + srid + '，只接受 4326');
    const data: AdminBoundary[] = [];
    for (const feat of fc?.features ?? []) {
      const props = feat?.properties ?? {};
      const code = String(props.code ?? '').trim();
      if (code.length !== 6) continue;
      const geom = feat?.geometry;
      const rings: number[][][] = [];
      const push = (ring: any) => {
        if (Array.isArray(ring) && ring.length >= 3) rings.push(ring);
      };
      if (geom?.type === 'Polygon') for (const r of geom.coordinates) push(r);
      else if (geom?.type === 'MultiPolygon') for (const poly of geom.coordinates) for (const r of poly) push(r);
      if (!rings.length) continue;
      data.push({code, name: String(props.name ?? code), level: 'district', polygons: rings, source: 'snapshot'});
    }
    snapshotCache = {file, mtimeMs: st.mtimeMs, data, fetchedAt: String(fc?.metadata?.fetchedAt ?? '') || null};
    if (data.length) console.info('[admin-boundary] 已加载区县快照 ' + data.length + ' 个（' + file + '）');
    return {data, fetchedAt: snapshotCache.fetchedAt};
  } catch (e) {
    console.warn('[admin-boundary] 区县快照解析失败：' + (e as Error)?.message);
    snapshotCache = null;
    return {data: [], fetchedAt: null};
  }
}

/** 快照元信息（供接口透出：前端要知道"这是快照，不是实时"） */
export function districtSnapshotSummary(): {configured: boolean; count: number; fetchedAt: string | null} {
  const {data, fetchedAt} = loadDistrictSnapshot();
  return {configured: data.length > 0, count: data.length, fetchedAt};
}

/**
 * 获取宜昌各区县 WGS84 边界（带 12h 缓存 + 单飞，避免并发重复打高德）。
 * 未配置 key 或全部失败时返回空数组，调用方据此降级为「无边界」并如实说明。
 */
export async function yichangDistrictBoundaries(): Promise<AdminBoundary[]> {
  /*
   * 数据源模式（GQXQ_DISTRICT_SOURCE）：
   *   snapshot（默认，政务网）—— 只读本地快照，**运行时完全不访问高德**：
   *       政务网通常无外网出口，实时接口只会白等超时；快照由离线任务刷新即可。
   *   live —— 只打高德，失败再回退快照（适合有外网的开发/演示环境）。
   *   auto —— 快照优先，快照缺失才打高德（折中）。
   */
  const mode = String(env.districtSource ?? 'snapshot').trim().toLowerCase();
  if (mode === 'snapshot') {
    const snap = loadDistrictSnapshot();
    if (snap.data.length) return snap.data;
    // 快照缺失才退到实时（否则整层消失）
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;
  if (mode === 'auto') {
    const snap = loadDistrictSnapshot();
    if (snap.data.length) return snap.data;
  }
  // 没有高德 key：不空手而归，直接用本地快照（source=snapshot），保证图层不消失
  if (!amapKey()) return loadDistrictSnapshot().data;

  inflight = (async () => {
    const out: AdminBoundary[] = [];
    for (const d of YICHANG_DISTRICTS) {
      const one = await fetchOne(d.code);
      if (one) out.push(one);
    }
    /*
     * 降级：高德只回来一部分（QPS 打满/超时）或缺 key 时，用本地快照补齐缺的区县。
     * 只补缺，不覆盖高德实时值 —— 实时优先，快照兜底，source 逐要素如实标注。
     */
    if (out.length < YICHANG_DISTRICTS.length) {
      const snap = loadDistrictSnapshot();
      if (snap.data.length) {
        const have = new Set(out.map((b) => b.code));
        const added = snap.data.filter((b) => !have.has(b.code));
        if (added.length) {
          console.warn('[admin-boundary] 高德仅返回 ' + out.length + '/' + YICHANG_DISTRICTS.length + ' 个区县，快照补齐 ' + added.length + ' 个');
          out.push(...added);
        }
      }
    }
    cache = {at: Date.now(), data: out};
    inflight = null;
    return out;
  })().catch(() => {
    inflight = null;
    return [] as AdminBoundary[];
  });
  return inflight;
}

/** 高德是否已配置（前端状态条据此区分「未配置」与「拉取失败」） */
export function amapBoundaryConfigured(): boolean {
  return amapKey() !== null;
}