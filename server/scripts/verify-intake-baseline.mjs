#!/usr/bin/env node
/**
 * verify-intake-baseline.mjs — M4 断言：告警能触发一次真实演练
 *
 * 依据：docs/2026-09-19-入站无鉴权端点防护方案.md §4.1 M4
 *   验收判据原文：「告警能触发一次真实演练（测试库用 GQXQ_TEST_DB_NAME，禁碰真库）」
 *   统计口径原文：「以 complaint_source_log 为准，按日统计 created/updated/duplicate_same/
 *                 rejected 四类与不同 source_id 数；morgan combined 日志按状态码聚合」
 *
 * 演练做法（全程只打测试库 + 一次性实例，串行）：
 *   1) 记录演练前"今日"的四类计数与 distinct source_id
 *   2) 起一个 NODE_ENV=production 的一次性实例（3330，测试库）——为的是拿到**真实的
 *      morgan combined 日志**（dev 格式没有日期字段，不足以验状态码聚合）
 *   3) 经真实入站接口投：6 条新建 + 1 条同包重投 + 2 条非法报文，另加 1 条无凭证的
 *      受保护请求（401）；实例 stdout 落临时文件
 *   4) 跑 intake-baseline.mjs --json：
 *        M4-1 今日四类计数逐项 = 演练前 + 本次投递量（统计口径本身正确）
 *        M4-2 阈值调低后判 ANOMALY 且退出码 1（告警真的会响）
 *        M4-3 阈值放宽后退出码 0（不空响，免得告警被人关掉）
 *        M4-4 morgan combined 状态码聚合 = 实际投递结果（200/400/401 逐项对得上）
 *   5) 删净测试行、断言归零，再跑一次：M4-5 今日计数回到演练前（演练不留残留）
 *
 * 安全边界：目标库必须是 GQXQ_TEST_DB_NAME（默认 gqxq_service_test），
 *          解析到 gqxq_service 立即中止；不占 3100；JWT 口令临时随机生成、不打印不落盘。
 *
 * 用法：cd server && npm run build && node scripts/verify-intake-baseline.mjs
 * 退出码：任一 FAIL -> 1；前置不满足 -> 2；全 PASS -> 0。
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const ENTRY = join(SERVER, 'dist', 'index.js');
const BASELINE = join(HERE, 'intake-baseline.mjs');
dotenv.config({ path: join(SERVER, '.env') });

const TEST_DB = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';
if (TEST_DB === 'gqxq_service') {
  console.error('[verify-m4] 中止：GQXQ_TEST_DB_NAME 解析为真实库 gqxq_service，禁止对真库做演练。');
  process.exit(2);
}
if (!existsSync(ENTRY) || !existsSync(BASELINE)) {
  console.error('[verify-m4] 中止：缺 dist/index.js 或 intake-baseline.mjs（先 cd server && npm run build）');
  process.exit(2);
}

const PORT = '3330';
const STAMP = Date.now();
const PREFIX = 'ACCHM4' + STAMP;
const sourceIds = [];
const complaintIds = [];

const results = [];
function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 42 - title.length)));
  console.log('  状态: ' + status);
  for (const l of lines || []) console.log('  ' + l);
}
let failed = false;
const markFail = () => { failed = true; };

function shanghaiToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const TODAY = shanghaiToday();

const db = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database: TEST_DB,
  timezone: '+08:00',
  multipleStatements: false,
  dateStrings: true,
});

/** 与 intake-baseline.mjs 同一口径的四类计数（只读） */
async function readToday() {
  const [rows] = await db.execute(
    'select count(*) deliveries, ' +
      "sum(result='created') created, sum(result='updated') updated, " +
      "sum(result='duplicate_same') duplicate_same, sum(result='rejected') rejected, " +
      'count(distinct source_id) source_ids, count(distinct remote_ip) ips ' +
      'from complaint_source_log where received_at >= ? and received_at < date_add(?, interval 1 day)',
    [TODAY + ' 00:00:00', TODAY]
  );
  const r = rows[0];
  const n = (v) => (v === null ? 0 : Number(v));
  return {
    deliveries: n(r.deliveries), created: n(r.created), updated: n(r.updated),
    duplicateSame: n(r.duplicate_same), rejected: n(r.rejected), sourceIds: n(r.source_ids), ips: n(r.ips),
  };
}

