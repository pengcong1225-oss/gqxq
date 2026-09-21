#!/usr/bin/env node
/**
 * verify-rbac.mjs — Task #35 断言：三档 RBAC + /users 真 CRUD + 审计到人
 *
 * 依据：docs/2026-09-21-角色权限映射.md（策略真源 server/src/auth/rolePolicy.ts）
 *   目标 2「后端强制 + 默认拒绝 + 401/403 语义分开」
 *   目标 3「/users 摘 501 → 真 CRUD（admin only）+ 防呆」
 *   目标 5「审计到人」
 *
 * 两种模式：
 *   A. 默认：**自起一次性实例**（测试库 + 127.0.0.1:3340），跑 RBAC-01…RBAC-13 全套。
 *   B. --live=<base>：打**已在跑**的实例（本机 3100），只跑不写业务数据的抽查矩阵
 *      RBAC-L1…L5；必须用 --db 指明它连的库（审计与账号断言要回读库）。
 *
 * 落库隔离（此前踩过 acceptance 误跑主库留测试行的坑）：
 *   * 模式 A 只连 GQXQ_TEST_DB_NAME，解析成 gqxq_service 立即中止；自己造的测试行
 *     （入站探针诉求、探针账号）在 RBAC-13 里精确删除并断言归零；
 *   * 模式 B 允许读主库，但**默认不建号**：要建必须显式 --provision，
 *     目标库是 gqxq_service 时还要再加 --allow-main-write（两道显式闸）；
 *   * 模式 B 的写探针一律用"应当被 RBAC 拦掉"的角色发（403 进不了业务层），
 *     或用不存在的业务键（放行也写不进任何东西）。
 *
 * 账号口径：测试账号 test_handler_01 / test_readonly_01，**批次结束保留**（供 #36 部署后对照）；
 *          真实业务账号一个不建。口令只从 env 读（GQXQ_TEST_HANDLER_PASSWORD /
 *          GQXQ_TEST_READONLY_PASSWORD；未设则本次随机生成、只在内存里用一次）。
 *          任何输出都不回显口令、哈希或 PII。
 *
 * 跑出来的两条既有语义（不是本批引入，别当 bug 改）：
 *   * "审计到人"只管**平台侧发起**的写；机器通道（P3 入站）写的 INTAKE_CREATE 仍是
 *     user_id=NULL —— 它没有平台账号可记，硬编一个 admin 反而是造假（RBAC-05 分两侧断言）；
 *   * 登录层顺序照旧：空/超长口令是契约失败（400 VALIDATION_FAILED），口令错是 401，
 *     403 只可能来自 RBAC 层（RBAC-11 断言）。
 *
 * 用法：
 *   cd server && npm run build && node scripts/verify-rbac.mjs
 *   node scripts/verify-rbac.mjs --live=http://127.0.0.1:3100/api/v1 --db=gqxq_service
 * 退出码：任一 FAIL -> 1；前置不满足 -> 2；全 PASS -> 0。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const ROOT = resolve(SERVER, '..');
const ENTRY = join(SERVER, 'dist', 'index.js');
const DOC = join(ROOT, 'docs', '2026-09-21-角色权限映射.md');
dotenv.config({ path: join(SERVER, '.env') });

const MAIN_DB = 'gqxq_service';
const TEST_DB = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';
const PORT = '3340';
const ADMIN_USERNAME = process.env.GQXQ_BOOTSTRAP_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.GQXQ_BOOTSTRAP_ADMIN_PASSWORD || '';
const HANDLER_USERNAME = 'test_handler_01';
const READONLY_USERNAME = 'test_readonly_01';
const PROBE_USER_1 = 'test_probe_rbac_01';
const PROBE_USER_2 = 'test_probe_rbac_02';
const PROBE_USER_3 = 'test_probe_rbac_03';
const PROBE_PASSWORD = 'Probe-Pass-2026';
const FORBIDDEN_MESSAGE = '无权限，请联系管理员';

/** 请求基址：主流程里按模式赋值（call() 的默认目标） */
let BASE = '';

const ARGV = process.argv.slice(2);
function flag(name) {
  const hit = ARGV.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? null : hit.slice(name.length + 3);
}
function has(name) {
  return ARGV.includes('--' + name);
}

const LIVE_BASE = flag('live');
const TARGET_DB = LIVE_BASE === null ? TEST_DB : flag('db') || TEST_DB;
const PROVISION = has('provision');

if (LIVE_BASE === null && TARGET_DB === MAIN_DB) {
  console.error('[verify-rbac] 中止：一次性实例的目标库解析为真实库 ' + MAIN_DB + '，禁止对真库跑验收。');
  process.exit(2);
}
if (LIVE_BASE === null && existsSync(ENTRY) === false) {
  console.error('[verify-rbac] 找不到 ' + ENTRY + '，请先 npm run build。');
  process.exit(2);
}
if (LIVE_BASE !== null && TARGET_DB === MAIN_DB && PROVISION && !has('allow-main-write')) {
  console.error('[verify-rbac] 中止：要向真实库 ' + MAIN_DB + ' 建测试账号，必须同时显式给 --allow-main-write。');
  process.exit(2);
}

/* ---------------- 输出与判定 ---------------- */

const results = [];
let failed = 0;
function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 44 - title.length)));
  console.log('  状态: ' + status);
  for (const l of lines || []) console.log('  ' + l);
}
function check(allOk, lines, id, title) {
  if (allOk) emit(id, title, 'PASS', lines);
  else { failed++; emit(id, title, 'FAIL', lines); }
}
let subNo = 0;
const sub = () => '  ·' + (++subNo) + ' ';

/* ---------------- HTTP ---------------- */

async function call(method, path, opts) {
  const { token, body, base } = opts || {};
  const url = (base || BASE) + path;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如 ACK 原文）按原样判定 */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: '', error: err && err.message ? err.message : String(err) };
  }
}

/* ---------------- 库 ---------------- */

const db = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database: TARGET_DB,
  timezone: '+08:00',
  multipleStatements: false,
});

async function rows(sql, params) {
  const [r] = await db.query(sql, params || []);
  return r;
}
async function scalar(sql, params) {
  const r = await rows(sql, params);
  return Number(r[0]?.n ?? 0);
}

/* ---------------- 测试账号 ---------------- */

async function ensureAccount(username, role, password) {
  const hash = await bcrypt.hash(password, 10);
  const existing = await rows('select user_id from app_user where username = ? limit 1', [username]);
  if (existing.length > 0) {
    // 复跑：把角色/状态修回断言所需的样子（测试账号口令一并重置，无真实用途）
    await db.execute(
      'update app_user set roles = ?, status = 1, password_hash = ?, real_name = ? where username = ?',
      [JSON.stringify([role]), hash, '验收测试账号-' + role, username]
    );
    return { userId: String(existing[0].user_id), created: false };
  }
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const [seqResult] = await db.query(
    'insert into number_sequence (seq_key, biz_date, current_value) values (?, ?, last_insert_id(1)) ' +
      'on duplicate key update current_value = last_insert_id(current_value + 1)',
    ['app_user', day]
  );
  const userId = 'USR' + day.replace(/-/g, '') + String(Number(seqResult.insertId)).padStart(4, '0');
  await db.query(
    'insert into app_user (user_id, username, password_hash, real_name, roles, permissions, status, created_at, updated_at) ' +
      'values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    [
      userId, username, hash, '验收测试账号-' + role, JSON.stringify([role]),
      JSON.stringify(role === 'admin' ? ['*'] : []), new Date(), new Date(),
    ]
  );
  return { userId, created: true };
}

