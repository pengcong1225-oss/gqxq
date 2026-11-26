/**
 * build-district-snapshot.ts —— 用高德实时边界刷新「区县快照」
 *
 * 为什么要有快照：区县边界准静态（行政区划按年调整），但高德是外部依赖 ——
 * 政务内网出口受限 / key 过期欠费 / QPS 打满时实时接口会挂，整层区县就消失。
 * 快照用于降级：解不出实时值时返回快照，source 标 snapshot，前端如实提示。
 *
 * 用法：
 *   npm run boundary:districts            # 拉 13 个区县，写 data/boundaries/yichang-districts-snapshot.geojson
 *   npx tsx scripts/build-district-snapshot.ts --dry-run
 *
 * 纪律：
 *   · 高德返回 GCJ-02，这里用 domain/utilityCoordinates 的迭代转换转 WGS84（与线上同一套公式，不用 -t_srs）；
 *   · 只接受凑齐 >=12 个区县才写盘，避免把半截数据当快照；
 *   · 快照 metadata 记录 fetchedAt / provider / license，前端展示时可追溯。
 */
import fs from 'node:fs';
import path from 'node:path';
import {env} from '../src/config/env';
import {utilityGcj02ToWgs84} from '../src/domain/utilityCoordinates';

const DISTRICTS: {code: string; name: string}[] = [
  {code: '420502', name: '西陵区'}, {code: '420503', name: '伍家岗区'}, {code: '420504', name: '点军区'},
  {code: '420505', name: '猇亭区'}, {code: '420506', name: '夷陵区'}, {code: '420525', name: '远安县'},
  {code: '420526', name: '兴山县'}, {code: '420527', name: '秭归县'}, {code: '420528', name: '长阳土家族自治县'},
  {code: '420529', name: '五峰土家族自治县'}, {code: '420581', name: '宜都市'}, {code: '420582', name: '当阳市'},
  {code: '420583', name: '枝江市'},
];

function ringsFromPolyline(polyline: string): number[][][] {
  const rings: number[][][] = [];
  for (const ringText of polyline.split('|')) {
    const ring: number[][] = [];
    for (const pair of ringText.split(';')) {
      const [lonText, latText] = pair.split(',');
      const gcjLng = Number(lonText);
      const gcjLat = Number(latText);
      if (!Number.isFinite(gcjLng) || !Number.isFinite(gcjLat)) continue;
      const [lng, lat] = utilityGcj02ToWgs84(gcjLng, gcjLat);
      ring.push([Number(lng.toFixed(7)), Number(lat.toFixed(7))]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

async function fetchDistrict(code: string): Promise<{code: string; name: string; rings: number[][][]} | null> {
  const key = String(env.amapKey ?? '').trim();
  if (!key) throw new Error('GQXQ_AMAP_KEY 未配置，无法刷新快照（可先用现有快照）');
  const base = String(env.amapBaseUrl ?? 'https://restapi.amap.com').replace(/\/+$/, '');
  const url = base + '/v3/config/district?key=' + encodeURIComponent(key) +
    '&keywords=' + code + '&subdistrict=0&extensions=all';
  const res = await fetch(url);
  if (!res.ok) throw new Error('高德 HTTP ' + res.status);
  const body: any = await res.json();
  if (String(body?.status) !== '1') throw new Error('高德返回 status=' + body?.status + ' info=' + body?.info);
  const hit = Array.isArray(body.districts) ? body.districts[0] : null;
  const rings = ringsFromPolyline(String(hit?.polyline ?? ''));
  if (!rings.length) return null;
  const meta = DISTRICTS.find((d) => d.code === code);
  return {code, name: meta?.name ?? String(hit?.name ?? code), rings};
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const features: any[] = [];
  for (const d of DISTRICTS) {
    const one = await fetchDistrict(d.code);
    if (!one) { console.warn('[districts] ' + d.code + ' 无边界，跳过'); continue; }
    features.push({
      type: 'Feature',
      properties: {code: one.code, name: one.name, level: 'district', provider: 'amap-snapshot'},
      geometry: one.rings.length === 1 ? {type: 'Polygon', coordinates: one.rings} : {type: 'MultiPolygon', coordinates: one.rings.map((r) => [r])},
    });
    await new Promise((r) => setTimeout(r, 400)); // 免费额度 QPS 很低，串行 + 间隔
  }
  if (features.length < 12) throw new Error('只拿到 ' + features.length + ' 个区县（<12），拒绝写快照');
  const fc = {
    type: 'FeatureCollection',
    metadata: {
      dataset: 'yichang-districts-amap-snapshot',
      provider: 'amap-snapshot',
      providerDetail: '高德 /v3/config/district 边界快照（GCJ-02 已转 WGS84），用于高德不可用时降级',
      license: '高德开放平台服务条款（仅本项目使用，不对外分发）',
      attribution: '高德地图',
      srid: 4326,
      coordinateSystem: 'WGS84',
      adminLevels: [6],
      fetchedAt: new Date().toISOString(),
      featureCount: features.length,
      note: '行政区划调整频率极低；高德实时取不到时用本快照，source=snapshot，前端如实提示。重新生成：npm run boundary:districts',
    },
    features,
  };
  if (dryRun) { console.log(JSON.stringify({...fc.metadata, codes: features.map((f) => f.properties.code)}, null, 2)); return; }
  const out = path.resolve(__dirname, '../data/boundaries/yichang-districts-snapshot.geojson');
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(fc));
  console.log('[ok] ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB) districts=' + features.length);
}

main().catch((e) => { console.error('[fail]', (e as Error)?.message); process.exit(1); });