function portBusy(host, port) {
  return new Promise((done) => {
    const sock = net.connect({ host, port });
    const finish = (r) => { sock.destroy(); done(r); };
    sock.setTimeout(800, () => finish(false));
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

/* ---------------- 起 production 形态的一次性实例 ---------------- */

if (await portBusy('127.0.0.1', PORT)) {
  console.error('[verify-m4] 中止：端口 ' + PORT + ' 已被占用，请释放后重跑（不要打扰 3100 开发实例）。');
  process.exit(2);
}

// NODE_ENV=production 只改变两件事：morgan 用 combined 格式、JWT 口令长度须 >=32。
// 后者用一次性随机值经环境变量注入（不落盘、不打印），不碰 .env 的真实值。
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT,
  GQXQ_HOST: '127.0.0.1',
  GQXQ_DB_NAME: TEST_DB,
  GQXQ_JWT_SECRET: randomBytes(32).toString('hex'),
};
const child = spawn(process.execPath, [ENTRY], { cwd: SERVER, env });
let childLog = '';
child.stdout.on('data', (d) => { childLog += d.toString(); });
child.stderr.on('data', (d) => { childLog += d.toString(); });
let childExit = null;
child.on('exit', (code, signal) => { childExit = { code, signal }; });

async function waitReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (childExit) return false;
    if (childLog.includes('[Server] 监听地址:')) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function req(method, path, body, headers) {
  return new Promise((done) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (data !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port: Number(PORT), path, method, headers: h }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    r.on('error', (e) => done({ status: 0, text: '', error: e.code || String(e) }));
    r.setTimeout(15000, () => { r.destroy(); done({ status: 0, text: '', error: 'TIMEOUT' }); });
    if (data !== null) r.end(data); else r.end();
  });
}

async function stopChild() {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 4000;
    while (!childExit && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!childExit) child.kill('SIGKILL');
  }
}

console.log('=== M4 基线告警演练 verify-intake-baseline.mjs ===');
console.log('目标库: ' + TEST_DB + '   实例端口: ' + PORT + '   今日（上海墙钟）: ' + TODAY);

const before = await readToday();
console.log('[演练前] 今日计数 ' + JSON.stringify(before));

