#!/usr/bin/env node
/**
 * 预警规则阈值「全市口径」复核（只读，不写库、不改规则）
 *
 * 背景（2026-11-18）：预警引擎原按 (企业+区县+网格) 分组计数，而规则阈值按全市口径算，
 * 两套口径错配导致全市阈值永不触发。引擎正在改为支持 scope=city，本脚本按全市口径重算 5 条规则阈值。
 *
 * 方法：
 *  1) 按日取件数（宜接就办来源、deleted=0、source_reported_at）；
 *  2) 基线 = 日均件数 × 窗口天数（7 日规则）；季节性规则只用保障期内日期做基线；
 *  3) 建议阈值 = ceil(基线 × 倍数)，倍数默认 1.5；计划停供另给 2.0 版本（沿用既有推导口径）；
 *  4) 触发频率 = 在基线日集上滚动窗口求和，统计达到阈值的天数 / 可评估天数。
 * 窗口：2025-01-01 ~ 2026-11-12（98 个自然周 / 686 天）。
 * 用法（在 gqxq/server 下）：npx tsx scripts/recalc-alert-thresholds.mjs
 */
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const FROM = '2025-01-01';
const TO = '2026-11-12';
const SEASON = {
  winter: [11, 12, 1, 2, 3],
  summer: [6, 7, 8, 9],
};
const RULES = [
  { id: 'alert-winter-gas-pressure', label: '冬季保供 · 燃气气压', business: 'gas', codes: ['g08'], current: 7, windowDays: 7, season: 'winter' },
  { id: 'alert-summer-water-pressure', label: '夏季保畅 · 水压', business: 'water', codes: ['w04'], current: 16, windowDays: 7, season: 'summer' },
  { id: 'alert-planned-shutdown-gas', label: '计划性停气 · 停气问题', business: 'gas', codes: ['g06'], current: 16, windowDays: 3, multiplierAlt: 2 },
  { id: 'alert-planned-shutdown-water', label: '计划性停水 · 停水问题', business: 'water', codes: ['w01'], current: 29, windowDays: 3, multiplierAlt: 2 },
  { id: 'alert-gas-three-piece-installation', label: '燃气三件套安装', business: 'gas', codes: ['g01', 'g02', 'g04', 'g05'], current: 133, windowDays: 7 },
];

const conn = await mysql.createConnection({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database: process.env.GQXQ_DB_NAME,
  charset: 'utf8mb4',
  timezone: '+08:00',
});

const dayList = (from, to) => {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

async function dailyCounts(business, codes) {
  const holes = codes.map(() => '?').join(',');
  const [rows] = await conn.query(
    "select date_format(source_reported_at,'%Y-%m-%d') d, count(*) n from complaint where deleted=0 and source_system='宜接就办' " +
    'and business_type=? and source_reported_at>=? and source_reported_at<=? and minor_category_code in (' + holes + ') group by d',
    [business, FROM, TO, ...codes],
  );
  const map = new Map(rows.map((r) => [String(r.d).slice(0, 10), Number(r.n)]));
  return map;
}

async function oldGroupStats(business, codes) {
  const holes = codes.map(() => '?').join(',');
  const [rows] = await conn.query(
    'select cnt from (select enterprise_code, district_code, admin_grid_code, ' +
    'date_format(date_sub(source_reported_at, interval weekday(source_reported_at) day), \'%Y-%m-%d\') wk, count(*) cnt ' +
    'from complaint where deleted=0 and source_system=\'宜接就办\' and business_type=? and source_reported_at>=? and source_reported_at<=? ' +
    'and minor_category_code in (' + holes + ') and enterprise_code is not null and district_code is not null and admin_grid_code is not null ' +
    'group by enterprise_code, district_code, admin_grid_code, wk) t',
    [business, FROM, TO, ...codes],
  );
  const ns = rows.map((r) => Number(r.cnt));
  const sum = ns.reduce((a, b) => a + b, 0);
  return { groups: ns.length, avg: ns.length ? +(sum / ns.length).toFixed(2) : null, max: ns.length ? Math.max(...ns) : null };
}

const days = dayList(FROM, TO);
const md = [];
md.push('| 规则 | 分类 | 窗口 | 基线日集 | 基线日均 | 窗口基线 | 建议阈值(×1.5) | 备选(×2.0) | 现阈值 | 差异 | 触发天数/可评估天数 | 旧分组口径(组周均值/峰值) |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
const rowsOut = [];
for (const rule of RULES) {
  const counts = await dailyCounts(rule.business, rule.codes);
  const months = rule.season ? SEASON[rule.season] : null;
  const baseDays = months ? days.filter((d) => months.includes(Number(d.slice(5, 7)))) : days;
  const baseSum = baseDays.reduce((a, d) => a + (counts.get(d) ?? 0), 0);
  const avgPerDay = baseSum / baseDays.length;
  const windowBase = avgPerDay * rule.windowDays;
  const suggested = Math.ceil(windowBase * 1.5);
  const alt = rule.multiplierAlt ? Math.ceil(windowBase * rule.multiplierAlt) : null;
  // 触发频率：在基线日集上做滚动窗口
  const evalDays = baseDays.filter((d, i) => i >= rule.windowDays - 1);
  let hits1 = 0, hitsCur = 0;
  for (const d of evalDays) {
    const end = Date.parse(d + 'T00:00:00Z');
    let sum = 0;
    for (let k = 0; k < rule.windowDays; k++) sum += counts.get(new Date(end - k * 86400000).toISOString().slice(0, 10)) ?? 0;
    if (sum >= suggested) hits1++;
    if (sum >= rule.current) hitsCur++;
  }
  const g = await oldGroupStats(rule.business, rule.codes);
  const diff = suggested === rule.current ? '一致' : (suggested > rule.current ? '+' + (suggested - rule.current) : String(suggested - rule.current));
  md.push('| ' + rule.label + ' | ' + rule.codes.join('+') + ' | ' + rule.windowDays + '日 | ' + (months ? (rule.season === 'winter' ? '11–3月' : '6–9月') : '全年') + ' | ' + avgPerDay.toFixed(3) + ' | ' + windowBase.toFixed(1) + ' | **' + suggested + '** | ' + (alt ?? '—') + ' | ' + rule.current + ' | ' + diff + ' | ' + hits1 + ' / ' + evalDays.length + '（现阈值 ' + hitsCur + '） | ' + g.avg + ' / ' + g.max + ' |');
  rowsOut.push({ id: rule.id, label: rule.label, codes: rule.codes, windowDays: rule.windowDays, season: rule.season ?? 'all', baseDays: baseDays.length, avgPerDay: +avgPerDay.toFixed(4), windowBase: +windowBase.toFixed(2), suggested, alt, current: rule.current, diff, hitDays: hits1, evalDays: evalDays.length, hitDaysCurrent: hitsCur, oldGroup: g });
}
console.log(md.join('\n'));
console.log('');
console.log('JSON=' + JSON.stringify(rowsOut));
await conn.end();
