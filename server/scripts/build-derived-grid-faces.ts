/**
 * build-derived-grid-faces.ts —— 用「小区点位 + 网格编码」推导街道/网格面（泰森多边形）
 *
 * ===== 为什么需要这一步 =====
 * CIM 那边的「社区网格」只给栅格出图（queryable=false，无要素/属性），
 * 街道面几何拿不到；而标书要的五色热力 / hover 显示网格名与诉求量 / 点击下钻，
 * 都需要「每个网格一个有编码的面」。平台内部其实已经有两个事实：
 *   ① community 表 1035 个小区点位，每个都带 admin_grid_code（9 位网格码）；
 *   ② admin_grid 表 110 个网格有编码与名称，只是 geometry 全空。
 * 于是按「同一网格的点聚成一块」做泰森多边形：
 *   · 每个点生成自己的 Voronoi 单元（裁剪到 6km 圆 + 市域框，避免郊区出现巨大面）；
 *   · 同网格的单元 union 成该网格的面；
 *   · 输出为**边界数据包**（与 OSM/官方数据同一契约），供 existing 接口/前端直接消费。
 *
 * ===== 诚实标注 =====
 * 这是**推导面**，不是测绘成果：provider=derived-voronoi、license 写清「内部推导」。
 * 前端会按 provider 如实显示「点位泰森多边形（近似）」，不会冒充正式网格边界。
 *
 * 用法：
 *   npx tsx scripts/build-derived-grid-faces.ts            # 生成 data/boundaries/derived-grid-faces.geojson
 *   npx tsx scripts/build-derived-grid-faces.ts --osm      # 同时并入 OSM 实测面（provider=osm 逐面标注）
 */
import fs from 'node:fs';
import path from 'node:path';
import union from '@turf/union';
import {featureCollection} from '@turf/helpers';
import {pool} from '../src/db/pool';
import {env} from '../src/config/env';

type LonLat = [number, number];
const R_METERS = 3500;          // 单元裁剪半径（超过这个距离的邻居不再产生有效切分）
const NEIGHBOR_MAX_M = 7000;   // 只看 2R 以内的邻居
const CITY = {minLon: 110.2, maxLon: 112.15, minLat: 29.9, maxLat: 31.62};

/** 半平面裁剪：保留 dot(n, x) <= c 的一侧（Sutherland–Hodgman） */
function clipHalfPlane(poly: LonLat[], nx: number, ny: number, c: number): LonLat[] {
  const out: LonLat[] = [];
  const inside = (p: LonLat) => nx * p[0] + ny * p[1] <= c + 1e-12;
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur, nx, ny, c));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur, nx, ny, c));
    }
  }
  return out;
}

function intersect(a: LonLat, b: LonLat, nx: number, ny: number, c: number): LonLat {
  const da = nx * a[0] + ny * a[1] - c;
  const db = nx * b[0] + ny * b[1] - c;
  const t = da / (da - db || 1e-12);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** 以点为心、半径 R 米的 64 边形（度） */
function circlePolygon(lon: number, lat: number, meters: number): LonLat[] {
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  const pts: LonLat[] = [];
  for (let i = 0; i < 64; i += 1) {
    const a = (i / 64) * Math.PI * 2;
    pts.push([lon + Math.cos(a) * dLon, lat + Math.sin(a) * dLat]);
  }
  return pts;
}

function clipToCity(poly: LonLat[]): LonLat[] {
  let p = poly;
  p = clipHalfPlane(p, -1, 0, -CITY.minLon); // lon >= minLon
  p = clipHalfPlane(p, 1, 0, CITY.maxLon);
  p = clipHalfPlane(p, 0, -1, -CITY.minLat);
  p = clipHalfPlane(p, 0, 1, CITY.maxLat);
  return p;
}

/** 泰森单元：圆盘 ∩ 市域框 ∩ 与所有近邻的中垂线半平面 */
function voronoiCell(idx: number, points: {lon: number; lat: number}[], mPerDegLat: number): LonLat[] {
  const p = points[idx];
  let poly = clipToCity(circlePolygon(p.lon, p.lat, R_METERS));
  for (let j = 0; j < points.length; j += 1) {
    if (j === idx) continue;
    const q = points[j];
    const dx = (q.lon - p.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180);
    const dy = (q.lat - p.lat) * mPerDegLat;
    const d2 = dx * dx + dy * dy;
    if (d2 > NEIGHBOR_MAX_M * NEIGHBOR_MAX_M) continue;
    // |x-p| <= |x-q|  ⇔  (q-p)·x <= (|q|²-|p|²)/2
    const nx = q.lon - p.lon;
    const ny = q.lat - p.lat;
    const c = (q.lon * q.lon - p.lon * p.lon + q.lat * q.lat - p.lat * p.lat) / 2;
    poly = clipHalfPlane(poly, nx, ny, c);
    if (poly.length < 3) return [];
  }
  return poly;
}

/** 环压缩：去重复点 + 去共线点 + 坐标四舍五入到 1e-5（约 1m） */
function compactRing(ring: LonLat[]): LonLat[] {
  const r6 = (p: LonLat): LonLat => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))];
  const uniq: LonLat[] = [];
  for (const raw of ring) {
    const p = r6(raw);
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length > 1) {
    const first = uniq[0];
    const last = uniq[uniq.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) uniq.pop();
  }
  const out: LonLat[] = [];
  for (let i = 0; i < uniq.length; i += 1) {
    const a = uniq[(i + uniq.length - 1) % uniq.length];
    const b = uniq[i];
    const c = uniq[(i + 1) % uniq.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (scale > 0 && Math.abs(cross) / scale < 1e-7) continue;
    out.push(b);
  }
  if (out.length < 3) return [];
  out.push([out[0][0], out[0][1]]);
  return out;
}

