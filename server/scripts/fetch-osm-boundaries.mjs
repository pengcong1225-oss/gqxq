#!/usr/bin/env node
/**
 * fetch-osm-boundaries.mjs — 从 OpenStreetMap（Overpass API）抓取行政边界，生成「边界数据包」（Boundary Pack）
 *
 * 用途：还没有甲方权威边界 / 商业街道边界时的**可替换底稿**。
 * 设计纪律（与 templates/imports/grid_boundary 同源）：
 *   1) 只输出 WGS84（EPSG:4326）经纬度，不做隐式投影；
 *   2) 元数据（数据源 / 抓取时间 / 许可证 / admin_level / 要素数 / 分块）写进 FeatureCollection.metadata，
 *      接口与前端据此如实标注「OSM 底稿」，绝不冒充正式网格；
 *   3) 原始 Overpass 响应另存 raw 目录，便于复核；只读远端，不写远端。
 *
 * 为什么按 bbox 分块查：Overpass 对「按名称查 relation」或无界全表扫描极慢（实测 90s+ 超时），
 * 按小 bbox 查 admin_level 才稳定返回（实测单块 30~60s）。分块后按 relation id 去重合并。
 *
 * 用法：
 *   node scripts/fetch-osm-boundaries.mjs --levels=8 --tiles=2
 *   node scripts/fetch-osm-boundaries.mjs --levels=10 --tiles=3 --out=../data/boundaries/osm-yichang-villages.geojson
 *   node scripts/fetch-osm-boundaries.mjs --levels=8 --dry-run
 *
 * 参数：
 *   --levels=8,10     OSM admin_level（中国：8=乡镇/街道, 10=村/社区, 11=网格）
 *   --bbox=S,W,N,E    抓取范围（默认宜昌市域外扩框 29.55,110.05,31.95,112.25）
 *   --tiles=N         把 bbox 切成 N×N 块逐块查询（默认 2；查询超时就加大）
 *   --timeout=300     单块查询超时（秒）
 *   --overpass=<url>  Overpass endpoint；默认按可用镜像顺序重试
 *   --out=<path>      输出路径（默认 ../data/boundaries/osm-yichang-admin<levels>.geojson）
 *   --raw-dir=<path>  原始响应目录（默认 ../.dev-logs/osm-fetch）
 *   --dry-run         只打印统计，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');

const DEFAULTS = {
  levels: '8',
  areaName: '宜昌市',
  bbox: '29.55,110.05,31.95,112.25',
  tiles: 2,
  timeout: 300,
  rawDir: path.join(SERVER_ROOT, '.dev-logs', 'osm-fetch'),
  /**
   * UA 必须精确匹配镜像白名单格式（实测 2026-11-24）：
   *   'gqxq-boundary-pack/1.0 (zhuxin project)'  → 200
   *   'gqxq-boundary-pack/1.0 (zhuxin project; boundary research)' → 403（括号里带分号即被拒）
   *   'ZhuxinBoundaryPack/1.0 (contact: ...)'    → 403
   * 所以这里保持「name/version (owner)」的最简形态，不要加分号/邮箱。
   */
  ua: 'gqxq-boundary-pack/1.0 (zhuxin project)',
};
/**
 * 镜像可用性实测（2026-11-24，本机出口）：
 *   · overpass.openstreetmap.fr —— 首选（实测 3s；带 UA）
 *   · overpass-api.de / lz4 / z —— 需带 UA（否则 406），高峰期 502「queue full」→ 退避重试
 *   · kumi.systems / private.coffee —— /status 正常但 interpreter 挂起（不可用）
 *   · overpass.osm.ch —— 瑞士区域镜像，中国范围静默返回 0 个要素（会伪装成"查到了但是空"，绝不能进默认链）
 *   · maps.mail.ru —— 504；overpass.nchc.org.tw —— TLS 失败；overpass.osm.jp —— TLS 失败
 */
