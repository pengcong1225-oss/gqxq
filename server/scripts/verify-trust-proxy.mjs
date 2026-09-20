#!/usr/bin/env node
/**
 * verify-trust-proxy.mjs — M3 断言：网关透传可信、XFF 不可被远程伪造、配错就响亮失败
 *
 * 依据：docs/2026-09-19-入站无鉴权端点防护方案.md §4.1 M3 与 §1.4-4
 *   「仓库内没有任何 trust proxy 设置 ⇒ 一旦套上网关，req.ip 与
 *     complaint_source_log.remote_ip 会全部变成网关 IP ——
 *     IP 白名单与事后追溯同时失效」
 *   文档验收判据：「complaint_source_log.remote_ip 记到真实来源而非网关」。
 *   （同一条目里的 allow/deny 与 limit_req/429 属反代配置，非本批仓库侧，见 §5 说明）
 *
 * 做法：为每种 trust proxy 取值起一个一次性实例（测试库、3320-3325 端口，串行），
 *      投递真实报文，然后**从库里读回 remote_ip** 判定 —— 判定落在留痕列上，
 *      不依赖响应体自述，也不只看日志。
 *
 * 断言清单：
 *   M3-1 默认 loopback + 同机（回环）反代透传 ⇒ remote_ip = XFF 里的真实来源，而非 127.0.0.1
 *   M3-2 GQXQ_TRUST_PROXY=off ⇒ 同样的 XFF 一律不采信，remote_ip = 连接对端 127.0.0.1
 *   M3-3 默认 loopback + 非回环对端直连（本机 LAN IP）带 XFF ⇒ remote_ip = 对端真实 IP，
 *        XFF 被忽略（钉住 M3 失效模式②「trust proxy 误设为 true 使 XFF 可伪造」）
 *   M3-4 GQXQ_TRUST_PROXY=true ⇒ 任意来源可伪造留痕 IP（实测能伪造）且启动即警告
 *   M3-5 GQXQ_TRUST_PROXY=private（防护方案原文用词）⇒ 映射到本仓库 proxy-addr 支持的
 *        uniquelocal 域，私网对端的 XFF 被采信（否则照抄文档会抛 invalid IP address）
 *   M3-6 非法取值 ⇒ 进程非 0 退出并点名 GQXQ_TRUST_PROXY，端口不可达，绝不静默回退
 *
 * 安全边界：只连测试库（GQXQ_TEST_DB_NAME，默认 gqxq_service_test）；
 *          解析到 gqxq_service 立即中止。测试行按 source_id / complaint_id / biz_id 精确删除，
 *          删完断言归零。不占用开发实例的 3100。
 *
 * 用法：cd server && npm run build && node scripts/verify-trust-proxy.mjs
 * 退出码：任一 FAIL -> 1；前置不满足 -> 2；全 PASS -> 0。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const ENTRY = join(SERVER, 'dist', 'index.js');
dotenv.config({ path: join(SERVER, '.env') });

const TEST_DB = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';
if (TEST_DB === 'gqxq_service') {
  console.error('[verify-m3] 中止：GQXQ_TEST_DB_NAME 解析为真实库 gqxq_service，禁止对真库跑验收。');
  process.exit(2);
}

const STAMP = Date.now();
const SOURCE_PREFIX = 'ACCHM3';
const createdSourceIds = [];
const createdComplaintIds = [];

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

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}
const LAN = lanIPv4();

/** Express 在 IPv6 双栈下可能给 ::ffff:a.b.c.d，统一成点分十进制再比 */
function normalizeIp(value) {
  if (typeof value !== 'string') return value;
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

/* ---------------- 被测实例 ---------------- */

function startInstance(opts) {
  const { port, trustProxy, host = '127.0.0.1' } = opts;
  const env = {
    ...process.env,
    PORT: port,
    GQXQ_DB_NAME: TEST_DB,
    GQXQ_HOST: host,
    NODE_ENV: 'development',
  };
  if (trustProxy === undefined) delete env.GQXQ_TRUST_PROXY;
  else env.GQXQ_TRUST_PROXY = trustProxy;

  const child = spawn(process.execPath, [ENTRY], { cwd: SERVER, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  let exitInfo = null;
  const exited = new Promise((res) => child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    res(exitInfo);
  }));

  async function waitReady(expectCrash) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (exitInfo) return { ready: false, crashed: !!expectCrash, log, exit: exitInfo };
      if (log.includes('[Server] 监听地址:')) return { ready: true, log };
      await new Promise((r) => setTimeout(r, 120));
    }
    return { ready: false, timeout: true, log };
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await exited.catch(() => {});
  }

  return { waitReady, stop, getLog: () => log };
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

