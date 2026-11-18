/**
 * 诉求落图回写（补 complaint.community_code / admin_grid_code / 坐标）
 *
 * 背景：2026-11-13 灌数后
 *   - complaint 21,574 条，其中 12,234 条有 address（真实地址，形如
 *     「宜昌市西陵区刘家大堰26号(刘家大堰社区居委会)」）
 *   - community 1,036 个，其中 782 个已有真实坐标 + 已抖动坐标（jitter_*）
 *   - 但 complaint.community_code / admin_grid_code 全为空，location_lng/lat 仅 801 条
 *
 * 做法（保守、可回滚）：
 *   1. 只做「匹配 + 回写」，不改任何来源字段，不造坐标；
 *   2. 匹配信号优先级：
 *      a. 地址括号内的内容（「(刘家大堰社区居委会)」「(碧翠苑小区)」）——最可信
 *      b. 地址正文包含 community 名称（去后缀后的核心词，长度 ≥ 3）
 *      c. 地址正文包含「社区/村」全名
 *   3. 同名多小区时，用 district_code 做 tiebreak；仍无法唯一则记为 ambiguous 跳过；
 *   4. 坐标只从 community 的 location_lng/lat 复制（真实坐标），同时把 jitter 坐标写入
 *      complaint 侧不需要（三维用 community.jitter_*）；不写 location_lng 为 jitter。
 *   5. --dry-run 只统计不写库；结果打印分组计数与样例。
 *
 * 用法（在 gqxq/server 目录下，保证能解析 mysql2）：
 *   node <本文件> --dry-run
 *   node <本文件> --apply
 */
import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const ENV_PATH = 'D:/aiProject/workspace-opc/gqxq/server/.env';
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

/** 去掉行政/小区类后缀，保留核心名，便于包含匹配 */
const SUFFIXES = [
  '社区居民委员会', '社区居民委会', '社区居委会', '社区', '村委会', '居委会',
  '业主委员会', '小区', '花园', '新村', '家园', '公寓', '大厦', '广场', '苑', '村',
];
function core(name) {
  let s = String(name || '').trim();
  for (const suf of SUFFIXES) {
    if (s.length > suf.length + 1 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}
function parens(text) {
  const out = [];
  const re = /[（(]([^（）()]{2,40})[）)]/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

const conn = await createConnection({
  host: env.GQXQ_DB_HOST,
  port: Number(env.GQXQ_DB_PORT || 3306),
  user: env.GQXQ_DB_USER,
  password: env.GQXQ_DB_PASSWORD,
  database: env.GQXQ_DB_NAME,
  charset: 'utf8mb4',
});

const [communities] = await conn.query(
  `SELECT code, name, admin_grid_code, district_code, location_lng, location_lat, location_state, jitter_lng, jitter_lat, jitter_state
     FROM community
    WHERE location_lng IS NOT NULL AND location_lat IS NOT NULL`
);
console.log(`小区（有真实坐标）：${communities.length}`);

/** 名字 → 小区列表（含核心名索引） */
const byName = new Map();
const byCore = new Map();
for (const c of communities) {
  const full = String(c.name).trim();
  if (!byName.has(full)) byName.set(full, []);
  byName.get(full).push(c);
  const k = core(full);
  if (k.length >= 3) {
    if (!byCore.has(k)) byCore.set(k, []);
    byCore.get(k).push(c);
  }
}
console.log(`核心名索引：${byCore.size}`);

const [rows] = await conn.query(
  `SELECT id, address, corrected_address, district_code
     FROM complaint
    WHERE community_code IS NULL
      AND (address IS NOT NULL OR corrected_address IS NOT NULL)`
);
console.log(`待匹配诉求：${rows.length}`);

const stats = { paren_exact: 0, paren_core: 0, body_full: 0, body_core: 0, ambiguous: 0, nomatch: 0 };
const updates = [];
const samples = [];

function pick(cands, district) {
  if (!cands || cands.length === 0) return null;
  if (cands.length === 1) return cands[0];
  const same = cands.filter((c) => String(c.district_code || '') === String(district || ''));
  if (same.length === 1) return same[0];
  return null; // ambiguous
}

for (const r of rows) {
  const text = `${r.address || ''} ${r.corrected_address || ''}`.trim();
  if (!text) { stats.nomatch++; continue; }
  let hit = null;
  let how = '';

  // a. 括号内容
  for (const p of parens(text)) {
    const t = p.trim();
    if (byName.has(t)) { hit = pick(byName.get(t), r.district_code); how = 'paren_exact'; }
    if (!hit) {
      const k = core(t);
      if (byCore.has(k)) { hit = pick(byCore.get(k), r.district_code); how = 'paren_core'; }
    }
    if (hit) break;
  }
  // b/c. 正文包含
  if (!hit) {
    for (const [full, list] of byName) {
      if (full.length >= 4 && text.includes(full)) { const h = pick(list, r.district_code); if (h) { hit = h; how = 'body_full'; break; } }
    }
  }
  if (!hit) {
    let best = null;
    for (const [k, list] of byCore) {
      if (text.includes(k) && (!best || k.length > best.k.length)) best = { k, list };
    }
    if (best) { const h = pick(best.list, r.district_code); if (h) { hit = h; how = 'body_core'; } }
  }

  if (hit) {
    stats[how]++;
    updates.push({
      id: r.id,
      community_code: hit.code,
      admin_grid_code: hit.admin_grid_code,
      lng: hit.location_lng,
      lat: hit.location_lat,
    });
    if (samples.length < 12) samples.push({ id: r.id, addr: text.slice(0, 44), how, community: hit.name, grid: hit.admin_grid_code });
  } else {
    // 区分「有候选但冲突」与「完全没候选」
    const anyCand = parens(text).some((p) => byName.has(p.trim()) || byCore.has(core(p)));
    if (anyCand) stats.ambiguous++; else stats.nomatch++;
  }
}

console.log('\n=== 匹配结果 ===');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
console.log(`  合计可回写: ${updates.length} / ${rows.length}`);
console.log('\n样例：');
for (const s of samples) console.log(`  #${s.id} ${s.addr} → [${s.how}] ${s.community} (网格 ${s.grid})`);

if (!APPLY) {
  console.log('\n[dry-run] 未写库。加 --apply 执行。');
} else {
  let ok = 0;
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const part = updates.slice(i, i + CHUNK);
    const cases = part.map(() => '(?,?,?,?,?)').join(',');
    const params = [];
    for (const u of part) params.push(u.id, u.community_code, u.admin_grid_code, u.lng, u.lat);
    const sql = `INSERT INTO complaint (id, community_code, admin_grid_code, location_lng, location_lat)
                 VALUES ${cases}
                 ON DUPLICATE KEY UPDATE
                   community_code  = VALUES(community_code),
                   admin_grid_code = VALUES(admin_grid_code),
                   location_lng    = COALESCE(complaint.location_lng, VALUES(location_lng)),
                   location_lat    = COALESCE(complaint.location_lat, VALUES(location_lat))`;
    const [res] = await conn.query(sql, params);
    ok += res.affectedRows || 0;
    process.stdout.write(`\r  已处理 ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }
  console.log(`\n[apply] 已提交 ${updates.length} 条，affectedRows=${ok}`);
}

await conn.end();