const OVERPASS_MIRRORS = [
  // 法国镜像：实测 3s 返回（2026-11-24），作为首选
  'https://overpass.openstreetmap.fr/api/interpreter',
  // 主站：高峰期 502 queue full，退避重试后可用
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

function parseArgs(argv) {
  const out = {...DEFAULTS, dryRun: false, out: null, overpass: null, bboxOnly: false};
  for (const a of argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'dry-run') out.dryRun = true;
    else if (k === 'levels') out.levels = String(v);
    else if (k === 'area-name') out.areaName = String(v);
    else if (k === 'bbox-only') out.bboxOnly = true;
    else if (k === 'bbox') out.bbox = String(v);
    else if (k === 'tiles') out.tiles = Math.max(1, Number(v) || 1);
    else if (k === 'out') out.out = String(v);
    else if (k === 'overpass') out.overpass = String(v);
    else if (k === 'timeout') out.timeout = Number(v);
    else if (k === 'raw-dir') out.rawDir = String(v);
    else if (k === 'help' || k === 'h') { console.log('用法：node scripts/fetch-osm-boundaries.mjs --levels=8 --tiles=2 [-h]'); process.exit(0); }
    else if (k) throw new Error('未知参数: --' + k);
  }
  out.levels = out.levels.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (!out.levels.length) throw new Error('--levels 至少给一个 admin_level');
  out.bboxArr = out.bbox.split(',').map(Number);
  if (out.bboxArr.length !== 4 || out.bboxArr.some((n) => !Number.isFinite(n))) throw new Error('--bbox 需要 S,W,N,E 四个数字');
  return out;
}

const log = (...a) => console.error('[fetch]', ...a);

/**
 * 单次 Overpass GET。
 * 502/504/429 是「公共实例排队满」，属于可重试状态 —— 按 30s→60s→120s 退避，
 * 而不是直接换镜像（换到的镜像要么更差、要么是区域镜像静默返回空）。
 */
async function overpassGet(query, {timeoutSec = 300, endpoint = null, ua = DEFAULTS.ua, retries = 5} = {}) {
  const endpoints = endpoint ? [endpoint] : (process.env.GQXQ_OVERPASS_URL ? [process.env.GQXQ_OVERPASS_URL, ...OVERPASS_MIRRORS] : OVERPASS_MIRRORS);
  let lastErr = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const url of endpoints) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const qs = url + '?data=' + encodeURIComponent(query);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 90) * 1000);
        const res = await fetch(qs, {headers: {'user-agent': ua, accept: 'application/json'}, signal: ctrl.signal});
        clearTimeout(timer);
        if (!res.ok) {
          const text = (await res.text()).slice(0, 160);
          // 403 在法国镜像上表现为「突发请求被限流」而非永久拒绝（实测冷却后 200），一并退避重试
          const retryable = [502, 503, 504, 429, 403].includes(res.status);
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text), {retryable});
        }
        const json = await res.json();
        log('ok', url, 'elements=' + (json.elements || []).length);
        return {json, url};
      } catch (e) {
        lastErr = e;
        const retryable = e.retryable !== false;
        log('fail', url, 'attempt ' + attempt + '/' + retries, '->', e.message.split('\n')[0]);
        if (!retryable || attempt === retries) break;
        const wait = [30000, 60000, 120000][Math.min(attempt - 1, 2)];
        log('退避 ' + Math.round(wait / 1000) + 's 后重试');
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('所有 Overpass 镜像均失败');
}

/**
 * 定位市域 relation（名称 + bbox；两个条件都有索引，实测 1~3s）。
 *
 * 为什么不用「按 area 名全表扫描」：无 bbox 的名称查询会让 Overpass 扫全行星边界，
 * 实测 90s 超时；加了 bbox 后立刻可用。
 */
async function findArea(areaName, bbox, timeoutSec) {
  const q = '[out:json][timeout:' + timeoutSec + '];' +
    'rel["boundary"="administrative"]["name"="' + areaName + '"](' + bbox.join(',') + ');out ids tags;';
  const {json} = await overpassGet(q, {timeoutSec});
  const rels = (json.elements || []).filter((e) => e.type === 'relation');
  if (!rels.length) throw new Error('未找到名为 ' + areaName + ' 的行政边界 relation');
  rels.sort((a, b) => Number(a.tags?.admin_level ?? 99) - Number(b.tags?.admin_level ?? 99));
  const pick = rels[0];
  log('市域 relation=' + pick.id + ' ' + (pick.tags?.name ?? '') + ' admin_level=' + pick.tags?.admin_level);
  return pick;
}

