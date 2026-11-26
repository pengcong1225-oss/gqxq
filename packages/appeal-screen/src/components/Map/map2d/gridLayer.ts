/**
 * 网格边界图层（标书 1.2 节「社区网格图层」「区域分布采用真实边界」）
 *
 * ===== 数据来源（架构约束）=====
 * 前端**不持有高德 key、不直接调 restapi.amap.com**。原因：
 *   1) `GQXQ_AMAP_KEY` 是后端 .env 已配置的凭证，前端不应复制一份；
 *   2) 高德返回 GCJ-02，必须转 WGS84 才能与 CIM 影像/抖动点位对齐（否则偏移数百米），
 *      该转换已在后端 `domain/utilityCoordinates` 统一实现；
 *   3) 边界是低频数据，服务端缓存 12h，避免大屏每次刷新都打高德（免费额度 QPS 很低）。
 *
 * 因此这里只调用后端接口 `GET /assessment/admin-boundaries`，拿回已是 WGS84 的多边形。
 *
 * ===== 当前能力边界（已实测确认）=====
 *   ✅ 区县级（14 个里 13 个）：后端经高德拿到真实行政边界
 *   ❌ 街道级：高德对街道返回 polyline 为空（街道非独立行政区），
 *      且后端 admin-grids 的 `hasGeometry` 目前全为 false
 *   → 街道层级由渲染层用「小区点位质心 + 件数气泡」表达（位置由真实点位推导，不虚构）
 *
 * 甲方网格边界接口就绪后，只需改后端 `adminBoundaryService`，本文件与渲染层都不用动。
 */

/** 网格/区域边界（与来源无关的统一结构） */
export interface GridBoundary {
  /** 网格编码（区县为 6 位 adcode；甲方接口阶段为真实网格编码） */
  code: string;
  /** 展示名称 */
  name: string;
  /** 层级：市级 / 区县级 / 街道级 / 社区网格级 */
  level: 'city' | 'district' | 'street' | 'grid';
  /** 边界几何：WGS84 [lon, lat] 环（可多环，首环外环，其余内环） */
  polygons: number[][][];
  /**
   * 来源标注，页面要如实显示边界来源：
   *   amap=高德区县边界 / official=甲方正式边界 / pack=边界数据包（OSM 底稿等） / buffer=点位缓冲近似
   */
  source: 'amap' | 'snapshot' | 'official' | 'pack' | 'buffer';
  /** source=pack 时的数据提供方（osm / amap-adat / official-export …） */
  provider?: string;
  /** source=pack 时是否已与网格编码对齐（false 时诉求量聚不上，页面要提示） */
  packMatched?: boolean;
  /**
   * 代表点（WGS84 [lon, lat]）：服务端按「离网格点位均值最近的真实小区」给出。
   * 用作标签与停水停气打点的锚点 —— 直接用多边形质心会落在江面上。
   */
  anchor?: [number, number];
  /**
   * 该网格下的社区（小区）名称（标书 1.2.4 悬停要求显示"社区名称"）。
   * 后端按 community.name 聚合，最多返回 12 个；完整数量看 communityCount。
   */
  communityNames?: string[];
  /** 社区总数（communityNames 可能被截断） */
  communityCount?: number;
}

/**
 * 边界数据包溯源信息（后端 boundaryPackSummary 原样透出）。
 * 为什么必须显示：OSM 是非权威底稿，验收方/客户要能一眼看到来源、抓取时间、许可证、
 * 以及有多少网格还没对上官方编码 —— 否则会被误当成正式网格边界。
 */
export interface BoundaryPackInfo {
  configured: boolean;
  file?: string;
  dataset?: string | null;
  provider?: string | null;
  providerDetail?: string | null;
  license?: string | null;
  attribution?: string | null;
  srid?: number;
  adminLevels?: number[] | null;
  fetchedAt?: string | null;
  featureCount?: number;
  dropped?: { unclosedRing: number; tooFewPoints: number; outOfBoundsRing: number; badGeometry: number };
  note?: string | null;
  error?: string | null;
}

