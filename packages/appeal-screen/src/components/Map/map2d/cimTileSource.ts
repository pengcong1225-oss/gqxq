/**
 * CIM 2D 影像瓦片源（二维大屏用）
 *
 * ===== 为什么必须用 CIM 的 2D 影像 =====
 * 大屏小区点位使用「抖动坐标」（EPSG:4326，来自数据中心脱敏偏移），三维白模几何本身是按抖动坐标
 * 生成的。若底图换成天地图/OSM/ArcGIS 等其它影像源，虽然都是 4326/3857，但 CIM 的 4490 影像
 * 与这些底图在制图配准上并不保证逐像素一致，叠加后会出现几十米级偏移 —— 这是已经踩过的坑。
 * 因此二维大屏的底图固定使用 CIM 影像，不混用其它影像源。
 *
 * ===== 双源策略（drs 优先，网关兜底）=====
 *   ① drs    ：`drs.sc.yichang.gov.cn` 官方接口方（宜昌市 2026 年 0.5 米影像），走 /cim 代理注入 token
 *   ② gateway：`59.208.236.145` 平台公共地图瓦片网关（诉求大屏同源），走 /cimtile 代理（带磁盘缓存）
 *
 * 两者是**同一份影像、同一套 4490 网格**（图层名同为 yichang20260922_0d5），
 * 因此底图与业务点位的配准完全一致，切换源不会导致偏移。
 * drs 在政务内网/专线环境可达（正式交付环境）；gateway 在公网可达（开发机/演示环境）。
 * 运行时先探 drs，通就用 drs，不通自动落到 gateway，**都不通才如实报「影像不可达」**。
 *
 * ===== 网格参数（**已按实测修正**）=====
 *   crs            EPSG:4490（轴序 纬/经）
 *   topLeftCorner  [90, -180]（纬度、经度）
 *   tileWidth/Height 256
 *   L0 分辨率       360/256 = 1.40625°  逐级 /2  ← **标准 EPSG:4326 网格**
 *
 * ⚠️ 2026-11-25 修掉一个致命错位（客户反馈「底图和色块错开大半个屏」）：
 *   cim.json 里记的 L0 是 1.4078260157（由 drs GetCapabilities 的 ScaleDenominator
 *   ×0.00028/111319.49 换算而来）。它与网关实际使用的标准 4326 网格 L0=360/256=1.40625
 *   相差 **0.11%**。这个误差在瓦片索引里会被**线性放大**：
 *       col = (lon+180) / (L0/2^z*256)
 *   在 z=13、col≈6628 时，0.11% 就是 **7 个瓦片 ≈ 29.5 km** 的横向错位
 *   （行方向 ≈1.5 个瓦片 ≈ 7 km）。表现为整幅影像西移约 30km，
 *   于是「小区点全跑到水里去了」——点位其实没错，是底图取到了别处。
 *
 *   实测判据（同一 (z,row,col) 对比）：
 *     · L0=1.4078260157 → 取到的是一片山区（无长江、无城区）
 *     · L0=360/256      → 取到宜昌城区 + 长江 + 葛洲坝，与真实地理吻合
 *   因此固定使用 360/256。**若将来 drs 官方源可用且其网格确为 1.4078260157，
 *   需按 source 分别给 L0（见 resolveL0ForSource）。**
 */

/** CIM 影像图层名（与 cim.json wmts.layer 一致） */
export const CIM_LAYER = 'yichang20260922_0d5';

/** 最小可用层级：再往外全市会糊成一片，二维大屏默认视野也不需要 */
export const CIM_MIN_LEVEL = 7;
/** 最大层级：L18 约 0.05 m/px，再往下服务也不出图 */
export const CIM_MAX_LEVEL = 18;

/**
 * L0 分辨率（度/像素）。
 *
 * **必须是 360/256 = 1.40625**（标准 EPSG:4326 网格），不能用 cim.json 里的
 * 1.4078260157 —— 后者有 0.11% 误差，在 z=13 会被放大成 ~30km 的瓦片错位，
 * 表现为整幅影像西移、小区点落水。详细推导见文件头注释。
 */
const L0_RESOLUTION = 360 / 256;

/** CIM WMTS 路径（cim.json wmts.url 去掉 origin；经 /cim 代理转发并注入 token） */
const CIM_WMTS_PATH =
  '/api/restapi/prod/IC42050020261004000001/tip-gateway/proxy/74d67b414b5b77f8b72ceb8af1047500' +
  '/server/rest/services/yichang20260922_0d5/MapServer/WMTS';

/** 瓦片源：drs 官方接口 / gateway 平台网关 / amap 高德底图（最终兜底） */
export type TileSource = 'drs' | 'gateway' | 'amap';