async function loginToken(base, username, password) {
  const res = await call('POST', '/auth/login', { base, body: { username, password } });
  const token = res.json?.data?.token;
  return { status: res.status, token: typeof token === 'string' ? token : null, json: res.json };
}

/* ---------------- 一次性实例（模式 A） ---------------- */

function startInstance() {
  const env = {
    ...process.env,
    PORT,
    GQXQ_DB_NAME: TARGET_DB,
    GQXQ_HOST: '127.0.0.1',
    NODE_ENV: 'development',
  };
  const child = spawn(process.execPath, [ENTRY], { cwd: SERVER, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  let exitInfo = null;
  const exited = new Promise((res) => child.on('exit', (code, signal) => { exitInfo = { code, signal }; res(exitInfo); }));
  async function waitReady() {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (exitInfo) return { ready: false, log, exit: exitInfo };
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
  return { waitReady, stop };
}

function portBusy(port) {
  return new Promise((done) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    const finish = (r) => { sock.destroy(); done(r); };
    sock.setTimeout(800, () => finish(false));
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

/* ---------------- 策略表与文档 ---------------- */

function loadPolicy() {
  // Windows 下 import('D:/...') 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须走 file:// URL
  return import(pathToFileURL(join(SERVER, 'dist', 'auth', 'rolePolicy.js')).href);
}

/** 文档表格行编号：P 段是不走 role 的公开/机器端点，S/R/W/U/X 段应逐条对应策略表 */
function docEndpointIds() {
  const text = readFileSync(DOC, 'utf8');
  const ids = [];
  const pids = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*([PSRWUX]\d+)\s*\|/.exec(line.trim());
    if (m === null) continue;
    (m[1][0] === 'P' ? pids : ids).push(m[1]);
  }
  return { ids, pids };
}

/** 策略正则 -> 可请求的具体路径：参数段填不存在的业务键（放行也写不进东西） */
function rulePath(rule) {
  const path = rule.path.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[^\/\]\+/g, 'RBAC-NOT-EXIST')
    .replace(/\\\//g, '/');
  return path;
}

/* ---------------- 共用矩阵 ---------------- */

const READ_PROBES = ['/complaints?page=1&size=5', '/dashboard/overview'];
const WRITE_PROBES = [
  ['POST', '/complaints/RBAC-NOT-EXIST/assignment'],
  ['POST', '/complaints/RBAC-NOT-EXIST/disposition'],
  ['POST', '/complaints/RBAC-NOT-EXIST/corrections/generate'],
  ['POST', '/complaints/RBAC-NOT-EXIST/close'],
  ['POST', '/complaints/RBAC-NOT-EXIST/source-sync'],
  ['POST', '/corrections/RBAC-NOT-EXIST/confirm'],
  ['POST', '/corrections/RBAC-NOT-EXIST/reject'],
  ['POST', '/dispatch/orders'],
  ['POST', '/dispatch/orders/RBAC-NOT-EXIST/cancel'],
  ['POST', '/dispatch/orders/RBAC-NOT-EXIST/push'],
  ['POST', '/dispatch/orders/RBAC-NOT-EXIST/repush'],
  ['POST', '/dispatch/orders/RBAC-NOT-EXIST/archive'],
];

/**
 * 模式 B 的探测集（6 个端点，均在 /api/v1 私有前缀内）：
 * 它可能打**真实库**，而每一次 readonly 越权都会留一条 ACCESS_DENIED 审计，
 * 所以这里刻意压到最小集——3 读 + 2 写 + 1 管理面，够覆盖三档差异，
 * 又不像模式 A 那样把 40 条策略全 sweep 一遍。
 */
const LIVE_READ_PROBES = ['/complaints?page=1&size=5', '/dashboard/overview', '/dispatch/orders?page=1&size=5'];
const LIVE_WRITE_PROBES = [
  ['POST', '/complaints/RBAC-NOT-EXIST/assignment'],
  ['POST', '/dispatch/orders'],
];

/** 三档共同断言：读全放、只读写全拦、业务角色过 RBAC 进业务层 */
async function assertMatrix(base, tokens, lines, probes) {
  const readProbes = probes?.read ?? READ_PROBES;
  const writeProbes = probes?.write ?? WRITE_PROBES;
  let pass = true;
  for (const role of ['admin', 'handler', 'readonly']) {
    for (const path of readProbes) {
      const res = await call('GET', path, { token: tokens[role], base });
      const ok = res.status === 200;
      if (!ok) pass = false;
      lines.push(sub() + role + ' GET ' + path + ' -> ' + res.status +
        (ok ? '（放行：三档皆读）' : '（期望 200）'));
    }
  }
  for (const [method, path] of writeProbes) {
    for (const role of ['admin', 'handler', 'readonly']) {
      const res = await call(method, path, { token: tokens[role], base, body: {} });
      if (role === 'readonly') {
        const ok = res.status === 403;
        if (!ok) pass = false;
        lines.push(sub() + 'readonly ' + method + ' ' + path + ' -> ' + res.status +
          (ok ? '（403：只读档写不了）' : '（期望 403）'));
      } else {
        // 放行到业务层：业务键不存在时是 400/404/409/502，但**绝不能**是 401/403
        const ok = res.status !== 401 && res.status !== 403;
        if (!ok) pass = false;
        lines.push(sub() + role + ' ' + method + ' ' + path + ' -> ' + res.status +
          (ok ? '（已过 RBAC，进业务层）' : '（被 RBAC 误拦）'));
      }
    }
  }
  return pass;
}

/* ---------------- 模式 B：对已在跑的实例做抽查矩阵 ---------------- */

async function runLive(base) {
  const handlerPassword = process.env.GQXQ_TEST_HANDLER_PASSWORD || '';
  const readonlyPassword = process.env.GQXQ_TEST_READONLY_PASSWORD || '';
  if (ADMIN_PASSWORD === '' || handlerPassword === '' || readonlyPassword === '') {
    console.error('[verify-rbac] 中止：--live 需要三个口令（admin 取 GQXQ_BOOTSTRAP_ADMIN_PASSWORD，' +
      '测试账号取 GQXQ_TEST_HANDLER_PASSWORD / GQXQ_TEST_READONLY_PASSWORD）。');
    return 2;
  }
  const preLines = [];
  if (PROVISION) {
    const a = await ensureAccount(HANDLER_USERNAME, 'handler', handlerPassword);
    const b = await ensureAccount(READONLY_USERNAME, 'readonly', readonlyPassword);
    preLines.push(sub() + '已在 ' + TARGET_DB + ' 校验/重建测试账号：' +
      HANDLER_USERNAME + '(' + a.userId + ',' + (a.created ? '新建' : '已存在') + ') / ' +
      READONLY_USERNAME + '(' + b.userId + ',' + (b.created ? '新建' : '已存在') + ')');
  } else {
    preLines.push(sub() + '未给 --provision：本模式不建号，要求 ' +
      HANDLER_USERNAME + ' / ' + READONLY_USERNAME + ' 已在 ' + TARGET_DB + ' 就位');
  }

  const tokens = {};
  const cred = {
    admin: [ADMIN_USERNAME, ADMIN_PASSWORD],
    handler: [HANDLER_USERNAME, handlerPassword],
    readonly: [READONLY_USERNAME, readonlyPassword],
  };
  for (const role of ['admin', 'handler', 'readonly']) {
    const [username, password] = cred[role];
    const login = await loginToken(base, username, password);
    if (login.token === null) {
      preLines.push(sub() + username + '(' + role + ') 登录 HTTP ' + login.status +
        ' message=' + JSON.stringify(login.json?.message ?? ''));
      check(false, preLines, 'RBAC-L0', '三档账号登录取令牌');
      return 1;
    }
    tokens[role] = login.token;
    preLines.push(sub() + username + '(' + role + ') 登录 200，roles=' +
      JSON.stringify(login.json?.data?.userInfo?.roles ?? null) + '（前端菜单据此过滤）');
  }
  emit('RBAC-L0', '三档账号登录取令牌（登录响应带 role）', 'PASS', preLines);

  const mLines = [];
  check(await assertMatrix(base, tokens, mLines, { read: LIVE_READ_PROBES, write: LIVE_WRITE_PROBES }),
    mLines, 'RBAC-L1', '三角色 × 6 个代表端点矩阵（读全放 / 只读写全拦）');

  const uLines = [];
  const adminList = await call('GET', '/users?page=1&size=5', { token: tokens.admin, base });
  uLines.push(sub() + 'admin GET /users -> ' + adminList.status + '，total=' + String(adminList.json?.data?.total ?? '?'));
  const handlerList = await call('GET', '/users', { token: tokens.handler, base });
  uLines.push(sub() + 'handler GET /users -> ' + handlerList.status + '（期望 403）message=' +
    JSON.stringify(handlerList.json?.message ?? ''));
  const roList = await call('GET', '/users', { token: tokens.readonly, base });
  uLines.push(sub() + 'readonly GET /users -> ' + roList.status + '（期望 403）');
  const roPost = await call('POST', '/users', {
    token: tokens.readonly, base,
    body: { username: 'should_not_exist', realName: '不该存在', role: 'admin', password: PROBE_PASSWORD },
  });
  uLines.push(sub() + 'readonly POST /users -> ' + roPost.status + '（期望 403）');
  const ghost = await rows('select user_id from app_user where username = ?', ['should_not_exist']);
  uLines.push(sub() + '库里 username=should_not_exist 行数 = ' + ghost.length + '（期望 0：403 没写库）');
  check(adminList.status === 200 && handlerList.status === 403 && roList.status === 403 &&
    roPost.status === 403 && ghost.length === 0 && handlerList.json?.message === FORBIDDEN_MESSAGE,
    uLines, 'RBAC-L2', '/users 仅 admin 可用');

  const aLines = [];
  const noToken = await call('GET', '/complaints', { base });
  const badToken = await call('GET', '/complaints', { token: 'not-a-jwt', base });
  const health = await call('GET', '/health', { base });
  aLines.push(sub() + '无 token -> ' + noToken.status + '；坏 token -> ' + badToken.status + '（都期望 401）；' +
    'GET /health 无 token -> ' + health.status + '（公开探针不受 RBAC 影响）');
  const deniedAudit = await rows(
    "select user_id, action from operation_audit_log where action = 'ACCESS_DENIED' order by id desc limit 1"
  );
  aLines.push(sub() + '最近一条 ACCESS_DENIED 的 user_id = ' + String(deniedAudit[0]?.user_id ?? '(无)') +
    '（403 也要落到人）');
  check(noToken.status === 401 && badToken.status === 401 && health.status === 200 && deniedAudit.length > 0,
    aLines, 'RBAC-L3', '401 与 403 语义分开，403 留痕');

  const tLines = [];
  const ids = {};
  for (const [role, username] of [['admin', ADMIN_USERNAME], ['handler', HANDLER_USERNAME], ['readonly', READONLY_USERNAME]]) {
    const r = await rows('select user_id from app_user where username = ?', [username]);
    ids[role] = String(r[0]?.user_id ?? '');
    tLines.push(sub() + role + ' user_id = ' + (ids[role] || '(库里无此账号)') + '（' + username + '）');
  }
  // 模式 B 不写业务数据（真实库），所以这里只回读 L1/L2 已经产生的留痕；
  // "业务写审计到人"的完整断言在模式 A 的 RBAC-05/RBAC-07。
  const since = await rows(
    "select action, user_id, biz_id from operation_audit_log " +
      "where action in ('ACCESS_DENIED', 'LOGIN') and created_at >= date_sub(now(), interval 5 minute) order by id desc limit 60"
  );
  const denied = since.filter((r) => r.action === 'ACCESS_DENIED');
  const logins = since.filter((r) => r.action === 'LOGIN');
  const deniedAttributed = denied.length > 0 &&
    denied.every((r) => String(r.user_id) === ids.handler || String(r.user_id) === ids.readonly);
  tLines.push(sub() + '近 5 分钟 ACCESS_DENIED ' + denied.length + ' 条，user_id 全是被拦的 handler/readonly 本人 = ' +
    (deniedAttributed ? '是' : '否') + '（admin 名下 0 条：' +
    denied.filter((r) => String(r.user_id) === ids.admin).length + ' 条）');
  const loginOk = ['admin', 'handler', 'readonly'].every((role) =>
    logins.some((r) => String(r.user_id) === ids[role]));
  tLines.push(sub() + '近 5 分钟 LOGIN ' + logins.length + ' 条，覆盖三档各自的 user_id = ' + (loginOk ? '是' : '否'));
  check(denied.length > 0 && deniedAttributed && loginOk,
    tLines, 'RBAC-L4', '审计到真实操作人（只回读留痕，模式 B 不写业务数据）');

  const gLines = [];
  const adminRow = await rows('select user_id from app_user where username = ?', [ADMIN_USERNAME]);
  const adminId = String(adminRow[0]?.user_id ?? '');
  const adminCount = await scalar(
    "select count(*) as n from app_user where status = 1 and json_contains(roles, json_quote('admin'))"
  );
  gLines.push(sub() + TARGET_DB + ' 启用中的 admin = ' + adminCount + ' 个');
  if (adminCount === 1) {
    const selfDisable = await call('PATCH', '/users/' + adminId, { token: tokens.admin, base, body: { status: 0 } });
    const after = await rows('select status from app_user where user_id = ?', [adminId]);
    gLines.push(sub() + '唯一 admin 自禁 -> ' + selfDisable.status + '（期望 409）' +
      JSON.stringify(selfDisable.json?.message ?? '') + '；库里 status=' + String(after[0]?.status ?? '?') + '（期望 1）');
    check(selfDisable.status === 409 && Number(after[0]?.status) === 1, gLines, 'RBAC-L5', '最后一个 admin 不可自禁');
  } else {
    gLines.push(sub() + '本项前提（唯一 admin）不成立，按 SKIP 记：断言留给人工或测试库全量模式');
    emit('RBAC-L5', '最后一个 admin 不可自禁', 'SKIP', gLines);
  }
  return 0;
}

/* ---------------- 模式 A：一次性实例 + 测试库，完整断言 ---------------- */

async function runIsolated() {
  const lines = [];
  if (ADMIN_PASSWORD === '') {
    console.error('[verify-rbac] 中止：GQXQ_BOOTSTRAP_ADMIN_PASSWORD 为空，测试库里没有可登录的 admin。');
    return 2;
  }

  /* RBAC-01 三档登录 */
  const ephemeral = {};
  for (const [role, envName] of [['handler', 'GQXQ_TEST_HANDLER_PASSWORD'], ['readonly', 'GQXQ_TEST_READONLY_PASSWORD']]) {
    const fromEnv = process.env[envName] || '';
    ephemeral[role] = fromEnv === '' ? randomBytes(12).toString('base64url') : fromEnv;
    lines.push(sub() + role + ' 测试账号口令来源 = ' + (fromEnv === '' ? '本次随机（不回显、不落盘）' : '环境变量'));
  }
  const accHandler = await ensureAccount(HANDLER_USERNAME, 'handler', ephemeral.handler);
  const accReadonly = await ensureAccount(READONLY_USERNAME, 'readonly', ephemeral.readonly);
  lines.push(sub() + '测试账号就位（批次结束保留）：' + HANDLER_USERNAME + '=' + accHandler.userId + '（' +
    (accHandler.created ? '新建' : '已存在，角色/状态已复位') + '），' + READONLY_USERNAME + '=' + accReadonly.userId +
    '（' + (accReadonly.created ? '新建' : '已存在，角色/状态已复位') + '）');

  const logins = {
    admin: await loginToken(null, ADMIN_USERNAME, ADMIN_PASSWORD),
    handler: await loginToken(null, HANDLER_USERNAME, ephemeral.handler),
    readonly: await loginToken(null, READONLY_USERNAME, ephemeral.readonly),
  };
  const tokens = { admin: logins.admin.token, handler: logins.handler.token, readonly: logins.readonly.token };
  lines.push(sub() + '登录 HTTP = admin/' + logins.admin.status + ' handler/' + logins.handler.status +
    ' readonly/' + logins.readonly.status);
  for (const role of ['admin', 'handler', 'readonly']) {
    lines.push(sub() + role + ' 登录响应 userInfo.roles = ' +
      JSON.stringify(logins[role].json?.data?.userInfo?.roles ?? null));
  }
  check(tokens.admin !== null && tokens.handler !== null && tokens.readonly !== null, lines, 'RBAC-01', '三档账号登录并取令牌');
  if (tokens.admin === null || tokens.handler === null || tokens.readonly === null) return 1;

  const adminId = String((await rows('select user_id from app_user where username = ?', [ADMIN_USERNAME]))[0]?.user_id ?? '');
  const handlerId = accHandler.userId;
  const readonlyId = accReadonly.userId;

  /* RBAC-02 策略表 ↔ 文档一致 + 默认拒绝（纯代码判定，不依赖 HTTP） */
  const pLines = [];
  const policy = await loadPolicy();
  const { ids, pids } = docEndpointIds();
  pLines.push(sub() + 'ROLE_POLICY 条目 = ' + policy.ROLE_POLICY.length +
    '；文档 S/R/W/U/X 端点行 = ' + ids.length + '；P 段（不走 role）= ' + pids.length);
  const dupIds = ids.length !== new Set(ids).size;
  pLines.push(sub() + '文档编号重复 = ' + (dupIds ? '有（FAIL）' : '无'));
  const undeclaredHandler = policy.isAllowed({ id: 'X', username: 'x', roles: ['handler'] }, 'POST', '/brand-new-endpoint');
  const undeclaredReadonly = policy.isAllowed({ id: 'Y', username: 'y', roles: ['readonly'] }, 'GET', '/brand-new-read');
  const undeclaredAdmin = policy.isAllowed({ id: 'Z', username: 'z', roles: ['admin'] }, 'POST', '/brand-new-endpoint');
  pLines.push(sub() + '未声明端点 + handler -> ' + undeclaredHandler.allowed + '（期望 false）依据「' + undeclaredHandler.reason + '」');
  pLines.push(sub() + '未声明端点 + readonly -> ' + undeclaredReadonly.allowed + '（期望 false）');
  pLines.push(sub() + '未声明端点 + admin -> ' + undeclaredAdmin.allowed + '（期望 true，admin 是全量档）');
  const readonlySlip = policy.isAllowed({ id: 'R', username: 'r', roles: ['readonly'] }, 'POST', '/complaints');
  const tableHasReadonlyWrite = policy.ROLE_POLICY.some((r) => r.method !== 'GET' && r.roles.includes('readonly'));
  pLines.push(sub() + 'readonly 打 POST /complaints -> ' + readonlySlip.allowed + '（硬不变量：即使表格误写也放不开）；' +
    '表里存在"非 GET 放行 readonly"的行 = ' + (tableHasReadonlyWrite ? '有（FAIL）' : '无'));
  const roleSetOk = policy.ROLES.length === 3 && policy.isRole('handler') && !policy.isRole('superuser');
  pLines.push(sub() + '角色集合 = ' + JSON.stringify(policy.ROLES) + '，isRole 校验 superuser = ' + !policy.isRole('superuser'));
  check(policy.ROLE_POLICY.length === ids.length && pids.length === 4 && !dupIds &&
    undeclaredHandler.allowed === false && undeclaredReadonly.allowed === false && undeclaredAdmin.allowed === true &&
    readonlySlip.allowed === false && !tableHasReadonlyWrite && roleSetOk,
    pLines, 'RBAC-02', '策略表与映射文档逐条一致 + 默认拒绝 + readonly 硬不变量');

  /* RBAC-03 三档 × 代表端点矩阵 */
  const mLines = [];
  check(await assertMatrix(null, tokens, mLines), mLines, 'RBAC-03', '三档 × 读/业务写代表端点矩阵');

  /* RBAC-04 readonly 对策略表内**每一条**写端点 403，且零副作用 */
  const wLines = [];
  const beforeItems = await scalar('select count(*) as n from correction_item');
  const writeRules = policy.ROLE_POLICY.filter((r) => r.method !== 'GET');
  let notForbidden = 0;
  for (const rule of writeRules) {
    const path = rulePath(rule);
    const res = await call(rule.method, path, { token: tokens.readonly, body: {} });
    if (res.status !== 403) {
      notForbidden++;
      wLines.push(sub() + 'readonly ' + rule.method + ' ' + path + ' -> ' + res.status + '（期望 403）' + rule.desc);
    }
  }
  const afterItems = await scalar('select count(*) as n from correction_item');
  wLines.push(sub() + '逐条探测 ' + writeRules.length + ' 条写端点，非 403 的 = ' + notForbidden);
  wLines.push(sub() + 'correction_item 行数 前=' + beforeItems + ' 后=' + afterItems + '（403 必须零写入）');
  check(notForbidden === 0 && beforeItems === afterItems, wLines, 'RBAC-04', 'readonly 任何 POST/PATCH 一律 403 且无副作用');

  /* RBAC-05 业务写审计到人：经办做一次真实生成 */
  const hLines = [];
  const sourceId = 'ACCRBAC' + Date.now();
  const intake = await call('POST', '/external/yijiejieban/appeal', {
    body: {
      sourceId,
      title: 'RBAC 验收探针诉求',
      content: 'verify-rbac.mjs 生成，用于断言业务写审计落到真实操作人。',
      address: '西陵区沿江大道188号',
      districtName: '西陵区',
      source: '12345热线',
    },
  });
  const complaintId = String(intake.json?.data?.complaintId ?? '');
  hLines.push(sub() + '入站造一条新诉求 -> HTTP ' + intake.status + '，complaintId=' + (complaintId || '(无)') +
    '（入站是机器通道，本批未加 Bearer/role）');
  const genHandler = await call('POST', '/complaints/' + complaintId + '/corrections/generate', { token: tokens.handler });
  hLines.push(sub() + 'handler POST /complaints/:id/corrections/generate -> ' + genHandler.status +
    '，created=' + String(genHandler.json?.data?.created ?? '?') + '，items=' +
    String((genHandler.json?.data?.items ?? []).length));
  const genReadonly = await call('POST', '/complaints/' + complaintId + '/corrections/generate', { token: tokens.readonly });
  hLines.push(sub() + 'readonly 同一请求 -> ' + genReadonly.status + '（期望 403）');
  const audit = await rows(
    'select user_id, action from operation_audit_log where biz_type = ? and biz_id = ? order by id desc limit 10',
    ['complaint', complaintId]
  );
  const humanAudits = audit.filter((r) => r.user_id !== null);
  const allHandler = humanAudits.length > 0 && humanAudits.every((r) => String(r.user_id) === handlerId);
  const machineAudits = audit.filter((r) => r.user_id === null);
  const intakeUnattributed = machineAudits.length > 0 &&
    machineAudits.every((r) => r.action === 'INTAKE_CREATE');
  hLines.push(sub() + '该诉求审计 ' + audit.length + ' 条：平台操作 ' + humanAudits.length +
    ' 条 user_id 全是 handler 本人 = ' + (allHandler ? '是' : '否') +
    '（' + humanAudits.map((r) => r.action + '@' + r.user_id).join(', ') + '）');
  hLines.push(sub() + '机器通道（P3 入站）写的 ' + machineAudits.length +
    ' 条保持无主 user_id=null = ' + (intakeUnattributed ? '是（对：入站不发账号，见映射表 §2 P3）' : '否（FAIL：' +
      machineAudits.map((r) => r.action).join(',') + '）'));
  createdComplaints.push({ sourceId, complaintId });
  check(intake.status === 200 && complaintId !== '' && genHandler.status === 200 &&
    genReadonly.status === 403 && allHandler && intakeUnattributed,
    hLines, 'RBAC-05', '业务写审计到人（经办做的记在经办名下，机器写的仍是无主）');

  /* RBAC-06 /users 摘 501 → admin 独占真 CRUD */
  const uLines = [];
  const list = await call('GET', '/users?page=1&size=50', { token: tokens.admin });
  const content = list.json?.data?.content ?? [];
  const listOk = list.status === 200 && Array.isArray(content) && typeof list.json?.data?.total === 'number';
  uLines.push(sub() + 'admin GET /users -> ' + list.status + '，total=' + String(list.json?.data?.total ?? '?') +
    '，page/size=' + String(list.json?.data?.page ?? '?') + '/' + String(list.json?.data?.size ?? '?') +
    '，本页 ' + content.length + ' 条');
  const listJson = JSON.stringify(list.json ?? {});
  const leaked = /password|passwordHash|\$2[aby]\$/.test(listJson);
  uLines.push(sub() + '列表响应出现 password 字段或 bcrypt 哈希 = ' + (leaked ? '是（FAIL）' : '否'));
  const roFilter = await call('GET', '/users?role=readonly&size=50', { token: tokens.admin });
  const roOnly = (roFilter.json?.data?.content ?? []).every((u) => u.roles.length === 1 && u.roles[0] === 'readonly');
  uLines.push(sub() + '按 role=readonly 筛 -> ' + roFilter.status + '，' +
    (roFilter.json?.data?.content ?? []).length + ' 条且全是 readonly = ' + (roOnly ? '是' : '否'));
  const kwFilter = await call('GET', '/users?keyword=' + encodeURIComponent(READONLY_USERNAME), { token: tokens.admin });
  const kwHit = (kwFilter.json?.data?.content ?? []).some((u) => u.username === READONLY_USERNAME);
  uLines.push(sub() + '按 keyword 筛命中测试只读账号 = ' + (kwHit ? '是' : '否') +
    '，roleNames=' + JSON.stringify((kwFilter.json?.data?.content ?? [])[0]?.roleNames ?? null));
  const stFilter = await call('GET', '/users?status=0', { token: tokens.admin });
  const stOk = stFilter.status === 200 && (stFilter.json?.data?.content ?? []).every((u) => u.status === 0);
  uLines.push(sub() + '按 status=0 筛 -> ' + stFilter.status + '，命中全是禁用账号 = ' + (stOk ? '是' : '否'));
  const created = await call('POST', '/users', {
    token: tokens.admin,
    body: { username: PROBE_USER_1, realName: '验收探针账号', role: 'handler', password: PROBE_PASSWORD },
  });
  const createdData = created.json?.data ?? {};
  const probeId = String(createdData.userId ?? '');
  createdUsers.push(probeId);
  uLines.push(sub() + 'admin POST /users -> ' + created.status + '，userId=' + (probeId || '(无)') +
    '，roles=' + JSON.stringify(createdData.roles ?? null) + '，status=' + String(createdData.status ?? '?'));
  const patched = await call('PATCH', '/users/' + probeId, {
    token: tokens.admin, body: { realName: '验收探针账号-改名', role: 'readonly' },
  });
  uLines.push(sub() + 'admin PATCH（改名+改角色）-> ' + patched.status + '，changed=' +
    JSON.stringify(patched.json?.data?.changed ?? null));
  const hashRow = await rows('select password_hash from app_user where user_id = ?', [probeId]);
  const isBcrypt = String(hashRow[0]?.password_hash ?? '').startsWith('$2');
  uLines.push(sub() + '库里 password_hash 是 bcrypt 前缀 = ' + (isBcrypt ? '是' : '否') + '（明文口令未落库）');
  const echoPw = JSON.stringify(patched.json ?? {}).includes(PROBE_PASSWORD);
  uLines.push(sub() + '响应回显明文口令 = ' + (echoPw ? '是（FAIL）' : '否'));
  check(listOk && !leaked && roOnly && kwHit && stOk && created.status === 200 && patched.status === 200 &&
    isBcrypt && !echoPw && created.status === 200 && createdData.status === 1,
    uLines, 'RBAC-06', '/users 摘 501 → admin 独占真 CRUD（分页/筛选/建号/改号）');

  /* RBAC-07 非 admin 打 /users 全 403，越权尝试也审计到人 */
  const dLines = [];
  const deniedHandler = await call('GET', '/users', { token: tokens.handler });
  const deniedRoPost = await call('POST', '/users', {
    token: tokens.readonly,
    body: { username: 'should_not_exist', realName: '不该存在', role: 'admin', password: PROBE_PASSWORD },
  });
  const deniedPatch = await call('PATCH', '/users/' + probeId, { token: tokens.handler, body: { status: 0 } });
  dLines.push(sub() + 'handler GET /users -> ' + deniedHandler.status + '；readonly POST /users -> ' +
    deniedRoPost.status + '；handler PATCH /users -> ' + deniedPatch.status + '（都期望 403）');
  dLines.push(sub() + '403 响应体 code=' + String(deniedHandler.json?.code ?? '?') + ' message=' +
    JSON.stringify(deniedHandler.json?.message ?? '') + '（与 401 文案不同，前端据此不跳登录页）');
  const ghost = await rows('select user_id from app_user where username = ?', ['should_not_exist']);
  dLines.push(sub() + '被拦的建号是否落了库 = ' + (ghost.length === 0 ? '否（对）' : '是（FAIL）'));
  const probeUnchanged = await rows('select status from app_user where user_id = ?', [probeId]);
  dLines.push(sub() + '探针账号 status 仍 = ' + String(probeUnchanged[0]?.status ?? '?') + '（handler 的 PATCH 没生效）');
  const deniedAudit = await rows(
    "select user_id, action from operation_audit_log where action = 'ACCESS_DENIED' and user_id in (?, ?) order by id desc limit 10",
    [handlerId, readonlyId]
  );
  dLines.push(sub() + 'ACCESS_DENIED 审计（handler/readonly 名下）= ' + deniedAudit.length + ' 条，动作名=' +
    JSON.stringify(deniedAudit[0]?.action ?? null));
  check(deniedHandler.status === 403 && deniedRoPost.status === 403 && deniedPatch.status === 403 &&
    deniedHandler.json?.message === FORBIDDEN_MESSAGE && ghost.length === 0 &&
    Number(probeUnchanged[0]?.status) === 1 && deniedAudit.length > 0,
    dLines, 'RBAC-07', '用户管理仅 admin：越权 403 且零副作用，越权尝试也落到人');

  /* RBAC-08 建号防呆：撞库 409、契约上限 400、无删除端点 */
  const cLines = [];
  const dup = await call('POST', '/users', {
    token: tokens.admin,
    body: { username: PROBE_USER_1, realName: '撞库', role: 'handler', password: PROBE_PASSWORD },
  });
  cLines.push(sub() + '重复 username 建号 -> ' + dup.status + '（期望 409）' + JSON.stringify(dup.json?.message ?? ''));
  const tooLong = await call('POST', '/users', {
    token: tokens.admin,
    body: { username: 'u'.repeat(65), realName: 'x', role: 'handler', password: PROBE_PASSWORD },
  });
  cLines.push(sub() + 'username 65 字符 -> ' + tooLong.status + '（期望 400，列宽 varchar(64)）');
  const weakPw = await call('POST', '/users', {
    token: tokens.admin, body: { username: PROBE_USER_2, realName: 'x', role: 'handler', password: 'short' },
  });
  cLines.push(sub() + '口令 5 字符 -> ' + weakPw.status + '（期望 400）');
  const badRole = await call('POST', '/users', {
    token: tokens.admin, body: { username: PROBE_USER_3, realName: 'x', role: 'superuser', password: PROBE_PASSWORD },
  });
  cLines.push(sub() + 'role=superuser -> ' + badRole.status + '（期望 400：三档之外没有第四档）');
  const badPage = await call('GET', '/users?page=0', { token: tokens.admin });
  cLines.push(sub() + 'page=0 -> ' + badPage.status + '（期望 400）');
  const del = await call('DELETE', '/users/' + probeId, { token: tokens.admin });
  cLines.push(sub() + 'DELETE /users/:id -> ' + del.status + '（期望 404：不提供删除，禁用代替）');
  const stillRow = await rows('select user_id from app_user where user_id = ?', [probeId]);
  cLines.push(sub() + '探针账号仍在库里 = ' + (stillRow.length === 1 ? '是（对）' : '否（FAIL）'));
  const ghost2 = await rows("select user_id from app_user where username in (?, ?)", [PROBE_USER_2, PROBE_USER_3]);
  cLines.push(sub() + '被 400 拒掉的建号落了库 = ' + ghost2.length + ' 行（期望 0）');
  check(dup.status === 409 && tooLong.status === 400 && weakPw.status === 400 && badRole.status === 400 &&
    badPage.status === 400 && del.status === 404 && stillRow.length === 1 && ghost2.length === 0,
    cLines, 'RBAC-08', '建号防呆：撞库 409 / 契约上限 400 / 无删除端点');

  /* RBAC-09 禁用/降级立即回收（含**已签发老令牌**），且可逆 */
  const sLines = [];
  /**
   * 先升成 handler 再取令牌，然后断言"治理动作对**已签发老令牌**立即生效"。
   * 这一条是本轮收尾补的：令牌载荷里带着 roles 声明（TTL 8 小时），
   * 如果鉴权只解 JWT 不回库，被禁用/降级的人在令牌过期前仍是原来的档 ——
   * "最后一个 admin 防呆""禁用代替删除"这类治理动作会被悄悄架空。
   */
  const upgrade = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { role: 'handler' } });
  const stale = await loginToken(null, PROBE_USER_1, PROBE_PASSWORD);
  const staleToken = stale.token;
  const staleAsHandler = staleToken === null ? 0 :
    (await call('POST', '/dispatch/orders', { token: staleToken, body: {} })).status;
  sLines.push(sub() + '先 PATCH 升为 handler -> ' + upgrade.status + '，登录取老令牌（roles=' +
    JSON.stringify(stale.json?.data?.userInfo?.roles ?? null) + '，HTTP ' + stale.status + '），' +
    '老令牌 POST /dispatch/orders -> ' + staleAsHandler +
    '（期望 400：已过 RBAC 进业务层被契约拦下，零业务写入。后续全用这一枚，不再重新登录）');

  const disable = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { status: 0 } });
  const disabledStatus = await scalar('select status as n from app_user where user_id = ?', [probeId]);
  sLines.push(sub() + 'admin PATCH status=0 -> ' + disable.status + '，库里 status=' + disabledStatus);
  const staleAfterDisable = staleToken === null ? 0 :
    (await call('GET', '/auth/user-info', { token: staleToken })).status;
  const staleBusinessAfterDisable = staleToken === null ? 0 :
    (await call('GET', '/complaints?page=1&size=1', { token: staleToken })).status;
  sLines.push(sub() + '**禁用前签发的老令牌**再打 GET /auth/user-info -> ' + staleAfterDisable + '，' +
    'GET /complaints -> ' + staleBusinessAfterDisable +
    '（都期望 401：禁用必须立刻回收会话，而不是等 8 小时自然过期。' +
    '业务读接口只经过 requireAuth，它比自查询接口更能暴露"只解令牌不回库"的窗口）');
  const loginDisabled = await loginToken(null, PROBE_USER_1, PROBE_PASSWORD);
  sLines.push(sub() + '被禁账号再登录 -> ' + loginDisabled.status + '（期望 401：沿用"不区分原因"的登录口径）');
  const reEnable = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { status: 1 } });
  const loginAgain = await loginToken(null, PROBE_USER_1, PROBE_PASSWORD);
  const staleAfterEnable = staleToken === null ? 0 :
    (await call('GET', '/auth/user-info', { token: staleToken })).status;
  sLines.push(sub() + '解禁 -> ' + reEnable.status + '，再登录 -> ' + loginAgain.status +
    '（期望 200：禁用是可逆运营动作）；同一枚老令牌 -> ' + staleAfterEnable +
    '（期望 200：证明刚才拦的是"当前 status"，不是把令牌整个作废）');

  const downgrade = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { role: 'readonly' } });
  const staleAsReadonly = staleToken === null ? 0 :
    (await call('POST', '/dispatch/orders', { token: staleToken, body: {} })).status;
  sLines.push(sub() + 'admin 再降回 readonly -> ' + downgrade.status + '，同一枚老令牌 POST /dispatch/orders -> ' +
    staleAsReadonly + '（期望 403：**降级必须立即生效**，老令牌不得继续带着 handler 的角色）');

  const noop = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { status: 1 } });
  sLines.push(sub() + '重复提交同一状态 -> ' + noop.status + '，changed=' +
    JSON.stringify(noop.json?.data?.changed ?? null) + '（无变化不写审计，避免噪声）');
  check(disable.status === 200 && disabledStatus === 0 && loginDisabled.status === 401 &&
    reEnable.status === 200 && loginAgain.status === 200 && Array.isArray(noop.json?.data?.changed) &&
    noop.json?.data?.changed.length === 0 &&
    upgrade.status === 200 && staleToken !== null && staleAsHandler === 400 &&
    staleAfterDisable === 401 && staleBusinessAfterDisable === 401 && staleAfterEnable === 200 &&
    downgrade.status === 200 && staleAsReadonly === 403,
    sLines, 'RBAC-09', '禁用/降级立即回收老令牌，且整个动作可逆');

  /* RBAC-10 最后一个 admin 防呆 + 用户管理自身审计 */
  const gLines = [];
  const adminCount = await scalar(
    "select count(*) as n from app_user where status = 1 and json_contains(roles, json_quote('admin'))"
  );
  gLines.push(sub() + TARGET_DB + ' 启用中的 admin = ' + adminCount + ' 个（前提：恰好 1 个）');
  const selfDisable = await call('PATCH', '/users/' + adminId, { token: tokens.admin, body: { status: 0 } });
  const selfDemote = await call('PATCH', '/users/' + adminId, { token: tokens.admin, body: { role: 'handler' } });
  gLines.push(sub() + '唯一 admin 自禁 -> ' + selfDisable.status + '（期望 409）' + JSON.stringify(selfDisable.json?.message ?? ''));
  gLines.push(sub() + '唯一 admin 自降 -> ' + selfDemote.status + '（期望 409）' + JSON.stringify(selfDemote.json?.message ?? ''));
  const adminStill = await rows('select status, roles from app_user where user_id = ?', [adminId]);
  gLines.push(sub() + '库里该 admin status=' + String(adminStill[0]?.status ?? '?') + ' roles=' +
    JSON.stringify(adminStill[0]?.roles ?? null) + '（绝不能被改成 0 / handler）');
  const otherAdminSafe = await call('PATCH', '/users/' + probeId, { token: tokens.admin, body: { role: 'handler' } });
  gLines.push(sub() + '对照：改非 admin 账号的角色 -> ' + otherAdminSafe.status + '（期望 200，防呆没误伤普通改号）');
  const userAudit = await rows(
    "select user_id, action from operation_audit_log where action in ('USER_CREATE','USER_UPDATE') order by id desc limit 20"
  );
  const allByAdmin = userAudit.length > 0 && userAudit.every((r) => String(r.user_id) === adminId);
  gLines.push(sub() + 'USER_CREATE/USER_UPDATE 审计 ' + userAudit.length + ' 条，操作人全部是 admin 本人 = ' +
    (allByAdmin ? '是' : '否'));
  const auditDetail = await rows(
    "select detail from operation_audit_log where action in ('USER_CREATE','USER_UPDATE') order by id desc limit 20"
  );
  const auditLeak = auditDetail.some((r) => new RegExp(PROBE_PASSWORD + '|password_hash|\\$2[aby]\\$').test(String(r.detail ?? '')));
  gLines.push(sub() + '审计明细里出现口令/哈希 = ' + (auditLeak ? '是（FAIL）' : '否'));
  check(adminCount === 1 && selfDisable.status === 409 && selfDemote.status === 409 &&
    Number(adminStill[0]?.status) === 1 && JSON.stringify(adminStill[0]?.roles) === '["admin"]' &&
    otherAdminSafe.status === 200 && allByAdmin && !auditLeak,
    gLines, 'RBAC-10', '最后一个 admin 不可自禁/自降 + 用户管理审计到人且不泄口令');

  /* RBAC-11 401 语义（缺/坏令牌），公开端点不变 */
  const aLines = [];
  const noTok = await call('GET', '/complaints');
  const badTok = await call('GET', '/complaints', { token: 'a.b.c' });
  const noTokUsers = await call('GET', '/users');
  aLines.push(sub() + '无 Bearer GET /complaints -> ' + noTok.status + '，坏令牌 -> ' + badTok.status +
    '（都期望 401）；无令牌 GET /users -> ' + noTokUsers.status + '（401 优先于 403：未认证者连"缺哪个角色"都不该知道）');
  aLines.push(sub() + '401 message = ' + JSON.stringify(noTok.json?.message ?? '') + '，code = ' +
    String(noTok.json?.code ?? '?'));
  const health = await call('GET', '/health');
  const emptyPw = await call('POST', '/auth/login', { body: { username: ADMIN_USERNAME, password: '' } });
  const wrongPw = await call('POST', '/auth/login', { body: { username: ADMIN_USERNAME, password: 'definitely-not-the-password-1' } });
  aLines.push(sub() + 'GET /health 无令牌 -> ' + health.status + '（公开）；空口令登录 -> ' + emptyPw.status +
    ' errorCode=' + String(emptyPw.json?.data?.errorCode ?? '?') + '（登录契约在认证之前，本批未动）；错口令登录 -> ' + wrongPw.status +
    '（期望 401：凭据层语义不变，401 永远来自"没认证上"而不是"角色不够"）');
  const denyAuditForAnonymous = await rows(
    "select count(*) as n from operation_audit_log where action = 'ACCESS_DENIED' and user_id is null"
  );
  aLines.push(sub() + '未认证请求产生的 ACCESS_DENIED 行数 = ' + Number(denyAuditForAnonymous[0]?.n ?? 0) +
    '（期望 0：401 不记成"某人越权"，避免污染到人判定）');
  check(noTok.status === 401 && badTok.status === 401 && noTokUsers.status === 401 &&
    health.status === 200 && emptyPw.status === 400 &&
    emptyPw.json?.data?.errorCode === 'VALIDATION_FAILED' &&
    wrongPw.status === 401 && Number(denyAuditForAnonymous[0]?.n ?? 0) === 0,
    aLines, 'RBAC-11', '401/403 分开，公开端点与登录语义不变');

  /* RBAC-12 机器对机器端点未被 RBAC 波及；501 语义不被 403 掩盖 */
  const xLines = [];
  const appeal = await call('POST', '/external/yijiejieban/appeal', { body: { title: '缺字段的探针报文' } });
  xLines.push(sub() + 'POST /external/yijiejieban/appeal（无 Bearer、故意缺字段）-> ' + appeal.status +
    '（期望 400：仍是载荷校验在拒绝，不是 401/403 ⇒ 它没进 RBAC）');
  const callback = await call('POST', '/external/public-utility/callback', { body: {} });
  const callbackNotBearer = !/缺少 Bearer 令牌/.test(callback.text);
  xLines.push(sub() + 'POST /external/public-utility/callback（无 Bearer、无签名）-> ' + callback.status +
    '，响应不是"缺少 Bearer 令牌" = ' + (callbackNotBearer ? '是（签名鉴权照旧）' : '否（FAIL：被 Bearer 闸拦了）'));
  const tianbaoHandler = await call('POST', '/external/tianbao/status-callback', { token: tokens.handler, body: {} });
  xLines.push(sub() + 'handler POST /external/tianbao/status-callback -> ' + tianbaoHandler.status +
    '（期望 403：X1 声明为 admin-only）');
  const tianbaoAdmin = await call('POST', '/external/tianbao/status-callback', { token: tokens.admin, body: {} });
  xLines.push(sub() + 'admin 同一请求 -> ' + tianbaoAdmin.status +
    '（期望 501：过 RBAC 后仍是"未实现"，批次状态没被权限语义掩盖）');
  check(appeal.status === 400 && callbackNotBearer && tianbaoHandler.status === 403 && tianbaoAdmin.status === 501,
    xLines, 'RBAC-12', '机器端点鉴权方式不变 + 501 语义未被 403 掩盖');

  return 0;
}