/* ---------------- relation 成员 ways → 多边形环 ---------------- */

const round = (v) => Math.round(Number(v) * 1e7) / 1e7;
const pkey = (p) => round(p[0]) + ',' + round(p[1]);

/** 把若干 way 坐标串拼成闭合环；拼不上的丢弃并计数 */
function stitchRings(ways) {
  const segs = ways.map((w) => (w.geometry || []).map((p) => [round(p.lon), round(p.lat)])).filter((s) => s.length >= 2);
  const rings = [];
  let open = 0;
  while (segs.length) {
    let ring = segs.shift().slice();
    let stuck = false;
    while (pkey(ring[0]) !== pkey(ring[ring.length - 1])) {
      const tail = pkey(ring[ring.length - 1]);
      let idx = -1;
      let reversed = false;
      for (let i = 0; i < segs.length; i += 1) {
        const s = segs[i];
        if (pkey(s[0]) === tail) { idx = i; break; }
        if (pkey(s[s.length - 1]) === tail) { idx = i; reversed = true; break; }
      }
      if (idx < 0) { stuck = true; break; }
      const next = segs.splice(idx, 1)[0];
      ring = ring.concat((reversed ? next.slice().reverse() : next).slice(1));
    }
    if (stuck) { open += 1; continue; }
    if (ring.length >= 4) rings.push(ring.map(([x, y]) => [Number(x.toFixed(7)), Number(y.toFixed(7))]));
  }
  return {rings, open};
}

function relationToRings(rel) {
  const outerWays = [];
  const innerWays = [];
  for (const m of rel.members || []) {
    if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
    if (m.role === 'inner') innerWays.push(m); else outerWays.push(m);
  }
  const outer = stitchRings(outerWays);
  const inner = stitchRings(innerWays);
  return {rings: [...outer.rings, ...inner.rings], openWays: outer.open + inner.open};
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(s / 2);
}