/** 源的中文展示名（页面状态条用） */
export function sourceLabel(source: TileSource): string {
  if (source === 'drs') return 'CIM 官方影像接口（drs）';
  if (source === 'gateway') return 'CIM 影像网关（59.208.236.145）';
  return '高德底图（兜底）';
}

/* ================================================================ 高德底图兜底 */

/**
 * 高德底图瓦片（WebMercator/XYZ 网格）。
 *
 * 什么时候用：CIM 的两条源（drs / 网关）都不可达时，用高德影像保证底图不黑屏。
 *
 * ⚠️ 坐标风险（必须让用户看见）：
 *   高德用的是 GCJ-02（火星坐标），与 CIM 的 WGS84 在宜昌有约 680m 偏移。
 *   因此高德底图**只作视觉兜底**，业务点位仍按真实 WGS84 经纬度落图 —— 此时底图与点位
 *   之间会有约 680m 的相对偏移。页面状态条必须明确标注「底图与点位存在坐标偏差」，
 *   不能让使用者误以为点位放错了。
 *
 * 瓦片地址：高德影像（satellite）
 *   https://webst0{1-4}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}
 */

/**
 * 是否允许用高德影像做底图兜底。
 *
 * **政务网默认关闭**（VITE_BASEMAP_AMAP=false）：政务网无外网出口，探高德只会白等 8s，
 * 而且高德是 GCJ-02，与 CIM 的 WGS84 差约 680m —— 拿它兜底会让点位看起来"错位"，
 * 比深色底更糟。关闭后 CIM 两条源都不通时如实显示"影像不可达"，不伪造影像。
 *
 * 有外网的开发/演示环境构建时传 VITE_BASEMAP_AMAP=true 即可恢复兜底。
 */
const AMAP_BASEMAP_ENABLED = import.meta.env.VITE_BASEMAP_AMAP === 'true';

/** 高德影像瓦片模板（style=6 = 卫星影像），子域 1~4 轮询 */
export function amapSatelliteTileUrl(): string {
  return 'https://webst0{1-4}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}';
}

/** 高德路网注记叠加层（影像上叠注记，便于辨认位置；不带注记时纯影像不好读） */
export function amapLabelTileUrl(): string {
  return 'https://webst0{1-4}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}';
}

/** 高德底图的可用层级（官方支持 3~18） */
export const AMAP_MIN_LEVEL = 3;
export const AMAP_MAX_LEVEL = 18;

/** 高德的 GCJ-02 与 WGS84 在宜昌的偏移（米），用于状态条如实提示 */
export const AMAP_GCJ_OFFSET_METERS = 680;

/**
 * 构造 ol 需要的「自定义 tileGrid」参数。
 *
 * ol 的 tileGrid 以 extent 原点向左上展开，而 CIM 网格是全球统一的 4490 网格，
 * 因此这里不用 extent 做原点，而是直接用全量分辨率表 + matrixIds，
 * 让 ol 按「L 层 2^L × 2^(L-1)」的全局网格计算行列号（与后端 iServer 完全一致）。
 */
export function buildCimTileGridParams() {
  const resolutions: number[] = [];
  const matrixIds: string[] = [];
  for (let level = 0; level <= CIM_MAX_LEVEL; level += 1) {
    resolutions.push(L0_RESOLUTION / 2 ** level);
    matrixIds.push(String(level));
  }
  return {
    /** 全球 4490 网格范围：经度 [-180,180]，纬度 [-90,90] */
    extent: [-180, -90, 180, 90] as [number, number, number, number],
    origin: [-180, 90] as [number, number],
    resolutions,
    matrixIds,
    tileSize: 256,
  };
}

/** 构造 KVP 参数（两源共用同一套 WMTS 取瓦片参数） */
function tileQuery(level: number, col: number, row: number): string {
  return new URLSearchParams({
    layer: CIM_LAYER,
    style: 'default',
    tilematrixset: 'default',
    format: 'image/jpgpng',
    service: 'WMTS',
    version: '1.0.0',
    request: 'GetTile',
    tilematrix: String(level),
    tilerow: String(row),
    tilecol: String(col),
  }).toString();
}

/** 拼接一个真实瓦片的请求 URL（按源走不同代理前缀，KVP 参数一致） */
export function cimTileUrl(level: number, col: number, row: number, source: TileSource): string {
  const qs = tileQuery(level, col, row);
  return source === 'drs' ? `/cim${CIM_WMTS_PATH}?${qs}` : `/cimtile?${qs}`;
}