/** 后端边界接口响应形状 */
interface AdminBoundaryResponse {
  boundaries: GridBoundary[];
  source: string;
  /** 高德 key 是否已配置（false 时说明「未配置」而非「拉取失败」） */
  configured: boolean;
  level: string;
  /** 街道边界来源：official=甲方正式边界 / pack=数据包底稿 / buffer=点位缓冲近似 / mixed / none */
  streetSource?: 'official' | 'pack' | 'buffer' | 'mixed' | 'none';
  /** 街道边界计数（按来源拆分） */
  streetCount?: { official: number; pack?: number; buffer: number };
  /** 与 admin_grid 编码对齐成功的数据包要素数 */
  packMatched?: number;
  /** 数据包溯源（未配置时为 null） */
  pack?: BoundaryPackInfo | null;
}

import { API_BASE } from '../../../stats/apiBase';

/** 取当前会话 token（大屏真实数据会话存在 sessionStorage 的 gqxq-token） */
function currentToken(): string | null {
  try {
    return sessionStorage.getItem('gqxq-token');
  } catch {
    return null;
  }
}

export interface BoundaryResult {
  boundaries: GridBoundary[];
  /** 边界是否来自正式接口（true=甲方网格接口，false=区县高德+街道凸包） */
  official: boolean;
  /** 失败/降级原因（用于状态条如实说明），成功时为 null */
  note: string | null;
  /** 街道层来源说明（区分甲方正式 / 数据包底稿 / 点位缓冲） */
  streetSource: 'official' | 'pack' | 'buffer' | 'mixed' | 'none';
  streetCount: { official: number; pack: number; buffer: number };
  /** 数据包溯源（未启用为 null），用于状态条标注「OSM 底稿 / 抓取时间 / 许可证」 */
  pack: BoundaryPackInfo | null;
  /** 区县边界来源统计：amap=高德实时 / snapshot=本地快照（高德不可用时降级） */
  districtSource?: {amap: number; snapshot: number};
  /** 快照元信息（用了快照时才有）：抓取日期让使用者知道数据多旧 */
  districtSnapshot?: {configured: boolean; count: number; fetchedAt: string | null} | null;
  /** 数据包要素中已与 admin_grid 编码对齐的数量（少于 pack 数即存在聚不上诉求的网格） */
  packMatched: number;
}

/**
 * 拉取边界（区县级真实边界，WGS84）。
 *
 * 失败时返回空数组 + note，渲染层据此降级为纯点位质心表达，**不伪造边界**。
 */
export async function fetchGridBoundaries(signal?: AbortSignal): Promise<BoundaryResult> {
  const empty: BoundaryResult = {
    boundaries: [],
    official: false,
    note: null,
    streetSource: 'none',
    streetCount: { official: 0, pack: 0, buffer: 0 },
    pack: null,
    packMatched: 0,
  };
  const token = currentToken();
  if (!token) {
    return { ...empty, note: '未登录，无法获取边界' };
  }
  try {
    const res = await fetch(`${API_BASE}/assessment/admin-boundaries`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      return { ...empty, note: `边界接口 HTTP ${res.status}` };
    }
    const body = (await res.json()) as { code?: number; data?: AdminBoundaryResponse; message?: string };
    if (body.code !== 200 || !body.data) {
      return { ...empty, note: body.message ?? '边界接口返回异常' };
    }
    const list = Array.isArray(body.data.boundaries) ? body.data.boundaries : [];
    const districts = list.filter((b) => b.level === 'district').length;
    const streetSource = body.data.streetSource ?? 'none';
    const rawCount = body.data.streetCount ?? { official: 0, buffer: 0 };
    const streetCount = { official: rawCount.official ?? 0, pack: rawCount.pack ?? 0, buffer: rawCount.buffer ?? 0 };
    const pack = body.data.pack ?? null;
    let note: string | null = null;
    if (!list.length) {
      note = body.data.configured ? '边界拉取失败' : '高德 Key 未配置';
    } else if (districts < 13) {
      note = `区县边界 ${districts}/13（其余无独立边界或拉取失败）`;
    } else if (pack?.error) {
      note = `边界数据包不可用：${pack.error}`;
    } else if ((body.data.districtSource?.snapshot ?? 0) > 0) {
      // 区县层降级到快照：必须显式提示，否则使用者会以为看到的是实时行政边界
      const day = body.data.districtSnapshot?.fetchedAt?.slice(0, 10) ?? '未知日期';
      note = `区县边界来自本地快照（高德不可用，快照 ${day}）`;
    }
    const packMatched = Number(body.data.packMatched ?? 0) || 0;
    return { boundaries: list, official: streetSource === 'official', note, streetSource, streetCount, pack, packMatched };
  } catch (e) {
    return { ...empty, note: `边界请求失败：${(e as Error)?.message ?? e}` };
  }
}