/* ---------------- 清理（只删本脚本造的探针数据；测试账号保留） ---------------- */

const createdUsers = [];
const createdComplaints = [];

async function cleanup() {
  const lines = [];
  const ph = (list) => list.map(() => '?').join(', ');
  const probeNames = [PROBE_USER_1, PROBE_USER_2, PROBE_USER_3, 'should_not_exist'];
  const probeIds = createdUsers.filter((x) => x !== '');
  if (probeIds.length > 0) {
    // 探针账号的审计先删净：USER_CREATE/USER_UPDATE（biz_type='user'）+
    // RBAC-09 用探针账号登录产生的 LOGIN/LOGIN_FAILED（user_id 侧）
    await db.execute(
      'delete from operation_audit_log where (biz_type = ? and biz_id in (' + ph(probeIds) + ')) or user_id in (' + ph(probeIds) + ')',
      ['user', ...probeIds, ...probeIds]
    );
    const [r] = await db.execute('delete from app_user where user_id in (' + ph(probeIds) + ')', probeIds);
    lines.push(sub() + '探针账号删除 affected=' + r.affectedRows + '（含其 USER_*/LOGIN* 审计）');
  }
  const sourceIds = createdComplaints.map((c) => c.sourceId).filter((s) => s !== '');
  const cIds = createdComplaints.map((c) => c.complaintId).filter((s) => s !== '');
  if (sourceIds.length > 0) {
    await db.execute('delete from complaint_source_log where source_system = ? and source_id in (' + ph(sourceIds) + ')', ['宜接就办', ...sourceIds]);
    await db.execute('delete from complaint where source_system = ? and source_id in (' + ph(sourceIds) + ')', ['宜接就办', ...sourceIds]);
  }
  if (cIds.length > 0) {
    await db.execute('delete from correction_item where complaint_id in (' + ph(cIds) + ')', cIds);
    await db.execute('delete from complaint_field_version where complaint_id in (' + ph(cIds) + ')', cIds);
    await db.execute('delete from sensitive_hit where complaint_id in (' + ph(cIds) + ')', cIds);
    await db.execute('delete from operation_audit_log where biz_type = ? and biz_id in (' + ph(cIds) + ')', ['complaint', ...cIds]);
    await db.execute('delete from operation_audit_log where biz_id in (' + ph(cIds) + ')', cIds);
  }
  // 归零核对：清单为空时直接记 0（中止的run不该因空 IN() 炸掉 finally）
  const checks = [
    ['app_user(探针)', async () => (probeNames.length === 0 ? 0 : await scalar('select count(*) as n from app_user where username in (' + ph(probeNames) + ')', probeNames))],
    ['app_user(探针账号审计孤行)', async () => (probeIds.length === 0 ? 0 : await scalar('select count(*) as n from operation_audit_log where user_id in (' + ph(probeIds) + ')', probeIds))],
    ['complaint(探针诉求)', async () => (sourceIds.length === 0 ? 0 : await scalar('select count(*) as n from complaint where source_system = ? and source_id in (' + ph(sourceIds) + ')', ['宜接就办', ...sourceIds]))],
    ['correction_item(探针)', async () => (cIds.length === 0 ? 0 : await scalar('select count(*) as n from correction_item where complaint_id in (' + ph(cIds) + ')', cIds))],
    ['admin 账号被禁用(应为 0：防呆没失手)', async () => scalar('select count(*) as n from app_user where username = ? and status <> 1', [ADMIN_USERNAME])],
  ];
  const leftovers = [];
  let leftoversFound = 0;
  for (const [label, run] of checks) {
    const n = await run();
    leftovers.push(label + '=' + n);
    if (n !== 0) leftoversFound++;
  }
  failed += leftoversFound;
  lines.push(sub() + '归零核对：' + leftovers.join('  '));
  const kept = await rows('select username, user_id, roles, status from app_user where username in (?, ?) order by username', [HANDLER_USERNAME, READONLY_USERNAME]);
  lines.push(sub() + '保留的测试账号：' + kept.map((r) => r.username + '(' + r.user_id + ',roles=' + JSON.stringify(r.roles) + ',status=' + r.status + ')').join('  '));
  emit('RBAC-13', '探针数据清理并断言归零（测试账号按计划保留）', leftoversFound === 0 ? 'PASS' : 'FAIL', lines);
}

