#!/usr/bin/env node
/**
 * intake-baseline.mjs — M4：入站留痕基线与告警判定（E 的最低实现）
 *
 * 依据：docs/2026-09-19-入站无鉴权端点防护方案.md §4.1 M4
 *   「以 complaint_source_log 为准，按日统计 created/updated/duplicate_same/rejected
 *     四类与不同 source_id 数；morgan combined 日志按状态码聚合。
 *     基线参考值：464 条 ≈ 6 个月历史，即日均新增应为个位数到几十，远高于此即异常」
 *
 * 两个数据源，都只做只读：
 *   1) SQL：complaint_source_log 按日聚合（四类结果 + distinct source_id + distinct remote_ip）
 *   2) 日志：morgan 访问日志按状态码聚合（--log 给路径才统计；支持 combined / dev 两种格式，
 *      并自动解开 docker json-file 的 {"log":"…"} 包装 —— 云上实例就是 json-file）
 *
 * 时间口径：库里 DATETIME 存的是 Asia/Shanghai 墙钟，所以直接 date(received_at) 取日；
 *          **不使用 UTC_TIMESTAMP() 与命名时区**（本机 MySQL 时区表未加载，命名时区静默 NULL）。
 *
 * 用法：
 *   node scripts/intake-baseline.mjs                          读 .env 的 GQXQ_DB_NAME，近 30 天
 *   node scripts/intake-baseline.mjs --days=14
 *   node scripts/intake-baseline.mjs --log=/data/gqxq/logs/server.log
 *   node scripts/intake-baseline.mjs --json                   给采集器的机器可读输出
 *   node scripts/intake-baseline.mjs --max-created=50 --max-deliveries=200 \
 *        --max-rejected=5 --max-ips=3
 *
 * 阈值默认值（依据文档的基线参考值：464 条 / 约 6 个月 ⇒ 日均新增个位数到几十）：
 *   created        > 50   日均新增远超基线（A1 类批量建假件 / A5 灌入）
 *   deliveries     > 200  单日投递总量（含重复与被拒）异常（A5；重复投也能淹没信号）
 *   rejected       > 5    被拒报文激增（有人在试探/构造）
 *   distinct ips   > 3    已知合法投递方只有极少数（现状：全部来自我方导入机 = 1 个 IP）
 *   日志 400       > max-rejected  同上，从访问日志侧再判一次
 *   均可用 GQXQ_BASELINE_MAX_* 环境变量或命令行覆盖（每季度按真实业务量复核，见文档 §4.4-4）。
 *
 * 退出码：0 无异常；1 存在 ANOMALY（告警通道据此触发）；2 前置失败（连不上库 / 日志读不到）。
 * 本脚本**不写任何表**（complaint_source_log 按设计只 insert 不 update 不 delete，
 * 保留与归档是业务方决策，见文档 §4.2-S7 与 Q6）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(HERE, '..', '.env') });

const argv = process.argv.slice(2);
function flag(name) {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
}
const JSON_OUT = argv.includes('--json');
const DAYS = Number(flag('days') || process.env.GQXQ_BASELINE_DAYS || '30');
const LOG_FILE = flag('log') || process.env.GQXQ_BASELINE_LOG || '';

function threshold(name, fallback) {
  const fromArg = flag('max-' + name);
  const fromEnv = process.env['GQXQ_BASELINE_MAX_' + name.toUpperCase()];
  const raw = fromArg !== null ? fromArg : fromEnv;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const LIMITS = {
  created: threshold('created', 50),
  deliveries: threshold('deliveries', 200),
  rejected: threshold('rejected', 5),
  ips: threshold('ips', 3),
};

const DB_NAME = process.env.GQXQ_DB_NAME || 'gqxq_service';

const anomalies = [];
const notes = [];

/**
 * 窗口起点：**在 JS 侧算 Asia/Shanghai 的墙钟日**，不依赖 curdate()/服务器时区，
 * 也不把占位符塞进 INTERVAL（预备语句在那种位置上不稳）。
 * 库里的 DATETIME 本就是上海墙钟，所以两边同日口径可直接比。
 */