async function ensurePortFree(port) {
  for (const host of ['127.0.0.1', LAN].filter(Boolean)) {
    if (await portBusy(host, port)) {
      console.error('[verify-m3] 中止：端口 ' + port + ' 已被占用（' + host + ' 可连通）。请释放后重跑。');
      process.exit(2);
    }
  }
}

function postAppeal(opts) {
  const { host, port, sourceId, xff } = opts;
  const body = JSON.stringify({
    sourceId,
    title: 'M3 断言 trust proxy 留痕 ' + sourceId,
    content: 'verify-trust-proxy.mjs 自动生成，用于断言 remote_ip 记到真实来源而非网关。',
    address: '西陵区沿江大道188号',
    districtName: '西陵区',
    source: '12345热线',
  });
  return new Promise((done) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (xff) headers['x-forwarded-for'] = xff;
    const req = http.request({ host, port, path: '/api/v1/external/yijiejieban/appeal', method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('error', (e) => done({ status: 0, text: '', error: e.code || String(e) }));
    req.setTimeout(15000, () => { req.destroy(); done({ status: 0, text: '', error: 'TIMEOUT' }); });
    req.end(body);
  });
}

/* ---------------- 库 ---------------- */

const db = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database: TEST_DB,
  timezone: '+08:00',
  multipleStatements: false,
});

async function readRemoteIp(sourceId) {
  const [rows] = await db.execute(
    'select result, remote_ip, request_id from complaint_source_log ' +
      'where source_system = ? and source_id = ? order by id desc limit 1',
    ['宜接就办', sourceId]
  );
  return rows[0] || null;
}

/** 一次完整探针：起实例 -> 投递 -> 回读库 -> 停实例 */
async function probe({ id, title, port, trustProxy, bindHost, connectHost, xff, expectIp, expectWarn }) {
  await ensurePortFree(String(port));
  const inst = startInstance({ port: String(port), trustProxy, host: bindHost });
  const ready = await inst.waitReady(false);
  const lines = [
    '[配置] GQXQ_TRUST_PROXY=' + (trustProxy === undefined ? '(未设，取默认 loopback)' : trustProxy),
    '[绑定] GQXQ_HOST=' + bindHost + '  端口 ' + port,
    '[连接] 对端 ' + connectHost + '，请求头 x-forwarded-for=' + (xff || '(不给)'),
  ];
  if (!ready.ready) {
    lines.push('[判定] 实例未起来 exit=' + JSON.stringify(ready.exit || null),
      ...ready.log.split(/\r?\n/).slice(-12).map((l) => '# ' + l));
    emit(id, title, 'FAIL', lines);
    markFail();
    await inst.stop();
    return;
  }
  if (expectWarn) {
    const hit = new RegExp(expectWarn.regex).test(ready.log);
    lines.push('[警告] 期望命中 /' + expectWarn.regex + '/ -> ' + (hit ? '是' : '否'));
    if (!hit) {
      emit(id, title, 'FAIL', lines.concat('[判定] 未打警告：危险配置的显性化落空'));
      markFail();
      await inst.stop();
      return;
    }
  }
  const sourceId = SOURCE_PREFIX + STAMP + '-' + id.replace(/[^0-9A-Za-z]/g, '');
  createdSourceIds.push(sourceId);
  const res = await postAppeal({ host: connectHost, port, sourceId, xff });
  lines.push('[投递] HTTP ' + res.status + (res.error ? ' 连接失败 ' + res.error : '  ' + res.text.slice(0, 160)));
  let status = 'FAIL';
  if (res.status !== 200) {
    lines.push('[判定] 期望 200（真实入站投递成功才有留痕行可比）');
  } else {
    const d = JSON.parse(res.text).data || {};
    if (d.complaintId) createdComplaintIds.push(d.complaintId);
    const row = await readRemoteIp(sourceId);
    if (!row) {
      lines.push('[判定] complaint_source_log 查不到该 source_id 的留痕行');
    } else {
      const actual = normalizeIp(row.remote_ip);
      lines.push('[留痕] complaint_source_log.result=' + row.result + '  remote_ip=' + JSON.stringify(actual),
        '[期望] remote_ip=' + JSON.stringify(expectIp));
      if (actual === expectIp) {
        lines.push('[判定] 留痕 IP 与期望一致 ⇒ trust proxy 语义正确');
        status = 'PASS';
      } else {
        lines.push('[判定] 不一致：XFF 采信策略与期望不符');
      }
    }
  }
  emit(id, title, status, lines);
  if (status !== 'PASS') markFail();
  await inst.stop();
}