/**
 * 瓦片 URL 模板，直接给 ol 的 XYZ source 用（{z}/{x}/{y} 是 ol 占位符）。
 * z/tilematrix、x/tilecol、y/tilerow 一一对应，不做层级偏移 —— 4490 网格本身与
 * ol 自定义 tileGrid 完全同构，额外偏移会错位。
 */
export function cimTileUrlTemplate(source: TileSource): string {
  const qs =
    `layer=${CIM_LAYER}&style=default&tilematrixset=default&format=image%2Fjpgpng` +
    '&service=WMTS&version=1.0.0&request=GetTile&tilematrix={z}&tilerow={y}&tilecol={x}';
  return source === 'drs' ? `/cim${CIM_WMTS_PATH}?${qs}` : `/cimtile?${qs}`;
}

/** 度 → 瓦片列号（4490 全局网格） */
export function lonToCol(lon: number, level: number): number {
  const cols = 2 ** level;
  return Math.floor(((lon + 180) / 360) * cols);
}

/** 度 → 瓦片行号（4490 全局网格：L 层共 2^(L-1) 行） */
export function latToRow(lat: number, level: number): number {
  const rows = 2 ** (level - 1);
  return Math.floor(((90 - lat) / 180) * rows);
}

/** 瓦片矩形（经纬度边界），供离线核对与调试用 */
export function tileBounds(level: number, col: number, row: number) {
  const cols = 2 ** level;
  const rows = 2 ** (level - 1);
  return {
    west: (col / cols) * 360 - 180,
    east: ((col + 1) / cols) * 360 - 180,
    north: 90 - (row / rows) * 180,
    south: 90 - ((row + 1) / rows) * 180,
  };
}

export type CimProbeResult = {
  /** 是否有任一源可用（决定底图能不能上真影像） */
  ok: boolean;
  /** 最终生效的源（都不可达时为 null） */
  source: TileSource | null;
  /** 探测用的层级 */
  level: number;
  /** 探测点所在瓦片 */
  col: number;
  row: number;
  /** 失败原因（ok=false 时有值，用于页面如实标注） */
  reason?: string;
  /** 各源探测耗时（毫秒），页面状态条展示 */
  timings: { drs?: number; gateway?: number; amap?: number };
};

/** 宜昌市中心（用于探测：这个位置一定有影像） */
const PROBE_CENTER = { lon: 111.2905, lat: 30.6945 };

/**
 * 探测用坐标抖动（度）。
 *
 * 为什么不能只探市中心那一张：
 *   生产链路的 /cimtile 有 24h 磁盘缓存（scripts/serve-screens.mjs），市中心瓦片几乎必然
 *   命中缓存。如果上游网关已经死了、只是缓存还热着，探这张瓦片会返回 200 图片 →
 *   被判定「gateway 可用」→ 不切高德。但用户一旦平移到缓存外的视野，整屏都是 504 留白，
 *   而此时状态卡仍显示「网关兜底」，极具误导性（实测踩过：网关已全断，探测仍报健康）。
 *
 * 处理：探测点每次随机偏移到城区外围（最多 ±0.05°，宜昌范围内量级约 5km），
 *   让探测大概率落在未缓存瓦片上，从而反映**上游真实状态**而不是缓存状态。
 */
const PROBE_JITTER_DEG = 0.05;

function probePoint(): { lon: number; lat: number } {
  const j = () => (Math.random() - 0.5) * 2 * PROBE_JITTER_DEG;
  return { lon: PROBE_CENTER.lon + j(), lat: PROBE_CENTER.lat + j() };
}