function shanghaiCutoffDate(days) {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10) + ' 00:00:00';
}

/* ---------------- 1) SQL 维度（只读） ---------------- */

const SQL =
  'select date(received_at) as d, count(*) as deliveries, ' +
  "sum(result = 'created') as created, sum(result = 'updated') as updated, " +
  "sum(result = 'duplicate_same') as duplicate_same, sum(result = 'rejected') as rejected, " +
  'count(distinct source_id) as source_ids, count(distinct remote_ip) as ips ' +
  'from complaint_source_log ' +
  'where received_at >= ? ' +
  'group by date(received_at) order by d desc';

const pool = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database: DB_NAME,
  timezone: '+08:00',
  multipleStatements: false,
  // 本脚本只读聚合值，不做 Date 往返：dateStrings=true 让 date(received_at) 直接回
  // 'YYYY-MM-DD' 原文。若用默认的 dateStrings:false，mysql2 会把 DATE 解析成**本地零点**的
  // Date，再按 UTC 分量取日就整体倒退一天（实测把导入日 09-18 显示成 09-17）。
  dateStrings: true,
});

function dayKey(value) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.slice(0, 10);
}

let sqlRows = [];
const cutoff = shanghaiCutoffDate(DAYS);
try {
  const [rows] = await pool.execute(SQL, [cutoff]);
  sqlRows = rows.map((r) => ({
    day: dayKey(r.d),
    deliveries: Number(r.deliveries),
    created: Number(r.created),
    updated: Number(r.updated),
    duplicateSame: Number(r.duplicate_same),
    rejected: Number(r.rejected),
    sourceIds: Number(r.source_ids),
    ips: Number(r.ips),
  }));
  for (const r of sqlRows) {
    const hits = [];
    if (r.created > LIMITS.created) hits.push('created=' + r.created + ' > ' + LIMITS.created);
    if (r.deliveries > LIMITS.deliveries) hits.push('deliveries=' + r.deliveries + ' > ' + LIMITS.deliveries);
    if (r.rejected > LIMITS.rejected) hits.push('rejected=' + r.rejected + ' > ' + LIMITS.rejected);
    if (r.ips > LIMITS.ips) hits.push('distinct_remote_ip=' + r.ips + ' > ' + LIMITS.ips);
    if (hits.length > 0) anomalies.push({ source: 'complaint_source_log', day: r.day, reasons: hits });
  }
  if (sqlRows.length === 0) notes.push('近 ' + DAYS + ' 天没有投递留痕（SQL 维度无从判异常）');
} catch (err) {
  console.error('[baseline] 中止：查询 complaint_source_log 失败 —— ' + (err && err.message ? err.message : String(err)));
  await pool.end();
  process.exit(2);
}
await pool.end();

/* ---------------- 2) morgan 日志维度 ---------------- */

/**
 * 一行 → { method, path, status } 或 null。
 * combined（实测）：`127.0.0.1 - - [20/Sep/2026:06:50:43 +0000] "GET /api/v1/health HTTP/1.1" 200 94 "-" "-"`
 * dev             ：`POST /api/v1/… 200 5.120 ms - 123`
 * 注意：morgan 的 CLF 时间戳**固定是 UTC（+0000）**，与库里的上海墙钟业务日差 8 小时，
 *      所以日志维度只做"文件全量"的状态码聚合，**日粒度一律以 SQL 维度为准**。
 */
function parseAccessLine(line) {
  let text = line.trim();
  if (text === '') return null;
  if (text.startsWith('{') && text.includes('"log"')) {
    try {
      const wrapped = JSON.parse(text);
      if (typeof wrapped.log === 'string') text = wrapped.log.trim();
    } catch {
      /* 不是 json-file 包装，按原样继续判 */
    }
  }
  let m = /^(\S+) (\S+) \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) \S+/.exec(text);
  if (m) return { method: m[4], path: m[5], status: Number(m[6]) };
  m = /^(\S+) (\S+) (\d{3}) \d/.exec(text);
  if (m) return { method: m[1], path: m[2], status: Number(m[3]) };
  return null;
}

