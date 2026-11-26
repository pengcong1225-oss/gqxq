/**
 * CIM 行政区划栅格代理（社区网格 / 社区居村 / 乡镇街 / 区县 / 市州）
 *
 * ===== 为什么是「栅格代理」而不是「边界数据」=====
 * 2026-11-24 实测（token + 网关 http://10.55.69.155:8885）：
 *   ✅ map.json / layers.json / image.png 可用；
 *   ❌ queryResults（要素查询）、data/rest（数据服务）、WMS、MVT、vectortile 全部 404；
 *   ❌ layers.json 里 queryable=false（5 个图层全部）。
 * 也就是说 CIM 这批「抖动-行政区划-*」只开放**出图**，没有要素/属性通道。
 * 因此这里只能把 image.png 按 viewBounds 取回来当**边界参考层**：
 *   · 能满足「网格图层可见、可叠加」，且 EPSG:4490 与 CIM 影像严丝合缝；
 *   · **不能满足**五色热力 / hover 显示网格名与诉求量 / 点击下钻 —— 那些要等 CIM 开数据服务或矢量瓦片。
 *
 * ===== 纪律 =====
 *   1) token 只留在服务端（平台级凭证，泄露=全平台可用），接口只返回 PNG；
 *   2) 只允许请求宜昌市域内的 bbox + 白名单图层 + 尺寸上限，避免被当成任意代理；
 *   3) 按 bbox 精度做磁盘缓存（边界是准静态数据，TTL 6h），上游不可达时**回退旧缓存**；
 *   4) 上游失败不抛 500：返回结构化 reason，前端安静降级（边界层是增强项）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {env} from '../config/env';

/** 图层白名单：level → CIM map 服务（uuid 来自《CIM-配置2》） */
export const CIM_LEVELS: Record<string, {uuid: string; map: string; label: string}> = {
  /** 社区网格 —— 标书 1.2「社区网格图层」的主数据 */
  sqwg: {uuid: 'f00d10cb18e9465ebbc9491262032bc3', map: 'xzqh_sqwg', label: '社区网格'},
  sqjcglqy: {uuid: 'ab804c9c26b6451480e82ca5b8ea78c9', map: 'xzqh_sqjcglqy', label: '社区居村管理区域'},
  xzj: {uuid: '8ca10d129b5545dda6088021ef598997', map: 'xzqh_xzj', label: '乡镇街'},
  qx: {uuid: '5b811282779347b18f9d6f0a831f6fae', map: 'xzqh_qx', label: '区县'},
  sz: {uuid: 'ac3ef97f37bf4ebd89effef9b2405207', map: 'xzqh_sz', label: '市州'},
};

/** 宜昌市域框（CIM 服务 bounds 外扩一点），超出即拒绝 */
const CITY = {minLon: 110.2, maxLon: 112.15, minLat: 29.9, maxLat: 31.62};
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface GridOverlayRequest {
  level: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
}

export interface GridOverlayResult {
  ok: boolean;
  png?: Buffer;
  fromCache?: boolean;
  reason?: string;
  meta?: {level: string; map: string; label: string; bbox: number[]; width: number; height: number};
}