/** 把 bbox 切成 tiles×tiles 块 */
function tileBoxes(bbox, n) {
  const [s, w, north, east] = bbox;
  const dLat = (north - s) / n;
  const dLon = (east - w) / n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      out.push([Number((s + i * dLat).toFixed(6)), Number((w + j * dLon).toFixed(6)), Number((s + (i + 1) * dLat).toFixed(6)), Number((w + (j + 1) * dLon).toFixed(6))]);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const level = args.levels;
  const rels = new Map();
  const rawRecords = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  /**
   * 两种取数策略：
   *   A) area 精确取（默认）——先按名称+bbox 定位市域 relation，再用 area(id) 过滤；
   *      优点：只返回**属于本市**的要素，不会把邻近荆门/湖南的乡镇混进来（bbox 过滤会把跨界的也算进来，实测 47 个里有 40 个是邻市/邻省的）。
   *   B) bbox 分块（--bbox-only）——没有市域 relation 时兜底，需要人工剔除邻市要素。
   */
  let boxes = [[args.bboxArr[0], args.bboxArr[1], args.bboxArr[2], args.bboxArr[3]]];
  let areaId = null;
  if (!args.bboxOnly && args.areaName) {
    const area = await findArea(args.areaName, args.bboxArr, args.timeout);
    areaId = 3600000000 + area.id;
  } else {
    boxes = tileBoxes(args.bboxArr, args.tiles);
  }

  let tileIndex = 0;
  for (const [s, w, north, east] of boxes) {
    tileIndex += 1;
    const scope = areaId
      ? 'area(' + areaId + ')->.a;'
      : '';
    const filter = areaId ? '(area.a)' : '(' + [s, w, north, east].join(',') + ')';
    const q = '[out:json][timeout:' + args.timeout + '];' + scope +
      'rel["boundary"="administrative"]["admin_level"~"^(' + level.join('|') + ')$"]' + filter + ';' +
      'out geom;';
    log('query ' + tileIndex + '/' + boxes.length + ' ' + (areaId ? 'area=' + areaId : 'bbox=' + [s, w, north, east].join(',')));
    try {
      const {json, url} = await overpassGet(q, {timeoutSec: args.timeout, endpoint: args.overpass});
      rawRecords.push({bbox: [s, w, north, east], endpoint: url, query: q, count: (json.elements || []).length});
      for (const rel of json.elements || []) {
        if (rel.type !== 'relation') continue;
        if (!rels.has(rel.id)) rels.set(rel.id, rel);
      }
      if (!args.dryRun) {
        fs.mkdirSync(args.rawDir, {recursive: true});
        fs.writeFileSync(path.join(args.rawDir, 'overpass-tile' + tileIndex + '-' + stamp + '.json'), JSON.stringify(json));
      }
    } catch (e) {
      log('tile ' + tileIndex + ' 失败：' + e.message + '（可加大 --tiles 或 --timeout 重试）');
      throw e;
    }
  }
  log('关系去重后：' + rels.size + ' 个');

  const features = [];
  let openWays = 0;
  let dropped = 0;
  for (const rel of rels.values()) {
    const tags = rel.tags || {};
    const {rings, openWays: open} = relationToRings(rel);
    openWays += open;
    const total = rings.reduce((a, r) => a + ringArea(r), 0);
    if (!rings.length || total <= 1e-6) { dropped += 1; continue; }
    const name = tags.name || tags['name:zh'] || tags.official_name || String(rel.id);
    const divisionCode = String(tags.division_code || tags.ref || '').trim();
    const lvl = Number(tags.admin_level);
    features.push({
      type: 'Feature',
      properties: {
        // code 优先官方区划码（OSM 中国数据常带 division_code，乡镇为 9 位）；
        // 缺失时留空，由服务端按名称与 admin_grid 对齐或生成占位码 —— 绝不在这里编造官方码。
        code: divisionCode,
        name,
        level: lvl === 10 ? 'community' : lvl === 11 ? 'grid' : 'street',
        adminLevel: lvl,
        osmRelationId: rel.id,
        tags: Object.fromEntries(Object.entries(tags).filter(([k]) => ['ref', 'division_code', 'official_name', 'short_name', 'place', 'wikidata'].includes(k))),
      },
      geometry: rings.length === 1 ? {type: 'Polygon', coordinates: rings} : {type: 'MultiPolygon', coordinates: rings.map((r) => [r])},
      ringCount: rings.length,
      areaDeg2: Number(total.toFixed(9)),
    });
  }
  features.sort((a, b) => b.areaDeg2 - a.areaDeg2);

  const fc = {
    type: 'FeatureCollection',
    metadata: {
      dataset: 'yichang-admin' + level.join('_') + '-osm',
      provider: 'osm',
      providerDetail: 'OpenStreetMap / Overpass API',
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
      srid: 4326,
      coordinateSystem: 'WGS84',
      adminLevels: level,
      bbox: args.bboxArr,
      scope: areaId ? ('area:' + areaId) : ('bbox-tiles:' + args.tiles),
      fetchedAt: new Date().toISOString(),
      sourceRelations: rels.size,
      featureCount: features.length,
      droppedRelations: dropped,
      openWaysSkipped: openWays,
      featuresWithOfficialCode: features.filter((f) => f.properties.code).length,
      queries: rawRecords.map((r) => ({bbox: r.bbox, endpoint: r.endpoint, returned: r.count})),
      note: 'OSM 底稿，非权威行政/网格边界；用于可视化占位，验收前须替换为甲方或商业授权数据。',
    },
    features: features.map((f) => ({type: f.type, properties: f.properties, geometry: f.geometry})),
  };

  if (args.dryRun) {
    console.log(JSON.stringify({...fc.metadata, sample: fc.features.slice(0, 8).map((f) => f.properties)}, null, 2));
    return;
  }
  const outPath = args.out ? path.resolve(args.out) : path.join(SERVER_ROOT, 'data', 'boundaries', 'osm-yichang-admin' + level.join('_') + '.geojson');
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, JSON.stringify(fc));
  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log('[ok] ' + outPath + ' (' + mb + ' MB) features=' + features.length + ' withCode=' + fc.metadata.featuresWithOfficialCode + ' dropped=' + dropped + ' openWays=' + openWays);
}

main().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