if (!(await waitReady())) {
  emit('M4-0', 'production 形态实例启动', 'FAIL', ['未起来 exit=' + JSON.stringify(childExit),
    ...childLog.split(/\r?\n/).slice(-15).map((l) => '# ' + l)]);
  markFail();
} else {
  console.log('[实例] ' + (childLog.match(/\[Server\] 监听地址: \S+/) || ['(无)'])[0]);

  /* ---- 投递：6 新建 + 1 同包重投 + 2 非法 + 1 无凭证受保护请求 ---- */
  const tally = { ok200: 0, bad400: 0, unauth401: 0, created: 0, duplicate_same: 0, rejected: 0, updated: 0 };
  const deliveryNotes = [];
  /** 取一次投递的结论：HTTP 码 + data.result（顺带把新建的 complaint_id 记下来供清理） */
  function record(r) {
    const d = r.status === 200 ? (JSON.parse(r.text).data || {}) : {};
    if (r.status === 200) {
      tally.ok200++;
      if (d.result === 'created') tally.created++;
      if (d.result === 'duplicate_same') tally.duplicate_same++;
      if (d.result === 'updated') tally.updated++;
      if (d.complaintId) complaintIds.push(d.complaintId);
    }
    if (r.status === 400) tally.bad400++;
    return d.result || '(HTTP ' + r.status + ')';
  }
  let lastValidBody = null;
  for (let i = 0; i < 6; i++) {
    const sourceId = PREFIX + 'C' + i;
    sourceIds.push(sourceId);
    const body = {
      sourceId,
      title: 'M4 演练-新增第 ' + i + ' 条 ' + sourceId,
      content: 'verify-intake-baseline.mjs 自动生成，用于触发入站基线告警演练。',
      address: '西陵区沿江大道188号',
      districtName: '西陵区',
      source: '12345热线',
    };
    lastValidBody = body;
    const r = await req('POST', '/api/v1/external/yijiejieban/appeal', body);
    deliveryNotes.push('新建#' + i + ' HTTP ' + r.status + ' result=' + record(r));
  }
  {
    const r = await req('POST', '/api/v1/external/yijiejieban/appeal', lastValidBody);
    deliveryNotes.push('同包重投 HTTP ' + r.status + ' result=' + record(r));
  }
  {
    const r = await req('POST', '/api/v1/external/yijiejieban/appeal', { sourceId: PREFIX + 'BAD1', content: '缺 title 的非法报文' });
    deliveryNotes.push('非法(缺 title) HTTP ' + r.status + ' result=' + record(r));
    if (r.status === 400) tally.rejected++;
  }
  {
    const r = await req('POST', '/api/v1/external/yijiejieban/appeal', { sourceId: PREFIX + 'BAD2', title: '码位非法', businessType: 'WATER' });
    deliveryNotes.push('非法(码位) HTTP ' + r.status + ' result=' + record(r));
    if (r.status === 400) tally.rejected++;
  }
  {
    const r = await req('GET', '/api/v1/complaints?page=1&size=1');
    deliveryNotes.push('无凭证受保护请求 HTTP ' + r.status);
    if (r.status === 401) tally.unauth401++;
  }
  console.log('[投递] ' + deliveryNotes.join(' | '));
  console.log('[计数] ' + JSON.stringify(tally));
  await stopChild();

  /* ---- 把真实的 combined 访问日志落到临时文件 ---- */
  const logFile = join(tmpdir(), 'gqxq-m4-drill-' + STAMP + '.log');
  writeFileSync(logFile, childLog, 'utf8');
  // 真实 combined 行长这样（实测样本，CLF 时间戳固定 +0000）：
  //   127.0.0.1 - - [20/Sep/2026:06:50:43 +0000] "GET /api/v1/health HTTP/1.1" 200 94 "-" "-"
  const ACCESS_LINE = /^\S+ \S+ \S+ \[[^\]]+\] "\S+ \S+ HTTP\/\d\.\d" \d{3} \S+/;
  const accessLineCount = childLog.split(/\r?\n/).filter((l) => ACCESS_LINE.test(l.trim())).length;
  console.log('[日志] ' + logFile + '  其中 combined 访问行 ' + accessLineCount + ' 条');

  /* ---- M4-1 统计口径 + M4-2 告警会响 ---- */
  {
    const run = spawnSync(process.execPath, [BASELINE, '--json', '--days=1',
      '--max-created=3', '--max-rejected=1', '--max-deliveries=5', '--max-ips=99', '--log=' + logFile],
      { encoding: 'utf8', cwd: SERVER, env: { ...process.env, GQXQ_DB_NAME: TEST_DB } });
    let out = null;
    try { out = JSON.parse(run.stdout); } catch { out = null; }
    const lines = ['[执行] node intake-baseline.mjs --json --days=1 --log=<演练日志>（阈值调低到必然越线）',
      '[退出码] ' + run.status, '[期望今日] created=' + (before.created + tally.created) +
      ' duplicate_same=' + (before.duplicateSame + tally.duplicate_same) +
      ' rejected=' + (before.rejected + tally.rejected)];
    if (!out) {
      lines.push('[判定] 输出不是 JSON：' + String(run.stdout).slice(0, 300) + String(run.stderr).slice(0, 300));
      emit('M4-1', '按日四类计数与真实投递一致', 'FAIL', lines);
      emit('M4-2', '超阈值判 ANOMALY 且退出码 1', 'FAIL', lines);
      markFail();
    } else {
      const today = (out.daily || []).find((r) => r.day === TODAY) || { created: 0, updated: 0, duplicateSame: 0, rejected: 0, deliveries: 0, sourceIds: 0 };
      const expect = {
        created: before.created + tally.created,
        updated: before.updated + tally.updated,
        duplicateSame: before.duplicateSame + tally.duplicate_same,
        rejected: before.rejected + tally.rejected,
        deliveries: before.deliveries + tally.created + tally.duplicate_same + tally.rejected + tally.updated,
      };
      const diffs = [];
      for (const k of Object.keys(expect)) if (today[k] !== expect[k]) diffs.push(k + ': 实际 ' + today[k] + ' 期望 ' + expect[k]);
      lines.push('[实际今日] ' + JSON.stringify(today));
      if (diffs.length === 0) {
        lines.push('[判定] 四类计数逐字段等于"演练前 + 本次投递"，按日聚合口径正确（created/' +
          'duplicate_same/rejected 三类攻击面各自可数）');
        emit('M4-1', '按日四类计数与真实投递一致', 'PASS', lines);
      } else {
        lines.push('[判定] 不一致：' + diffs.join('；'));
        emit('M4-1', '按日四类计数与真实投递一致', 'FAIL', lines);
        markFail();
      }

      const anoms = (out.anomalies || []).filter((a) => a.source === 'complaint_source_log' && a.day === TODAY);
      const reasons = anoms.map((a) => a.reasons.join('；')).join(' | ');
      if (run.status === 1 && anoms.length === 1) {
        lines.push('');
        lines.push('[ANOMALY] ' + reasons);
        lines.push('[判定] 演练投递量越过阈值 ⇒ 判 ANOMALY 且退出码 1 ⇒ 告警通道可用（文档 M4 判据）');
        emit('M4-2', '超阈值判 ANOMALY 且退出码 1', 'PASS', lines);
      } else {
        lines.push('[判定] 期望退出码 1 + 今日恰 1 条 ANOMALY；实际退出码 ' + run.status + ' ANOMALY 数 ' + anoms.length);
        emit('M4-2', '超阈值判 ANOMALY 且退出码 1', 'FAIL', lines);
        markFail();
      }

      /* ---- M4-4 日志状态码聚合 ---- */
      const acc = out.accessLog || null;
      const logLines = ['[输入] ' + logFile + '（真机 morgan combined，非手造样本）'];
      if (!acc) {
        logLines.push('[判定] 未拿到 accessLog 维度');
        emit('M4-4', 'morgan combined 日志按状态码聚合', 'FAIL', logLines);
        markFail();
      } else {
        logLines.push('[聚合] 全量=' + JSON.stringify(acc.byStatus));
        logLines.push('[聚合] /external=' + JSON.stringify(acc.externalByStatus));
        const ext = acc.externalByStatus || {};
        const wantExt200 = tally.ok200;
        const wantExt400 = tally.bad400;
        const ok = (ext['200'] || 0) === wantExt200 && (ext['400'] || 0) === wantExt400 &&
          (acc.byStatus['401'] || 0) >= tally.unauth401 && acc.linesParsed === accessLineCount;
        if (ok) {
          logLines.push('[判定] /external 200=' + ext['200'] + '（投递成功数 ' + wantExt200 + '）、' +
            '400=' + ext['400'] + '（被拒数 ' + wantExt400 + '）、401≥' + tally.unauth401 +
            '；解析行数 ' + acc.linesParsed + ' = 文件里的访问行数 ' + accessLineCount +
            ' ⇒ 状态码聚合与真实请求逐一对上，一条不漏也不多');
          emit('M4-4', 'morgan combined 日志按状态码聚合', 'PASS', logLines);
        } else {
          logLines.push('[判定] 期望 /external 200=' + wantExt200 + ' 400=' + wantExt400 +
            '，全量含 401≥' + tally.unauth401 + '，解析行数 == 访问行数 ' + accessLineCount +
            '；实际见上面聚合值');
          emit('M4-4', 'morgan combined 日志按状态码聚合', 'FAIL', logLines);
          markFail();
        }
      }
    }
  }

  /* ---- M4-3 阈值放宽后不空响 ---- */
  {
    const run = spawnSync(process.execPath, [BASELINE, '--json', '--days=1',
      '--max-created=9999', '--max-deliveries=9999', '--max-rejected=9999', '--max-ips=9999',
      '--log=' + logFile],
      { encoding: 'utf8', cwd: SERVER, env: { ...process.env, GQXQ_DB_NAME: TEST_DB } });
    const lines = ['[执行] 同一份数据、阈值放宽到必然不越线（含 --log 状态码维度）',
      '[退出码] ' + run.status, '[stderr] ' + String(run.stderr).trim().slice(0, 200)];
    let n = -1;
    try { n = (JSON.parse(run.stdout).anomalies || []).length; } catch { /* 保持 -1 */ }
    lines.push('[ANOMALY 数] ' + n);
    if (run.status === 0 && n === 0) {
      lines.push('[判定] 未越线即静默 ⇒ 告警不会天天空响（否则一线会把告警关掉，M4 归零）');
      emit('M4-3', '未超阈值不告警', 'PASS', lines);
    } else {
      lines.push('[判定] 期望退出码 0 且 0 条 ANOMALY');
      emit('M4-3', '未超阈值不告警', 'FAIL', lines);
      markFail();
    }
  }

  if (existsSync(logFile)) unlinkSync(logFile);
}