async function main() {
  const withOsm = process.argv.includes('--osm');

  const [gridRows] = await pool.query<import('mysql2').RowDataPacket[]>(
    'SELECT code, name FROM admin_grid WHERE CHAR_LENGTH(code) = 9'
  );
  const gridName = new Map<string, string>();
  for (const g of gridRows) gridName.set(String(g.code), String(g.name ?? g.code));

  const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(
    'SELECT admin_grid_code AS code, name AS communityName, ' +
      'jitter_lng AS jitterLng, jitter_lat AS jitterLat, location_lng AS lng, location_lat AS lat FROM community WHERE admin_grid_code IS NOT NULL'
  );
  const points: {lon: number; lat: number; code: string; name: string}[] = [];
  let skipped = 0;
  for (const r of rows) {
    const code = String(r.code ?? '');
    if (code.length !== 9) { skipped += 1; continue; }
    const lon = Number(env.screenCoordSource === 'jitter' ? (r.jitterLng ?? r.lng) : r.lng);
    const lat = Number(env.screenCoordSource === 'jitter' ? (r.jitterLat ?? r.lat) : r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) { skipped += 1; continue; }
    if (lon < CITY.minLon || lon > CITY.maxLon || lat < CITY.minLat || lat > CITY.maxLat) { skipped += 1; continue; }
    points.push({lon, lat, code, name: String(r.communityName ?? '')});
  }
  points.sort((a, b) => (a.code === b.code ? 0 : a.code < b.code ? -1 : 1));
  console.log('[derive] 参与推导的小区点位：' + points.length + '（跳过 ' + skipped + '）');

  const mPerDegLat = 110574;
  const cellsByCode = new Map<string, any[]>();
  for (let i = 0; i < points.length; i += 1) {
    const ring = voronoiCell(i, points, mPerDegLat);
    const compact = ring.length >= 3 ? compactRing(ring) : [];
    if (!compact.length) continue;
    const cell = {
      type: 'Feature',
      properties: {},
      geometry: {type: 'Polygon', coordinates: [compact]},
    };
    const list = cellsByCode.get(points[i].code) ?? [];
    list.push(cell);
    cellsByCode.set(points[i].code, list);
  }
  console.log('[derive] 有面的网格：' + cellsByCode.size + ' / ' + gridName.size);

  const derivedFeatures: any[] = [];
  for (const [code, cells] of cellsByCode) {
    let merged: any = null;
    try {
      merged = cells.length === 1 ? cells[0] : union(featureCollection(cells) as any);
    } catch (e) {
      console.warn('[derive] 网格 ' + code + ' union 失败：' + (e as Error)?.message);
      continue;
    }
    if (!merged) continue;
    const g = merged.geometry;
    const polys: number[][][][] =
      g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const rings: number[][][] = [];
    for (const poly of polys) for (const ring of poly) {
      const compact = compactRing(ring as LonLat[]);
      if (compact.length >= 4) rings.push(compact);
    }
    if (!rings.length) continue;
    derivedFeatures.push({
      type: 'Feature',
      properties: {
        code,
        name: gridName.get(code) ?? code,
        level: 'street',
        provider: 'derived-voronoi',
        pointCount: cells.length,
      },
      geometry: rings.length === 1 ? {type: 'Polygon', coordinates: rings} : {type: 'MultiPolygon', coordinates: rings.map((r) => [r])},
    });
  }
  derivedFeatures.sort((a, b) => a.properties.code.localeCompare(b.properties.code));
  console.log('[derive] 推导出的网格面：' + derivedFeatures.length);

  // 可选：并入 OSM 实测面（逐面标 provider=osm，且同名网格不再用推导面）
  const osmFile = path.resolve(__dirname, '../data/boundaries/osm-yichang-admin8.geojson');
  const merged: any[] = [];
  const osmNames = new Set<string>();
  if (withOsm && fs.existsSync(osmFile)) {
    const osm = JSON.parse(fs.readFileSync(osmFile, 'utf8'));
    for (const f of osm.features ?? []) {
      const name = String(f.properties?.name ?? '');
      osmNames.add(name);
      merged.push({...f, properties: {...f.properties, provider: 'osm'}});
    }
    console.log('[derive] 并入 OSM 实测面：' + merged.length + '（这些网格不再用推导面）');
  }
  for (const f of derivedFeatures) {
    if (osmNames.has(String(f.properties.name))) continue;
    merged.push(f);
  }

  const out = {
    type: 'FeatureCollection',
    metadata: {
      dataset: 'yichang-grid-faces-derived',
      provider: 'derived-voronoi',
      providerDetail: '平台小区点位(含 9 位网格码)按网格分组的泰森多边形；非测绘成果',
      license: '内部推导（基于平台自有小区点位与网格编码），不得作为测绘成果对外提供',
      attribution: '宜昌住新服务平台',
      srid: 4326,
      coordinateSystem: 'WGS84',
      adminLevels: [8],
      fetchedAt: new Date().toISOString(),
      featureCount: merged.length,
      derivedCount: derivedFeatures.length,
      osmCount: merged.length - derivedFeatures.length,
      circleRadiusMeters: R_METERS,
      note: '推导面：用于热力着色与交互（有编码、能聚诉求）；CIM 官方网格线为栅格参考层，二者形状可能略有差异。',
    },
    features: merged,
  };

  const outFile = path.resolve(__dirname, '../data/boundaries/derived-grid-faces.geojson');
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(outFile, JSON.stringify(out));
  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  console.log('[ok] ' + outFile + ' (' + mb + ' MB) features=' + merged.length);
  await pool.end();
}

main().catch((e) => {
  console.error('[fail]', (e as Error)?.message);
  process.exit(1);
});