/* ---------------- 跑断言（串行） ---------------- */

console.log('=== M3 trust proxy 断言 verify-trust-proxy.mjs ===');
console.log('目标库: ' + TEST_DB);
console.log('本机非回环 IPv4: ' + (LAN || '(无，M3-3/M3-4/M3-5 将判 SKIP)'));

if (!LAN) {
  emit('M3-3', '非回环对端不能伪造留痕 IP', 'SKIP', ['无非回环网卡']);
  emit('M3-4', 'true 时 XFF 可被任意来源伪造并警告', 'SKIP', ['无非回环网卡']);
  emit('M3-5', 'private 别名映射为 uniquelocal', 'SKIP', ['无非回环网卡']);
} else {
  // M3-1：同机反代（回环对端）透传 XFF -> 记真实来源
  await probe({
    id: 'M3-1', title: '默认 loopback：网关透传的 XFF 记为真实来源', port: 3320,
    trustProxy: undefined, bindHost: '127.0.0.1', connectHost: '127.0.0.1',
    xff: '203.0.113.10', expectIp: '203.0.113.10',
  });
  // M3-2：off -> XFF 不采信
  await probe({
    id: 'M3-2', title: 'off：XFF 一律不采信，记连接对端', port: 3321,
    trustProxy: 'off', bindHost: '127.0.0.1', connectHost: '127.0.0.1',
    xff: '203.0.113.11', expectIp: '127.0.0.1',
  });
  // M3-3：默认 loopback + 非回环对端 -> XFF 被忽略（钉住失效模式②）
  await probe({
    id: 'M3-3', title: '默认 loopback：非回环直连者不能用 XFF 伪造留痕 IP', port: 3322,
    trustProxy: undefined, bindHost: '0.0.0.0', connectHost: LAN,
    xff: '203.0.113.13', expectIp: normalizeIp(LAN),
  });
  // M3-4：true -> 谁都能伪造（如实测出可伪造）+ 必须警告
  await probe({
    id: 'M3-4', title: 'true：任意来源可伪造留痕 IP（实测可伪造）且启动警告', port: 3323,
    trustProxy: 'true', bindHost: '0.0.0.0', connectHost: LAN,
    xff: '203.0.113.12', expectIp: '203.0.113.12',
    expectWarn: { regex: 'trust proxy=true' },
  });
  // M3-5：private 别名（方案原文用词）-> uniquelocal，私网对端的 XFF 被采信
  await probe({
    id: 'M3-5', title: 'private 别名生效（映射 uniquelocal）：私网对端 XFF 被采信', port: 3324,
    trustProxy: 'private', bindHost: '0.0.0.0', connectHost: LAN,
    xff: '203.0.113.14', expectIp: '203.0.113.14',
  });
}