/** 数据包提供方的中文标注（未知时原样回显，绝不美化） */
function packProviderLabel(pack: BoundaryPackInfo | null | undefined): string {
  const p = String(pack?.provider ?? '').trim().toLowerCase();
  if (p === 'osm') return 'OSM 底稿';
  // 由小区点位推导的泰森多边形：有编码、能聚诉求，但形状是推出来的，必须如实标注
  if (p === 'derived-voronoi') return '点位泰森多边形（近似）';
  if (p === 'amap-adat') return '高德企业智图';
  if (p === 'official-export') return '甲方导出';
  if (!p) return '边界数据包';
  return p;
}

/** 边界来源说明（页面状态条用，如实区分官方/数据包底稿/近似） */
export function boundarySourceLabel(
  list: GridBoundary[],
  note: string | null,
  streetSource?: 'official' | 'pack' | 'buffer' | 'mixed' | 'none',
  streetCount?: { official: number; pack?: number; buffer: number },
  pack?: BoundaryPackInfo | null,
  packMatched?: number
): string {
  if (!list.length) return note ?? '无边界数据';
  const districts = list.filter((b) => b.level === 'district').length;
  const streets = list.filter((b) => b.level === 'street').length;
  const parts: string[] = [`区县 ${districts}`];

  if (streets > 0) {
    const sc = streetCount ?? { official: 0, pack: 0, buffer: 0 };
    if (streetSource === 'official') parts.push(`街道 ${streets}（甲方正式边界）`);
    else if (streetSource === 'pack') {
      const unmatched = Math.max(0, (sc.pack ?? 0) - (packMatched ?? 0));
      parts.push(`街道 ${streets}（${packProviderLabel(pack)}${unmatched ? `，${unmatched} 个未对齐编码` : ''}）`);
    } else if (streetSource === 'buffer') parts.push(`街道 ${streets}（点位缓冲近似）`);
    else if (streetSource === 'mixed') {
      const unmatched = Math.max(0, (sc.pack ?? 0) - (packMatched ?? 0));
      parts.push(`街道 ${streets}（正式 ${sc.official} / 底稿 ${sc.pack ?? 0} / 近似 ${sc.buffer}${unmatched ? `；${unmatched} 个底稿未对齐编码` : ''}）`);
    } else parts.push(`街道 ${streets}`);
  } else {
    parts.push('街道未生成');
  }

  // 数据包底稿必须带上「抓取时间 + 许可证 + 署名」：
  // 时效不明/授权不明/未署名（ODbL 强制要求 © OpenStreetMap contributors）在验收时都是硬伤。
  if (streetSource === 'pack' || streetSource === 'mixed') {
    if (pack?.fetchedAt) parts.push(`底稿 ${pack.fetchedAt.slice(0, 10)}`);
    if (pack?.license) parts.push(pack.license);
    if (pack?.attribution) parts.push(pack.attribution);
  }

  const base = parts.join(' · ');
  return note ? `${base} · ${note}` : base;
}