/* ---------------- 主流程 ---------------- */

let instance = null;
let exitCode = 0;

async function main() {
  if (LIVE_BASE === null) {
    if (await portBusy(PORT)) {
      console.error('[verify-rbac] 中止：端口 ' + PORT + ' 已被占用，请释放后重跑。');
      return 2;
    }
    BASE = 'http://127.0.0.1:' + PORT + '/api/v1';
    console.log('[verify-rbac] 模式 A：一次性实例 ' + BASE + '  库 ' + TARGET_DB);
    instance = startInstance();
    const ready = await instance.waitReady();
    if (!ready.ready) {
      console.error('[verify-rbac] 实例未起来：' + JSON.stringify(ready.exit || { timeout: true }));
      console.error(String(ready.log).split(/\r?\n/).slice(-20).join('\n'));
      return 2;
    }
    return await runIsolated();
  }
  BASE = LIVE_BASE.replace(/\/+$/, '');
  console.log('[verify-rbac] 模式 B：打已在跑的实例 ' + BASE + '  库 ' + TARGET_DB +
    (PROVISION ? '（--provision：校验/重建测试账号）' : '（不建号，账号须已存在）'));
  return await runLive(BASE);
}

try {
  exitCode = await main();
} catch (err) {
  // 前置不满足或脚本自身缺陷：仍按 2 退出，但清理照跑（可能已经建了探针数据）
  console.error('[verify-rbac] 异常中止：' + (err && err.stack ? err.stack : String(err)));
  exitCode = 2;
} finally {
  if (LIVE_BASE === null) {
    try {
      await cleanup();
    } catch (err) {
      failed++;
      console.error('[verify-rbac] 清理阶段异常：' + (err && err.message ? err.message : String(err)));
    }
    if (instance !== null) await instance.stop();
  }
  await db.end().catch(() => {});
}

const count = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) count[r.status] = (count[r.status] || 0) + 1;
console.log('');
console.log('=== 汇总 ===');
console.log('PASS ' + count.PASS + ' / FAIL ' + count.FAIL + ' / SKIP ' + count.SKIP);
console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
const finalCode = exitCode === 2 ? 2 : failed > 0 || count.FAIL > 0 ? 1 : 0;
console.log('退出码: ' + finalCode + (finalCode === 1 ? '（存在 FAIL）' : finalCode === 2 ? '（前置不满足）' : '（无 FAIL）'));
process.exit(finalCode);