let logSummary = null;
if (LOG_FILE) {
  const abs = resolve(LOG_FILE);
  let content = '';
  try {
    content = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error('[baseline] 中止：读不到访问日志 ' + abs + ' —— ' + (err && err.message ? err.message : String(err)));
    process.exit(2);
  }
  const byStatus = {};
  const externalByStatus = {};
  let parsed = 0;
  let skipped = 0;
  for (const line of content.split(/\r?\n/)) {
    const hit = parseAccessLine(line);
    if (!hit) {
      if (line.trim() !== '') skipped++;
      continue;
    }
    parsed++;
    byStatus[hit.status] = (byStatus[hit.status] || 0) + 1;
    if (hit.path.startsWith('/api/v1/external/')) {
      externalByStatus[hit.status] = (externalByStatus[hit.status] || 0) + 1;
    }
  }
  const bad400 = externalByStatus[400] || 0;
  if (bad400 > LIMITS.rejected) {
    anomalies.push({
      source: 'access_log',
      day: '(按文件全量)',
      reasons: ['外部入站 400=' + bad400 + ' > ' + LIMITS.rejected + '（被拒报文激增，与 SQL 维度互校）'],
    });
  }
  logSummary = { file: abs, linesParsed: parsed, linesSkipped: skipped, byStatus, externalByStatus };
} else {
  notes.push('未给 --log：跳过 morgan 状态码聚合（生产用 NODE_ENV=production ⇒ combined 格式；' +
    'docker json-file 包装可自动解开）');
}

/* ---------------- 输出 ---------------- */

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    script: 'intake-baseline.mjs',
    generatedAt: new Date().toISOString(),
    database: DB_NAME,
    windowDays: DAYS,
    limits: LIMITS,
    daily: sqlRows,
    accessLog: logSummary,
    anomalies,
    notes,
    exitCode: anomalies.length > 0 ? 1 : 0,
  }, null, 2) + '\n');
} else {
  console.log('=== M4 入站基线 intake-baseline.mjs ===');
  console.log('库: ' + DB_NAME + '   窗口: 近 ' + DAYS + ' 天（按 received_at 的上海墙钟日，起点 ' + cutoff + '）');
  console.log('阈值: created>' + LIMITS.created + ' deliveries>' + LIMITS.deliveries +
    ' rejected>' + LIMITS.rejected + ' distinct_ip>' + LIMITS.ips);
  console.log('');
  console.log('日期          投递  created updated duplicate 拒绝  source_id  IP   判定');
  for (const r of sqlRows) {
    const flagged = anomalies.some((a) => a.source === 'complaint_source_log' && a.day === r.day);
    console.log(
      r.day.padEnd(12) + String(r.deliveries).padStart(5) + String(r.created).padStart(8) +
      String(r.updated).padStart(8) + String(r.duplicateSame).padStart(10) + String(r.rejected).padStart(6) +
      String(r.sourceIds).padStart(10) + String(r.ips).padStart(4) + '   ' + (flagged ? 'ANOMALY' : 'ok')
    );
  }
  if (logSummary) {
    console.log('');
    console.log('访问日志: ' + logSummary.file + '  解析 ' + logSummary.linesParsed + ' 行（跳过 ' + logSummary.linesSkipped + '）');
    console.log('  按状态码: ' + JSON.stringify(logSummary.byStatus));
    console.log('  /external 按状态码: ' + JSON.stringify(logSummary.externalByStatus));
  }
  if (anomalies.length > 0) {
    console.log('');
    console.log('--- ANOMALY ' + anomalies.length + ' 条 ---');
    for (const a of anomalies) console.log('[' + a.source + '] ' + a.day + ': ' + a.reasons.join('；'));
  }
  for (const n of notes) console.log('[说明] ' + n);
}
console.log('');
const exitCode = anomalies.length > 0 ? 1 : 0;
if (!JSON_OUT) console.log('退出码: ' + exitCode + (exitCode === 1 ? '（存在 ANOMALY，应告警）' : '（无异常）'));
process.exit(exitCode);
