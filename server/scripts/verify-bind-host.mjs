#!/usr/bin/env node
/**
 * verify-bind-host.mjs — M1 断言：服务监听地址显式可配置，默认只绑回环
 *
 * 依据：docs/2026-09-19-入站无鉴权端点防护方案.md §4.1 M1
 *   改造前事实：index.ts 是 app.listen(port) 不传 host ⇒ 0.0.0.0/::，
 *              env 里根本没有 HOST/BIND 项，"只在内网"仅是文档承诺。
 *   文档验收判据：「从同网段另一台机器直连端口失败；/health 经反代仍 200」。
 *     本机没有第二台机器 ⇒ 用「本机非回环网卡地址 192.168.x.x 直连」等价替代
 *     （它走的是与同网段主机同一个监听套接字），此处如实记录这一替代口径；
 *     反代由运维侧配置（M3 的另一半），本脚本只断言回环 HTTP 仍 200。
 *
 * 断言清单（全部 FAIL 才退出码非 0，任何一条 FAIL 都算不通过）：
 *   M1-1 不设 GQXQ_HOST ⇒ 子进程自报「监听地址: 127.0.0.1:<port>」（取自 server.address()，非拼接假设值）
 *   M1-2 回环 HTTP /health = 200 且 database=up（收敛监听没有打掉可用性）
 *   M1-3 用本机非回环网卡地址直连该端口 ⇒ 连不上（ECONNREFUSED/ETIMEDOUT 等，绝不成功）
 *   M1-4 显式 GQXQ_HOST=0.0.0.0 ⇒ 自报监听 0.0.0.0:<port> 且非回环地址可连上
 *        （证明这是可配置的旋钮，不是写死的回环）
 *   M1-5 绑非回环时启动日志出现暴露面警告（把"匿名可写"显性化，M5 同一条纪律）
 *   M1-6 GQXQ_HOST 配成不属于本机的地址 ⇒ 进程响亮失败退出，绝不静默回落到全接口
 *
 * 安全边界：子进程一律指向测试库（GQXQ_TEST_DB_NAME，默认 gqxq_service_test）；
 *          解析出的目标库名等于 gqxq_service 时立即中止（禁碰真库）。
 *          端口用 3313/3314/3315，不占用开发实例的 3100。
 *
 * 用法：
 *   cd server && npm run build && node scripts/verify-bind-host.mjs
 *   GQXQ_TEST_DB_NAME=gqxq_service_test node scripts/verify-bind-host.mjs
 *
 * 退出码：任一 FAIL -> 1；前置条件不满足 -> 2；全 PASS -> 0。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const ENTRY = join(SERVER, 'dist', 'index.js');

const DEFAULT_PORT = '127.0.0.1';
const PORTS = { loopbackDefault: '3313', wildcard: '3314', badHost: '3315' };
const BAD_HOST = '203.0.113.77'; // TEST-NET-3，必然不属于本机：用来验证"配错就响亮失败"

const results = [];
function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 44 - title.length)));
  console.log('  状态: ' + status);
  for (const l of lines || []) console.log('  ' + l);
}

/** 目标库：只允许测试库 */
const TEST_DB = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';
if (TEST_DB === 'gqxq_service') {
  console.error('[verify-m1] 中止：GQXQ_TEST_DB_NAME 解析为真实库 gqxq_service，禁止对真库跑验收。');
  process.exit(2);
}

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** 探测：返回 'ok' 或错误码（不会抛出） */
function probe(host, port, timeoutMs = 2500) {
  return new Promise((done) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(r);
    };
    const timer = setTimeout(() => finish('ETIMEDOUT'), timeoutMs);
    sock.on('connect', () => finish('ok'));
    sock.on('error', (e) => finish(e.code || 'ERROR'));
  });
}

async function httpHealth(port) {
  const url = 'http://127.0.0.1:' + port + '/api/v1/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: '', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 起一个一次性实例并等它自报监听地址。
 * expectCrash=true 时，进程「启动即失败」也算正常返回（用于 M1-6）。
 */
function startInstance(opts) {
  const { port, host, extraEnv = {}, expectCrash = false } = opts;
  const env = { ...process.env, PORT: port, GQXQ_DB_NAME: TEST_DB, NODE_ENV: 'development' };
  if (host === undefined) delete env.GQXQ_HOST;
  else env.GQXQ_HOST = host;
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, [ENTRY], { cwd: SERVER, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  let exitInfo = null;
  const exited = new Promise((res) => child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    res(exitInfo);
  }));

  async function waitReady() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (exitInfo) {
        return expectCrash
          ? { ready: false, crashed: true, log, exit: exitInfo }
          : { ready: false, log, exit: exitInfo };
      }
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

  return { child, waitReady, stop, getLog: () => log };
}