/* M3-6：非法取值必须响亮失败 */
{
  const port = 3325;
  await ensurePortFree(String(port));
  const inst = startInstance({ port: String(port), trustProxy: 'not-a-trust-range', host: '127.0.0.1' });
  const ready = await inst.waitReady(true);
  const log = ready.log;
  const named = /GQXQ_TRUST_PROXY 取值无效/.test(log);
  const busy = await portBusy('127.0.0.1', port);
  const lines = [
    '[配置] GQXQ_TRUST_PROXY=not-a-trust-range（既非域名也非 IP/CIDR/跳数）',
    '[进程] ' + (ready.exit ? '退出 ' + JSON.stringify(ready.exit) : '未退出'),
    '[输出] 是否点名 GQXQ_TRUST_PROXY: ' + (named ? '是' : '否'),
    '[端口] 127.0.0.1:' + port + ' 仍在监听: ' + (busy ? '是（不该）' : '否'),
  ];
  const exitedBadly = !!ready.exit && ready.exit.code !== 0;
  if (exitedBadly && named && !busy) {
    lines.push('[判定] 非法配置直接启动失败并点名变量，没有静默按网关 IP 记账');
    emit('M3-6', '非法 trust proxy 拒绝启动', 'PASS', lines);
  } else {
    lines.push('[判定] 期望：非 0 退出 + 报错点名 GQXQ_TRUST_PROXY + 端口不可达');
    lines.push(...log.split(/\r?\n/).slice(-12).map((l) => '# ' + l));
    emit('M3-6', '非法 trust proxy 拒绝启动', 'FAIL', lines);
    markFail();
  }
  await inst.stop();
}

/* ---------------- 清理测试行并断言归零 ---------------- */

{
  const ph = (list) => list.map(() => '?').join(', ');
  const sourceIds = createdSourceIds;
  const complaintIds = createdComplaintIds;
  const del = [];
  if (sourceIds.length > 0) {
    del.push(['complaint_source_log', 'delete from complaint_source_log where source_system = ? and source_id in (' + ph(sourceIds) + ')',
      ['宜接就办', ...sourceIds]]);
    del.push(['complaint', 'delete from complaint where source_system = ? and source_id in (' + ph(sourceIds) + ')',
      ['宜接就办', ...sourceIds]]);
    del.push(['operation_audit_log', 'delete from operation_audit_log where biz_type = ? and biz_id in (' + ph(sourceIds) + ')',
      ['complaint', ...sourceIds]]);
  }
  if (complaintIds.length > 0) {
    del.push(['complaint_field_version', 'delete from complaint_field_version where complaint_id in (' + ph(complaintIds) + ')', complaintIds]);
    del.push(['sensitive_hit', 'delete from sensitive_hit where complaint_id in (' + ph(complaintIds) + ')', complaintIds]);
    del.push(['operation_audit_log', 'delete from operation_audit_log where biz_type = ? and biz_id in (' + ph(complaintIds) + ')',
      ['complaint', ...complaintIds]]);
  }
  const lines = [];
  let cleanupOk = true;
  for (const [table, sql, params] of del) {
    const [r] = await db.execute(sql, params);
    lines.push('[删除] ' + table + ' affected=' + r.affectedRows);
  }
  const checks = [];
  if (sourceIds.length > 0) {
    checks.push(['complaint_source_log', 'select count(*) n from complaint_source_log where source_system = ? and source_id in (' + ph(sourceIds) + ')', ['宜接就办', ...sourceIds]]);
    checks.push(['complaint', 'select count(*) n from complaint where source_system = ? and source_id in (' + ph(sourceIds) + ')', ['宜接就办', ...sourceIds]]);
    checks.push(['operation_audit_log', 'select count(*) n from operation_audit_log where biz_type = ? and biz_id in (' + ph(sourceIds) + ')', ['complaint', ...sourceIds]]);
  }
  if (complaintIds.length > 0) {
    checks.push(['complaint_field_version', 'select count(*) n from complaint_field_version where complaint_id in (' + ph(complaintIds) + ')', complaintIds]);
    checks.push(['operation_audit_log', 'select count(*) n from operation_audit_log where biz_type = ? and biz_id in (' + ph(complaintIds) + ')', ['complaint', ...complaintIds]]);
  }
  for (const [table, sql, params] of checks) {
    const [rows] = await db.execute(sql, params);
    const n = Number(rows[0].n);
    lines.push('[归零] ' + table + ' 残留=' + n);
    if (n !== 0) cleanupOk = false;
  }
  lines.push('[说明] number_sequence 当日序号被消耗（发号器按设计不回滚），只影响测试库序号水位，不影响业务行');
  emit('M3-9', '测试数据清理并断言归零', cleanupOk ? 'PASS' : 'FAIL', lines);
  if (!cleanupOk) markFail();
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