/** 探测单个源的一张真实瓦片 */
async function probeOne(
  source: TileSource,
  level: number,
  col: number,
  row: number,
  timeoutMs: number
): Promise<{ ok: boolean; reason?: string; ms: number }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cimTileUrl(level, col, row, source), {
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/*' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, ms: elapsed() };
    const blob = await res.blob();
    const type = blob.type || '';
    if (!type.startsWith('image/')) {
      // 鉴权失败的典型表现：HTTP 200 但 body 是 JSON（网关 tip-token / route forbidden 场景）
      return { ok: false, reason: `返回非图片（${type || '未知类型'}）`, ms: elapsed() };
    }
    if (blob.size < 200) return { ok: false, reason: `内容过小（${blob.size}B）`, ms: elapsed() };
    return { ok: true, ms: elapsed() };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === 'AbortError';
    return {
      ok: false,
      reason: isAbort ? `超时（>${Math.round(timeoutMs / 1000)}s）` : `网络错误：${(e as Error)?.message ?? e}`,
      ms: elapsed(),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 探测 CIM 影像瓦片可用性，确定生效源（drs 优先，网关兜底）。
 *
 * 两者都不通时 ok=false，界面据此展示「CIM 影像不可达」+ 原因，**不伪造影像**。
 *
 * @param level 探测层级（默认 14，约 1:6000，市中心一定有影像）
 * @param drsTimeoutMs drs 探测超时（默认 6s；内网不通时 TCP 会挂到超时才断，不能等太久）
 */
/**
 * 探测 CIM 影像瓦片可用性，确定生效源。
 *
 * 超时取值考虑：首屏不能干等。三级探测最坏耗时 = drs + gateway + amap。
 *   drs 4s（已知 route_id forbidden，快速失败）+ gateway 8s + amap 8s ≈ 20s 上限。
 * 实测网关全断场景下用户约 12s 看到高德底图，可接受；网关可用时 200~800ms 即出。
 */
export async function probeCimTiles(level = 14, drsTimeoutMs = 4_000): Promise<CimProbeResult> {
  // 用抖动后的探测点，避免命中 /cimtile 磁盘缓存而误判上游健康
  const pt = probePoint();
  const col = lonToCol(pt.lon, level);
  const row = latToRow(pt.lat, level);
  const timings: { drs?: number; gateway?: number; amap?: number } = {};

  /**
   * 探一条源：抖动点 + 相邻点各试一次，任一成功即判可用。
   *
   * 为什么要两点：
   *   1) 抖动点可能恰好落在一片「该层级本来就没影像」的区域（204），单点失败会被误判成
   *      「整条源不可用」而白白降级；
   *   2) 语义上我们关心的是「这座城市还能不能出图」，不是「这一张瓦片存不存在」。
   */
  const probeSource = async (
    source: TileSource,
    timeoutMs: number
  ): Promise<{ ok: boolean; reason?: string; ms: number }> => {
    const started = Date.now();
    // 两点**并发**发起：失败路径不会翻倍等待（串行时 12s 会变成 24s，实测用户干等）
    const [first, second] = await Promise.all([
      probeOne(source, level, col, row, timeoutMs),
      probeOne(source, level, col + 2, row, timeoutMs),
    ]);
    const ms = Date.now() - started;
    if (first.ok) return { ok: true, ms };
    if (second.ok) return { ok: true, ms };
    return {
      ok: false,
      reason: first.reason === second.reason ? first.reason : `${first.reason}；${second.reason}`,
      ms,
    };
  };

  // ① drs 官方接口优先
  const drs = await probeSource('drs', drsTimeoutMs);
  timings.drs = drs.ms;
  if (drs.ok) {
    return { ok: true, source: 'drs', level, col, row, timings };
  }

  // ② gateway 网关兜底（公网可达，通常数百毫秒出图）
  const gw = await probeSource('gateway', 8_000);
  timings.gateway = gw.ms;
  if (gw.ok) {
    return { ok: true, source: 'gateway', level, col, row, timings };
  }

  // ③ 高德底图最终兜底（政务网默认关闭：见 AMAP_BASEMAP_ENABLED 注释）
  let amapReason = '已关闭';
  if (AMAP_BASEMAP_ENABLED) {
    const amap = await probeAmap(level);
    amapReason = amap.reason ?? '不可用';
    timings.amap = amap.ms;
    if (amap.ok) {
      return { ok: true, source: 'amap', level, col, row, timings };
    }
  }

  return {
    ok: false,
    source: null,
    level,
    col,
    row,
    reason: `drs：${drs.reason ?? '不可用'}；网关：${gw.reason ?? '不可用'}；高德：${amapReason}`,
    timings,
  };
}

/** 探测高德底图瓦片是否可用（WebMercator 标准 XYZ，直接用瓦片站点探测） */
async function probeAmap(level: number): Promise<{ ok: boolean; reason?: string; ms: number }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  // 宜昌市中心 → WebMercator 行列号
  const z = Math.min(AMAP_MAX_LEVEL, Math.max(AMAP_MIN_LEVEL, level));
  const n = 2 ** z;
  const x = Math.floor(((PROBE_CENTER.lon + 180) / 360) * n);
  const latRad = (PROBE_CENTER.lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  const url = `https://webst01.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'image/*' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, ms: elapsed() };
    const blob = await res.blob();
    if (!(blob.type || '').startsWith('image/')) {
      return { ok: false, reason: `返回非图片（${blob.type || '未知'}）`, ms: elapsed() };
    }
    if (blob.size < 500) return { ok: false, reason: `内容过小（${blob.size}B）`, ms: elapsed() };
    return { ok: true, ms: elapsed() };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === 'AbortError';
    return {
      ok: false,
      reason: isAbort ? '探测超时' : `网络错误：${(e as Error)?.message ?? e}`,
      ms: elapsed(),
    };
  } finally {
    window.clearTimeout(timer);
  }
}