async function ensurePortFree(label) {
  const lan = lanIPv4();
  for (const host of [DEFAULT_PORT, lan].filter(Boolean)) {
    const r = await probe(host, PORTS[label], 800);
    if (r === 'ok') {
      console.error('[verify-m1] 中止：端口 ' + PORTS[label] + ' 已被占用（' + host + ' 可连通）。' +
        '请释放该端口后重跑，不要打扰开发实例。');
      process.exit(2);
    }
  }
}

console.log('=== M1 监听地址断言 verify-bind-host.mjs ===');
console.log('目标库: ' + TEST_DB + '（只允许测试库）');
console.log('本机非回环 IPv4: ' + (lanIPv4() || '(无，M1-3/M1-4 将判 SKIP)'));
console.log('被测入口: ' + ENTRY);

let failed = false;
const markFail = () => { failed = true; };

/* ---------------- M1-1/2/3 默认只绑回环 ---------------- */

await ensurePortFree('loopbackDefault');
{
  const inst = startInstance({ port: PORTS.loopbackDefault, host: undefined });
  const ready = await inst.waitReady();
  const log = ready.log;
  const bound = (log.match(/\[Server\] 监听地址: (\S+)/) || [])[1] || '(无)';
  const lan = lanIPv4();

  if (!ready.ready) {
    emit('M1-1', '默认监听地址为回环', 'FAIL', [
      '子进程未能报告监听地址（ready=' + ready.ready + ' exit=' + JSON.stringify(ready.exit || null) + '）',
      '--- 子进程输出 ---',
      ...log.split(/\r?\n/).slice(-15).map((l) => '# ' + l),
      '前置：先 cd server && npm run build（本脚本测的是 dist 产物）',
    ]);
    markFail();
    emit('M1-2', '回环 /health 仍 200', 'FAIL', ['实例未起来']);
    markFail();
    emit('M1-3', '非回环地址直连失败', 'FAIL', ['实例未起来']);
    markFail();
  } else {
    const want = '127.0.0.1:' + PORTS.loopbackDefault;
    const lines = ['[子进程自报] ' + bound, '[期望] ' + want, '[依据] 未设 GQXQ_HOST ⇒ env.ts 的默认值 127.0.0.1'];
    if (bound === want) {
      emit('M1-1', '默认监听地址为回环', 'PASS', lines);
    } else {
      emit('M1-1', '默认监听地址为回环', 'FAIL', lines.concat('[判定] 实际自报值不等于期望回环值'));
      markFail();
    }

    const h = await httpHealth(PORTS.loopbackDefault);
    const hLines = ['[请求] GET http://127.0.0.1:' + PORTS.loopbackDefault + '/api/v1/health',
      '[响应] HTTP ' + h.status + '  ' + h.text.slice(0, 200)];
    if (h.status === 200 && /"database"\s*:\s*"up"/.test(h.text)) {
      hLines.push('[判定] 收敛监听后回环可用、库连通（"只绑回环"没有把服务变成不可用）');
      emit('M1-2', '回环 /health 仍 200', 'PASS', hLines);
    } else {
      hLines.push('[判定] 期望 200 且 database=up');
      emit('M1-2', '回环 /health 仍 200', 'FAIL', hLines);
      markFail();
    }

    if (!lan) {
      emit('M1-3', '非回环地址直连失败', 'SKIP', ['本机无非回环 IPv4 网卡，无法等价替代"同网段另一台机器"']);
    } else {
      const p = await probe(lan, PORTS.loopbackDefault);
      const pLines = ['[直连] ' + lan + ':' + PORTS.loopbackDefault + '（本机非回环网卡地址，等价于同网段入口）',
        '[结果] ' + p, '[期望] 非 ok（连不上）'];
      if (p === 'ok') {
        pLines.push('[判定] 端口在非回环地址上可达 ⇒ M1 未生效（仍在监听全接口）');
        emit('M1-3', '非回环地址直连失败', 'FAIL', pLines);
        markFail();
      } else {
        pLines.push('[判定] 非回环入口不可达 ⇒ 入站端点对同网段已不可直连（文档 M1 判据）');
        emit('M1-3', '非回环地址直连失败', 'PASS', pLines);
      }
    }
  }
  await inst.stop();
}

/* ---------------- M1-4/5 显式全接口仍可用 + 警告 ---------------- */

