/**
 * 诉求「问题类型」映射（minor_category_code 规则映射）
 *
 * 背景（2026-11-16 实测）：
 *   - complaint.major_category_code 已有值：gas_service 12,589 / water_service 8,521 / NULL 464
 *   - complaint.minor_category_code 全为 NULL → 大屏「问题类型分布」只能显示大类，出不来细分
 *   - title/content 是真实诉求正文，可用关键词规则映射到 dict_item(complaint_category) 的 19 个小类
 *
 * 规则：先按 business_type 分流（gas → g*, water → w*），再按关键词命中打分，取最高分；
 *       同分时优先更具体（关键词更长）的规则；无命中 → 留 NULL（不猜、不填默认类）。
 * 回写：minor_category_code + source_minor_category_code（标记规则版），
 *       并补 major_category_code（若为空，按 business_type 推断）。
 *
 * 用法（在 gqxq/server 目录下）：
 *   node scripts/tmp-map-category.mjs --dry-run
 *   node scripts/tmp-map-category.mjs --apply
 */
import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const VERSION = 'rule-20261116';
const env = Object.fromEntries(
  readFileSync('D:/aiProject/workspace-opc/gqxq/server/.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

/** 关键词规则：code → 关键词（越长越具体，命中权重按长度） */
const RULES = [
  // 供气
  { code: 'g08', keys: ['气压不足', '气压低', '气压', '火力小', '火苗小', '打不着火', '点不着火', '气量小', '天然气小'] },
  { code: 'g06', keys: ['停气', '断气', '无气', '没气', '停天然气', '天然气停'] },
  { code: 'g02', keys: ['燃气费', '气费', '捆绑销售', '乱收费', '收费不合理', '退费', '多收费', '燃气价格'] },
  { code: 'g03', keys: ['燃气施工', '燃气管道施工', '管道改造', '挖断燃气', '燃气管挖断'] },
  { code: 'g04', keys: ['报装', '点火', '开户', '通气', '装表', '燃气开通'] },
  { code: 'g05', keys: ['漏气', '燃气泄漏', '报修', '燃气故障', '灶具故障', '燃气表故障', '燃气损坏'] },
  { code: 'g07', keys: ['燃气查询', '燃气过户', '燃气发票', '燃气咨询'] },
  { code: 'g01', keys: ['燃气服务', '燃气公司态度', '燃气客服', '燃气电话打不通', '燃气投诉'] },
  // 供水
  { code: 'w01', keys: ['停水', '断水', '无水', '没水', '停水通知', '自来水停'] },
  { code: 'w02', keys: ['水费', '水价', '水费收取', '乱收水费', '水费退费', '水表收费'] },
  { code: 'w03', keys: ['水质', '水发黄', '水有异味', '水浑', '水浑浊', '自来水发黄', '水质不达标', '水有杂质'] },
  { code: 'w04', keys: ['水压', '水压低', '水压不足', '水小', '水流小', '上不去水', '没水压'] },
  { code: 'w07', keys: ['挖断水管', '挖断自来水', '施工挖断', '水管破裂', '管道破裂'] },
  { code: 'w08', keys: ['报修水管', '水管维修', '水表损坏', '水管漏水', '维修自来水', '二次供水设备故障'] },
  { code: 'w06', keys: ['供水服务', '水务公司态度', '水务客服', '供水公司投诉', '水务电话打不通'] },
  { code: 'w05', keys: ['自来水', '用水', '供水', '二次供水', '水表', '水阀'] },
];

const conn = await createConnection({
  host: env.GQXQ_DB_HOST,
  port: Number(env.GQXQ_DB_PORT || 3306),
  user: env.GQXQ_DB_USER,
  password: env.GQXQ_DB_PASSWORD,
  database: env.GQXQ_DB_NAME,
  charset: 'utf8mb4',
});

const [[{ total }]] = await conn.query('SELECT COUNT(*) total FROM complaint');
console.log(`诉求总数：${total}`);

const [rows] = await conn.query(
  `SELECT id, business_type, major_category_code, minor_category_code, title, content
     FROM complaint
    WHERE minor_category_code IS NULL`
);
console.log(`待映射（minor 为空）：${rows.length}`);

const stats = {};
const updates = [];
const samples = [];

for (const r of rows) {
  const text = `${r.title || ''} ${r.content || ''}`;
  const gas = String(r.business_type) === 'gas' || String(r.major_category_code) === 'gas_service';
  const water = String(r.business_type) === 'water' || String(r.major_category_code) === 'water_service';
  const pool = RULES.filter((x) => (gas ? x.code.startsWith('g') : water ? x.code.startsWith('w') : true));

  let best = null;
  for (const rule of pool) {
    for (const k of rule.keys) {
      if (text.includes(k)) {
        const score = k.length;
        if (!best || score > best.score) best = { code: rule.code, key: k, score };
      }
    }
  }
  if (!best) {
    stats.nomatch = (stats.nomatch || 0) + 1;
    continue;
  }
  stats[best.code] = (stats[best.code] || 0) + 1;
  const major = best.code.startsWith('g') ? 'gas_service' : 'water_service';
  updates.push({ id: r.id, minor: best.code, major: r.major_category_code || major, key: best.key });
  if (samples.length < 10) samples.push({ id: r.id, key: best.key, code: best.code, text: text.replace(/\s+/g, ' ').slice(0, 40) });
}

console.log('\n=== 命中统计 ===');
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log(`  合计可回写：${updates.length} / ${rows.length}`);
console.log('\n样例：');
for (const s of samples) console.log(`  #${s.id} [${s.code}] 命中「${s.key}」 ${s.text}`);

if (!APPLY) {
  console.log('\n[dry-run] 未写库。加 --apply 执行。');
} else {
  let ok = 0;
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const part = updates.slice(i, i + CHUNK);
    const ids = part.map((u) => u.id);
    const mn = part.map(() => 'WHEN ? THEN ?').join(' ');
    const mj = part.map(() => 'WHEN ? THEN ?').join(' ');
    const sql = `UPDATE complaint SET
        minor_category_code        = CASE id ${mn} END,
        source_minor_category_code = CASE id ${mn} END,
        major_category_code        = COALESCE(CASE id ${mj} END, major_category_code),
        source_category_version    = ?
      WHERE id IN (${ids.map(() => '?').join(',')})`;
    const p = [...part.flatMap((u) => [u.id, u.minor]), ...part.flatMap((u) => [u.id, u.minor]), ...part.flatMap((u) => [u.id, u.major]), VERSION, ...ids];
    const [res] = await conn.query(sql, p);
    ok += res.affectedRows || 0;
    process.stdout.write(`\r  已处理 ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }
  console.log(`\n[apply] 已更新 ${updates.length} 条，affectedRows=${ok}，规则版本 ${VERSION}`);
}

await conn.end();