function cacheDir(): string {
  const configured = String(env.cimOverlayCacheDir ?? '').trim();
  return configured ? path.resolve(__dirname, '../../', configured) : path.resolve(__dirname, '../../.dev-logs/cim-overlay-cache');
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function cacheKey(req: GridOverlayRequest): string {
  const sig = [req.level, ...req.bbox.map((v) => v.toFixed(4)), req.width, req.height].join('|');
  return createHash('sha1').update(sig).digest('hex');
}

function overlayMeta(level: string, map: string, label: string, bbox: number[], width: number, height: number) {
  return {level, map, label, bbox, width, height};
}

/** 取一张网格边界面（成功返回 PNG Buffer） */
export async function fetchGridOverlay(req: GridOverlayRequest): Promise<GridOverlayResult> {
  const token = String(env.cimToken ?? '').trim();
  const base = String(env.cimMapBase ?? 'http://10.55.69.155:8885/gtis/map/rest').replace(/\/+$/, '');
  const def = CIM_LEVELS[req.level];
  if (!def) return {ok: false, reason: '未知图层：' + req.level + '（允许：' + Object.keys(CIM_LEVELS).join('/') + '）'};
  if (!token) return {ok: false, reason: 'CIM 令牌未配置（GQXQ_CIM_TOKEN）'};

  const west = Number(req.bbox[0]);
  const south = Number(req.bbox[1]);
  const east = Number(req.bbox[2]);
  const north = Number(req.bbox[3]);
  if (![west, south, east, north].every((v) => Number.isFinite(v))) return {ok: false, reason: 'bbox 非法'};
  if (west >= east || south >= north) return {ok: false, reason: 'bbox 需为 W<S,E,N'};
  if (west < CITY.minLon || east > CITY.maxLon || south < CITY.minLat || north > CITY.maxLat) {
    return {ok: false, reason: 'bbox 超出宜昌市域（拒绝当任意代理用）'};
  }
  const width = clamp(Math.round(req.width), 128, 2048);
  const height = clamp(Math.round(req.height), 128, 2048);
  const meta = overlayMeta(req.level, def.map, def.label, [west, south, east, north], width, height);

  const key = cacheKey({...req, width, height});
  const dir = cacheDir();
  const file = path.join(dir, key + '.png');
  const metaFile = path.join(dir, key + '.json');
  const ttl = Number(env.cimOverlayCacheTtlMs ?? DEFAULT_TTL_MS) || DEFAULT_TTL_MS;

  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < ttl) {
      return {ok: true, png: fs.readFileSync(file), fromCache: true, meta};
    }
  } catch {
    /* 无缓存 */
  }

  const viewBounds = '{leftBottom:{x:' + west.toFixed(6) + ',y:' + south.toFixed(6) + '},rightTop:{x:' + east.toFixed(6) + ',y:' + north.toFixed(6) + '}}';
  const url =
    base + '/' + def.uuid + '/rest/maps/' + def.map + '/image.png' +
    '?transparent=true&cacheEnabled=false' +
    '&width=' + width + '&height=' + height +
    '&viewBounds=' + encodeURIComponent(viewBounds) +
    '&token=' + encodeURIComponent(token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env.cimOverlayTimeoutMs ?? 20000) || 20000);
  try {
    const res = await fetch(url, {signal: ctrl.signal, headers: {accept: 'image/png'}});
    clearTimeout(timer);
    if (!res.ok) throw new Error('CIM HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('CIM 返回内容过小（' + buf.length + 'B），疑似空图');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(file, buf);
    fs.writeFileSync(metaFile, JSON.stringify({...meta, fetchedAt: new Date().toISOString()}));
    return {ok: true, png: buf, fromCache: false, meta};
  } catch (e) {
    clearTimeout(timer);
    const msg = (e as Error)?.message ?? String(e);
    try {
      if (fs.existsSync(file)) {
        console.warn('[cim-overlay] 上游失败，回退过期缓存：' + msg);
        return {ok: true, png: fs.readFileSync(file), fromCache: true, reason: '上游不可达，已回退旧缓存（' + msg + '）', meta};
      }
    } catch {
      /* ignore */
    }
    return {ok: false, reason: 'CIM 出图失败：' + msg};
  }
}

/** 配置摘要（不含 token），供诊断端点 */
export function cimOverlaySummary(): Record<string, unknown> {
  return {
    configured: Boolean(String(env.cimToken ?? '').trim()),
    base: String(env.cimMapBase ?? '').replace(/\/+$/, ''),
    levels: Object.fromEntries(Object.entries(CIM_LEVELS).map((entry) => [entry[0], entry[1].label])),
    cacheDir: cacheDir(),
    cacheTtlMs: Number(env.cimOverlayCacheTtlMs ?? DEFAULT_TTL_MS) || DEFAULT_TTL_MS,
  };
}