await ensurePortFree('wildcard');
{
  const inst = startInstance({ port: PORTS.wildcard, host: '0.0.0.0' });
  const ready = await inst.waitReady();
  const log = ready.log;
  const bound = (log.match(/\[Server\] 监听地址: (\S+)/) || [])[1] || '(无)';
  const lan = lanIPv4();
  const warned = /\[Server\] 警告:.*不是回环地址/.test(log);

  if (!ready.ready) {
    emit('M1-4', '显式 0.0.0.0 仍可绑定（旋钮生效）', 'FAIL', ['实例未起来 exit=' + JSON.stringify(ready.exit || null),
      ...log.split(/\r?\n/).slice(-12).map((l) => '# ' + l)]);
    markFail();
    emit('M1-5', '非回环监听触发暴露面警告', 'FAIL', ['实例未起来']);
    markFail();
  } else {
    const want = '0.0.0.0:' + PORTS.wildcard;
    const lines = ['[子进程自报] ' + bound, '[期望] ' + want, '[依据] GQXQ_HOST=0.0.0.0 显式覆盖默认值'];
    if (bound !== want) {
      lines.push('[判定] 自报值不是 0.0.0.0 ⇒ 旋钮未生效或写死');
      emit('M1-4', '显式 0.0.0.0 仍可绑定（旋钮生效）', 'FAIL', lines);
      markFail();
    } else if (!lan) {
      emit('M1-4', '显式 0.0.0.0 仍可绑定（旋钮生效）', 'PASS', lines.concat('[补充] 无非回环网卡，连通性探测跳过'));
    } else {
      const p = await probe(lan, PORTS.wildcard);
      lines.push('[直连] ' + lan + ':' + PORTS.wildcard + ' -> ' + p);
      if (p !== 'ok') {
        lines.push('[判定] 绑定成功但非回环地址连不上（预期能连上）');
        emit('M1-4', '显式 0.0.0.0 仍可绑定（旋钮生效）', 'FAIL', lines);
        markFail();
      } else {
        lines.push('[判定] 监听地址由配置决定：默认回环、显式可放开 ⇒ 不是写死');
        emit('M1-4', '显式 0.0.0.0 仍可绑定（旋钮生效）', 'PASS', lines);
      }
    }

    const wLines = ['[期望] 子进程 stderr/stdout 含 "[Server] 警告: … 不是回环地址 …"',
      '[命中] ' + (warned ? '是' : '否')];
    if (warned) {
      wLines.push('[判定] 放开监听时启动即显性提示入站端点无凭证、人人可写（M5 的"从隐性变显性"）');
      emit('M1-5', '非回环监听触发暴露面警告', 'PASS', wLines);
    } else {
      wLines.push('[判定] 未警告 ⇒ 误放开时无任何提示，防护方案的"显性化"落空');
      emit('M1-5', '非回环监听触发暴露面警告', 'FAIL', wLines);
      markFail();
    }
  }
  await inst.stop();
}

/* ---------------- M1-6 配错就响亮失败 ---------------- */

await ensurePortFree('badHost');
{
  const inst = startInstance({ port: PORTS.badHost, host: BAD_HOST, expectCrash: true });
  const ready = await inst.waitReady();
  const log = ready.log;
  const p = await probe('127.0.0.1', PORTS.badHost);
  const lines = ['[配置] GQXQ_HOST=' + BAD_HOST + '（TEST-NET 保留地址，不属于本机）',
    '[进程] ' + (ready.crashed ? '已退出 exit=' + JSON.stringify(ready.exit) : 'ready=' + ready.ready + ' exit=' + JSON.stringify(ready.exit || null)),
    '[回环探测] 127.0.0.1:' + PORTS.badHost + ' -> ' + p];
  const exitBadly = ready.crashed && (ready.exit.code === null ? false : ready.exit.code !== 0);
  if (exitBadly && p !== 'ok') {
    lines.push('[判定] 绑定失败即退出、没有偷偷改绑别的地址 ⇒ 符合"配置错就响亮失败"的既有纪律');
    emit('M1-6', '非法监听地址拒绝启动', 'PASS', lines);
  } else if (ready.crashed && p === 'ok') {
    lines.push('[判定] 进程退了但端口又能连上 ⇒ 说明有别的进程在听，本项判定不可信');
    emit('M1-6', '非法监听地址拒绝启动', 'FAIL', lines);
    markFail();
  } else {
    lines.push('[判定] 期望非 0 退出码；实际未崩溃或退出码为 0（详见子进程输出）');
    lines.push(...log.split(/\r?\n/).slice(-12).map((l) => '# ' + l));
    emit('M1-6', '非法监听地址拒绝启动', 'FAIL', lines);
    markFail();
  }
  await inst.stop();
}

/* ---------------- 汇总 ---------------- */

const count = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) count[r.status] = (count[r.status] || 0) + 1;
console.log('');
console.log('=== 汇总 ===');
console.log('PASS ' + count.PASS + ' / FAIL ' + count.FAIL + ' / SKIP ' + (count.SKIP || 0));
console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
const exitCode = failed ? 1 : 0;
console.log('退出码: ' + exitCode + (exitCode === 1 ? '（存在 FAIL）' : '（无 FAIL）'));
process.exit(exitCode);