/* ---------------- 清理 + M4-5 回到基线 ---------------- */

{
  const ph = (list) => list.map(() => '?').join(', ');
  const lines = [];
  if (sourceIds.length > 0) {
    const ids = sourceIds.concat([PREFIX + 'BAD1', PREFIX + 'BAD2']);
    const [a] = await db.execute('delete from complaint_source_log where source_system = ? and source_id in (' + ph(ids) + ')', ['宜接就办', ...ids]);
    lines.push('[删除] complaint_source_log affected=' + a.affectedRows);
    const [b] = await db.execute('delete from complaint where source_system = ? and source_id in (' + ph(ids) + ')', ['宜接就办', ...ids]);
    lines.push('[删除] complaint affected=' + b.affectedRows);
    const [c] = await db.execute('delete from operation_audit_log where biz_type = ? and biz_id in (' + ph(ids) + ')', ['complaint', ...ids]);
    lines.push('[删除] operation_audit_log(biz_id=source_id，被拒留痕) affected=' + c.affectedRows);
  }
  if (complaintIds.length > 0) {
    const [d] = await db.execute('delete from complaint_field_version where complaint_id in (' + ph(complaintIds) + ')', complaintIds);
    lines.push('[删除] complaint_field_version affected=' + d.affectedRows);
    const [e] = await db.execute('delete from sensitive_hit where complaint_id in (' + ph(complaintIds) + ')', complaintIds);
    lines.push('[删除] sensitive_hit affected=' + e.affectedRows);
    const [f] = await db.execute('delete from operation_audit_log where biz_type = ? and biz_id in (' + ph(complaintIds) + ')', ['complaint', ...complaintIds]);
    lines.push('[删除] operation_audit_log(biz_id=complaint_id) affected=' + f.affectedRows);
  }
  const [left] = await db.execute(
    'select count(*) n from complaint_source_log where source_system = ? and source_id like ?',
    ['宜接就办', PREFIX + '%']
  );
  const [leftC] = await db.execute('select count(*) n from complaint where source_system = ? and source_id like ?', ['宜接就办', PREFIX + '%']);
  lines.push('[归零] 本次演练 source_id 残留 source_log=' + Number(left[0].n) + ' complaint=' + Number(leftC[0].n));

  const after = await readToday();
  lines.push('[演练后今日] ' + JSON.stringify(after), '[演练前今日] ' + JSON.stringify(before));
  const same = Object.keys(before).every((k) => after[k] === before[k]);
  if (Number(left[0].n) === 0 && Number(leftC[0].n) === 0 && same) {
    lines.push('[判定] 测试行删净且按日计数回到演练前 ⇒ 演练不留残留；number_sequence 当日水位按设计不回退');
    emit('M4-5', '清理后回到基线', 'PASS', lines);
  } else {
    lines.push('[判定] 期望残留 0 且今日计数逐字段等于演练前');
    emit('M4-5', '清理后回到基线', 'FAIL', lines);
    markFail();
  }
}

await db.end();

const count = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) count[r.status] = (count[r.status] || 0) + 1;
console.log('');
console.log('=== 汇总 ===');
console.log('PASS ' + count.PASS + ' / FAIL ' + count.FAIL + ' / SKIP ' + count.SKIP);
console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
const exitCode = failed ? 1 : 0;
console.log('退出码: ' + exitCode + (exitCode === 1 ? '（存在 FAIL）' : '（无 FAIL）'));
process.exit(exitCode);
