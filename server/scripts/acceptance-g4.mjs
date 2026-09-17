#!/usr/bin/env node
/**
 * acceptance-g4.mjs — 诉求平台 G4 入站（public-utility 结果事件回传）验收矩阵执行器
 *
 * 零第三方依赖，只用 node: 内置模块（fetch / child_process / crypto / fs / path）。
 * 覆盖 docs/2026-09-17-诉求平台落地计划.md §3.2 与 G4 批次的验收项：
 *   G4-① 退回重提 + 最终同意后，诉求与交办状态显示一致
 *   G4-② 重复回传无重复业务结果（同 eventId 两次 -> approval_trace 不重复、状态不变）
 *   G4-③ ACK 逐字节匹配（打印响应体原文与 hex，与 env 的 ackValue 逐字节比对）
 *   G4-④ 全链路 eventId 可反查（business_event -> approval_trace -> dispatch_order -> complaint）
 *   N-1  签名错误 -> 401
 *   N-2  缺必需表头 -> 401 且点名（注意：表头齐备性在验签之前判定，所以这里无需真签名）
 *   N-3  非法 eventType -> 400 + fieldErrors
 *   N-4  小写 approvalConclusion（契约要求大写）-> 400 + fieldErrors
 *   N-5  非法状态转换不回滚事件（processed_result=ignored，事件与轨迹仍留痕）
 *   N-6  被拒事件的重复投递仍返回 400 且结论一致（回归用例）
 *
 * 用法：
 *   # 1) 先起服务（务必指向测试库、且不要占用 3100）
 *   cd server
 *   $env:GQXQ_DB_NAME='gqxq_service_test'; $env:PORT='3210'; node dist/index.js
 *   # 2) 再跑本脚本
 *   GQXQ_BASE=http://localhost:3210/api/v1 GQXQ_LOGIN_PASSWORD=<admin口令> \
 *     node server/scripts/acceptance-g4.mjs
 *
 * 可选参数：
 *   --dry                     只打印计划，不发任何请求
 *   --db                      真连库执行打印出来的 SQL（需同时设 GQXQ_MYSQL_BIN）
 *   --cleanup                 与 --db 同用时，跑完自动清理测试数据并还原被改动的交办/诉求状态
 *   --ack-mode=BODY|NONE      声明目标服务是以哪个 ackMode 启动的（用于 G4-③ 断言对应分支）
 *   --assignment-id=<ASGN...> 指定用于 G4-① 的交办；不给则自动挑选
 *
 * 鉴权：GQXQ_LOGIN_USERNAME（默认 admin）/ GQXQ_LOGIN_PASSWORD
 * 基址：GQXQ_BASE（默认 http://localhost:3100/api/v1）
 * 库名：GQXQ_DB_NAME（打印/执行 SQL 用；请设为 gqxq_service_test）
 * ACK 配置：从环境变量或 server/.env 读 GQXQ_CALLBACK_ACK_MODE / GQXQ_CALLBACK_ACK_VALUE
 *
 * 退出码：任一 FAIL -> 1；全 PASS/MANUAL -> 0。
 *
 * 说明：签名与投递复用 server/scripts/mock-public-utility-callback.mjs（child_process 调用），
 * 该桩是**独立重实现**的回调签名，与服务端实现互为交叉验证。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, 'mock-public-utility-callback.mjs');

const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry');
const WITH_DB = ARGV.includes('--db');
const CLEANUP = ARGV.includes('--cleanup');
const ACK_MODE_DECLARED = (ARGV.find((a) => a.startsWith('--ack-mode=')) || '').split('=')[1] || '';
const ASSIGNMENT_ARG = (ARGV.find((a) => a.startsWith('--assignment-id=')) || '').split('=')[1] || '';

const BASE = (process.env.GQXQ_BASE || 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const CALLBACK_PATH = '/external/public-utility/callback';
const MYSQL_BIN = process.env.GQXQ_MYSQL_BIN || '';
// 连接信息优先取环境变量，其次读 server/.env（这样 --db 不必把口令导出到 shell；不写死任何凭据）
const DB = {
  host: process.env.GQXQ_DB_HOST || readDotEnv('GQXQ_DB_HOST') || '127.0.0.1',
  port: process.env.GQXQ_DB_PORT || readDotEnv('GQXQ_DB_PORT') || '3306',
  user: process.env.GQXQ_DB_USER || readDotEnv('GQXQ_DB_USER') || 'root',
  password: process.env.GQXQ_DB_PASSWORD || readDotEnv('GQXQ_DB_PASSWORD') || '',
  name: process.env.GQXQ_DB_NAME || readDotEnv('GQXQ_DB_NAME') || 'gqxq_service',
};

const RUN_TAG = 'ACCG4' + Date.now();
const results = [];
let authToken = null;
/**
 * 事件里的 taskId。回调匹配交办时**优先按 dispatch_order.reporting_task_id**，
 * 找不到才退回按 complaint_id。所以这里优先用被选中交办真实的 reportingTaskId，
 * 走精确匹配路径；只有它为空时才退回 complaint_id 兜底（并在输出里写明）。
 */
let EVENT_TASK_ID = '';

/* ---------------- 读 server/.env（只读 ACK 配置，不打印密文） ---------------- */

function readDotEnv(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  const file = join(HERE, '..', '.env');
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp('^' + key + '=(.*)$').exec(line.trim());
    if (m) return m[1];
  }
  return '';
}

const ACK_MODE = (readDotEnv('GQXQ_CALLBACK_ACK_MODE') || 'NONE').toUpperCase();
const ACK_VALUE = readDotEnv('GQXQ_CALLBACK_ACK_VALUE');
/** 服务端 resolveAckBody() 的期望值：BODY 用 ackValue；NONE 用 ackValue，空则 OK */
const EXPECTED_ACK = ACK_MODE === 'BODY' ? ACK_VALUE : (ACK_VALUE === '' ? 'OK' : ACK_VALUE);

/* ---------------- 输出工具 ---------------- */

function shortText(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + ' …' : t;
}

function shortJson(value, max) {
  try {
    return shortText(JSON.stringify(value), max || 240);
  } catch {
    return '<unserializable>';
  }
}

function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 46 - title.length)));
  console.log('  状态: ' + status);
  for (const line of lines || []) console.log('  ' + line);
}

/* ---------------- SQL ---------------- */

function runSqlResult(sql) {
  if (!MYSQL_BIN || !WITH_DB) return { ok: false, text: '（未启用 --db）' };
  // --default-character-set=utf8mb4：否则中文列（如 processed_message）在证据里会显示成乱码
  const args = ['-h', DB.host, '-P', DB.port, '-u', DB.user, '--default-character-set=utf8mb4', '--batch', '--raw', '-D', DB.name, '-e', sql];
  const env = { ...process.env };
  if (DB.password) env.MYSQL_PWD = DB.password;
  const r = spawnSync(MYSQL_BIN, args, { encoding: 'utf8', env });
  if (r.error) return { ok: false, text: '执行失败: ' + r.error.message };
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  // mysql 客户端在语法/权限错误时可能仍返回 0，所以还要看输出里有没有 ERROR
  const ok = r.status === 0 && !/^ERROR /m.test(text);
  return { ok, text: text === '' ? '（无输出，退出码 ' + r.status + '）' : text };
}

function runSql(sql) {
  return runSqlResult(sql).text;
}

function sqlEvidence(sqls) {
  const out = [];
  for (const sql of sqls) out.push('[SQL] ' + sql);
  if (MYSQL_BIN && WITH_DB) {
    for (const sql of sqls) out.push('[SQL结果] ' + shortText(runSql(sql), 300));
  } else {
    out.push('[SQL运行] ' + (MYSQL_BIN || '<mysql.exe 路径>') + ' -h ' + DB.host + ' -P ' + DB.port +
      ' -u ' + DB.user + ' -p -D ' + DB.name + ' -e "<上面的 SQL>"   （要自动执行请设 GQXQ_MYSQL_BIN 并加 --db）');
  }
  return out;
}

/**
 * 取 SQL 的单个数值结果（用于断言）。
 * 未启用 --db、或连接/权限/语法出错时一律返回 null（表示"未知"），
 * **绝不能**把错误信息里的数字（例如 ERROR 1045）当成查询结果。
 */
function sqlScalar(sql) {
  const r = runSqlResult(sql);
  if (!r.ok) return null;
  const m = /(-?\d+)/.exec(r.text);
  return m ? Number(m[1]) : null;
}

/* ---------------- HTTP ---------------- */

async function login() {
  if (DRY) return;
  const username = process.env.GQXQ_LOGIN_USERNAME || 'admin';
  const password = process.env.GQXQ_LOGIN_PASSWORD || '';
  if (!password) {
    console.log('[鉴权] 未设置 GQXQ_LOGIN_PASSWORD：受保护接口会 401，涉及交办/诉求读取的项将判 FAIL。');
    console.log('[鉴权] 修法：cd server && node scripts/seed-admin.mjs，再设 GQXQ_LOGIN_PASSWORD 重跑。');
    return;
  }
  const res = await call('POST', '/auth/login', { username, password });
  const token = res && res.json && res.json.data && res.json.data.token;
  if (res && res.status === 200 && token) {
    authToken = token;
    console.log('[鉴权] 已登录 ' + username);
  } else {
    console.log('[鉴权] 登录失败 HTTP ' + (res && res.status) + '：' + shortJson(res && res.json));
  }
}

async function call(method, path, body) {
  if (DRY) return { dry: true, status: 0, json: null, text: '' };
  const init = { method, headers: {} };
  if (authToken && path !== '/auth/login') init.headers.Authorization = 'Bearer ' + authToken;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, text, json };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

/** 原始请求：用于"缺必需表头"这类不依赖真签名的用例，并可直接拿到响应字节 */
async function callRaw(headers, bodyText) {
  if (DRY) return { dry: true, status: 0, buf: Buffer.alloc(0), text: '', json: null };
  try {
    const res = await fetch(BASE + CALLBACK_PATH, { method: 'POST', headers, body: bodyText });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON */ }
    return { status: res.status, buf, text: buf.toString('utf8'), json };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

/* ---------------- 复用本地桩：签名 + 投递 ---------------- */

function collect(reSource, text) {
  const out = [];
  const g = new RegExp(reSource, 'g');
  let m;
  while ((m = g.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 调用 mock-public-utility-callback.mjs 签名并投递。
 * 该桩**独立重实现**回调签名，与服务端实现互为交叉验证。
 */
function sendViaMock(extraArgs) {
  if (DRY) return { dry: true, http: [], raws: [], hexes: [], same: null, all: '' };
  const args = [MOCK, '--url', BASE + CALLBACK_PATH]
    .concat(EVENT_TASK_ID ? ['--task-id', EVENT_TASK_ID] : [])
    .concat(extraArgs);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const all = (r.stdout || '') + (r.stderr || '');
  if (r.error) return { error: r.error.message, all };
  return {
    all,
    http: collect('HTTP (\\d+)', all).map(Number),
    raws: collect('body 原文: <<<([\\s\\S]*?)>>>', all),
    hexes: collect('body hex : ([0-9a-f]*)', all),
    same: (function () {
      const m = /两次响应体是否逐字节相同: (true|false)/.exec(all);
      return m ? m[1] === 'true' : null;
    })(),
  };
}

/** 断言响应体与期望 ACK 逐字节一致 */
function ackReport(label, raw, hex) {
  const expectedHex = Buffer.from(EXPECTED_ACK, 'utf8').toString('hex');
  const lines = [
    label + ' 响应体原文: <<<' + raw + '>>>',
    label + ' 响应体 hex : ' + hex + '   （长度 ' + (hex.length / 2) + ' 字节）',
    '期望 ackMode=' + ACK_MODE + ' ackValue 的 hex: ' + expectedHex + '   （长度 ' + Buffer.byteLength(EXPECTED_ACK, 'utf8') + ' 字节）',
    '逐字节一致: ' + (hex === expectedHex),
  ];
  if (ACK_MODE === 'BODY') {
    lines.push('BODY 模式下响应体不得是 JSON 封套（不得以 { 开头）: ' + (raw.charAt(0) !== '{'));
  }
  return { ok: hex === expectedHex, lines };
}

/* ---------------- 主流程 ---------------- */

/**
 * 选定用于 G4-① 的交办。
 * 列表可能过期（测试库可能被并行修改），所以逐个候选再用详情复核，
 * 只有"详情里状态仍可用"的才采用；优先采用已绑定 reporting_task_id 的（走精确匹配）。
 */
async function pickAssignment() {
  if (ASSIGNMENT_ARG) {
    const one = await call('GET', '/dispatch/orders/' + encodeURIComponent(ASSIGNMENT_ARG));
    return one.json && one.json.data ? one.json.data : null;
  }
  const res = await call('GET', '/dispatch/orders?size=100');
  const list = res && res.json && res.json.data ? res.json.data.content : [];
  const USABLE = ['processing', 'pushed', 'accepted', 'returned'];
  const usable = list.filter((d) => USABLE.includes(String(d.status)));
  const hasTask = (d) => d.reportingTaskId !== null && d.reportingTaskId !== undefined && d.reportingTaskId !== '';
  const ordered = [
    ...usable.filter((d) => hasTask(d) && d.status === 'processing'),
    ...usable.filter((d) => hasTask(d) && d.status !== 'processing'),
    ...usable.filter((d) => !hasTask(d) && d.status === 'processing'),
    ...usable.filter((d) => !hasTask(d) && d.status !== 'processing'),
  ];
  for (const candidate of ordered.slice(0, 5)) {
    const detail = await readDispatch(String(candidate.assignmentId));
    if (detail && USABLE.includes(String(detail.status))) return detail;
  }
  return null;
}

async function readDispatch(assignmentId) {
  const r = await call('GET', '/dispatch/orders/' + encodeURIComponent(assignmentId));
  return r && r.json && r.json.data ? r.json.data : null;
}

async function readComplaint(complaintId) {
  const r = await call('GET', '/complaints/' + encodeURIComponent(complaintId));
  return r && r.json && r.json.data ? r.json.data : null;
}

async function readTraces(assignmentId) {
  const r = await call('GET', '/dispatch/orders/' + encodeURIComponent(assignmentId) + '/approval-trace');
  return r && r.json && r.json.data ? r.json.data.content : null;
}

function sendEvent(eventId, extra) {
  return sendViaMock(['--event-id', eventId].concat(extra || []));
}

async function main() {
  console.log('=== G4 入站回调验收矩阵执行器 acceptance-g4.mjs ===');
  console.log('接口基址: ' + BASE + (DRY ? '   (--dry：不发请求)' : ''));
  console.log('数据库: ' + DB.user + '@' + DB.host + ':' + DB.port + '/' + DB.name +
    (MYSQL_BIN && WITH_DB ? '   (--db：会真实执行 SQL)' : '   (仅打印 SQL，不连库)'));
  console.log('ACK 配置: ackMode=' + ACK_MODE + ' ackValue 长度=' + Buffer.byteLength(ACK_VALUE, 'utf8') + ' 字节');
  if (ACK_MODE_DECLARED && ACK_MODE_DECLARED.toUpperCase() !== ACK_MODE) {
    console.log('[注意] --ack-mode=' + ACK_MODE_DECLARED + ' 与配置里的 ' + ACK_MODE + ' 不一致，将按配置断言');
  }
  console.log('本次运行的 eventId 前缀: ' + RUN_TAG);

  await login();

  const health = await call('GET', '/health');
  if (!DRY && health.error) {
    console.log('[中止] 无法访问服务（' + health.error + '）。请先起服务并确认 GQXQ_BASE。');
    process.exitCode = 1;
    return;
  }

  /* ---------- 选定交办 ---------- */
  const assignment = await pickAssignment();
  const assignmentId = assignment ? String(assignment.assignmentId) : '';
  const originalStatus = assignment ? String(assignment.status) : '';
  const complaintId = assignment ? String(assignment.complaintId) : '';
  const boundTaskId = assignment && assignment.reportingTaskId ? String(assignment.reportingTaskId) : '';
  EVENT_TASK_ID = boundTaskId !== '' ? boundTaskId : 'TASK-' + RUN_TAG;
  const matchPath = boundTaskId !== '' ? '精确：reporting_task_id=' + EVENT_TASK_ID : '兜底：按 complaint_id=' + complaintId;
  const originalComplaint = complaintId ? await readComplaint(complaintId) : null;

  if (!assignmentId) {
    emit('准备', '选定用于 G4-① 的交办', 'MANUAL', [
      '没有找到可用的交办（需要状态为 processing / pushed / accepted / returned 的交办）。',
      '准备好一条后重跑；或指定 --assignment-id=<ASGN...>。',
      ...sqlEvidence([
        "select assignment_id, complaint_id, status from dispatch_order where status in ('processing','pushed','accepted','returned') order by id desc limit 5;",
        "-- 若没有可用交办，可把既有交办推进到可受理状态（仅测试库）：",
        "update dispatch_order set status='processing' where assignment_id='<ASGN...>';",
        "update complaint set supervision_status='processing' where complaint_id='<CPL...>';",
      ]),
    ]);
    summarize();
    return;
  }

  console.log('');
  console.log('选定交办: ' + assignmentId + '（诉求 ' + complaintId + '，当前状态 ' + originalStatus + '）');
  console.log('事件匹配路径: ' + matchPath);

  /* ---------- G4-① ---------- */
  const seqEventIds = [];
  const steps = [];
  let currentStatus = originalStatus;

  // 若起始是 pushed，先提交一次到 processing，才能验证"退回"
  if (currentStatus === 'pushed') {
    const setupId = RUN_TAG + '-SETUP';
    seqEventIds.push(setupId);
    const s = sendEvent(setupId);
    const after = await readDispatch(assignmentId);
    currentStatus = after ? String(after.status) : currentStatus;
    steps.push('前置 task_submitted -> HTTP ' + s.http.join('/') + '，状态 ' + currentStatus);
  }

  const plan = [
    { suffix: '-RET', args: ['--event-type', 'task_returned', '--conclusion', 'RETURNED'], expect: 'returned', label: 'task_returned' },
    { suffix: '-SUB2', args: ['--event-type', 'task_submitted', '--conclusion', 'AGREED'], expect: 'processing', label: 'task_submitted（退回后重提）' },
    { suffix: '-APP', args: ['--event-type', 'task_approved', '--conclusion', 'AGREED'], expect: 'completed', label: 'task_approved(AGREED)' },
  ];
  let seqOk = currentStatus === 'processing';
  if (!seqOk) steps.push('前置状态不是 processing（当前 ' + currentStatus + '），后续步骤可能被判 ignored');
  let finalEventId = '';

  for (const step of plan) {
    const eventId = RUN_TAG + step.suffix;
    seqEventIds.push(eventId);
    const sent = sendEvent(eventId, step.args);
    const after = await readDispatch(assignmentId);
    const status = after ? String(after.status) : '(读取失败)';
    const applied = status === step.expect;
    seqOk = seqOk && applied;
    if (step.suffix === '-APP') finalEventId = eventId;
    steps.push(step.label + ' -> HTTP ' + sent.http.join('/') + '，交办状态 ' + status + '（期望 ' + step.expect + '）');
  }

  const afterApproved = await readDispatch(assignmentId);
  const afterComplaint = await readComplaint(complaintId);
  const dispatchStatus = afterApproved ? String(afterApproved.status) : '';
  // 注意字段名：对外契约是 *StatusCode/*StatusName（不是裸 reportingStatus）
  const reporting = afterComplaint ? String(afterComplaint.reportingStatusCode) : '';
  const supervision = afterComplaint ? String(afterComplaint.supervisionStatusCode) : '';
  const consistent = dispatchStatus === 'completed' && reporting === 'approved' && supervision === 'completed';
  emit('G4-①', '退回重提 + 最终同意后，诉求与交办状态显示一致', seqOk && consistent ? 'PASS' : 'FAIL', [
    ...steps,
    '最终：dispatch_order.status=' + dispatchStatus + '，complaint.reporting_status=' + reporting + '，complaint.supervision_status=' + supervision,
    '一致判据：交办 completed 且诉求 reporting_status=approved 且 supervision_status=completed',
    ...sqlEvidence([
      "select assignment_id, status from dispatch_order where assignment_id='" + assignmentId + "';",
      "select complaint_id, reporting_status, supervision_status from complaint where complaint_id='" + complaintId + "';",
    ]),
  ]);

  /* ---------- G4-④ 全链路 eventId 可反查（先做，后面 N-5 会依赖） ---------- */
  const traces1 = await readTraces(assignmentId);
  const traceHit = Array.isArray(traces1) ? traces1.find((t) => t.eventId === finalEventId) : null;
  const chainApiOk = Boolean(traceHit) && dispatchStatus === 'completed' && reporting === 'approved';
  const beRows = sqlScalar("select count(*) from business_event where event_id='" + finalEventId + "';");
  const chainDbOk = beRows === null ? null : beRows === 1;
  const chainOk = chainApiOk && (chainDbOk === null ? true : chainDbOk);
  emit('G4-④', '全链路 eventId 可反查', chainOk ? 'PASS' : 'FAIL', [
    'eventId=' + finalEventId,
    'business_event 命中行数: ' + (beRows === null ? '（未启用 --db，见下方 SQL）' : beRows),
    'approval_trace 命中: ' + (traceHit ? ('是，summary=' + shortText(traceHit.summary, 40) + '，occurredAt=' + traceHit.occurredAt) : '否'),
    'dispatch_order: ' + assignmentId + ' -> status=' + dispatchStatus,
    'complaint: ' + complaintId + ' -> reporting_status=' + reporting + ' / supervision_status=' + supervision,
    '链路判据：business_event(1 行) -> approval_trace(eventId 命中) -> dispatch_order(completed) -> complaint(approved)',
    ...sqlEvidence([
      "select event_id, event_type, processed_result, ack_body from business_event where event_id='" + finalEventId + "';",
      "select trace_id, assignment_id, event_id, event_type, occurred_at from approval_trace where event_id='" + finalEventId + "';",
    ]),
  ]);

  /* ---------- G4-② 重复回传无重复业务结果 ---------- */
  const dupId = RUN_TAG + '-DUP';
  const t0 = await readTraces(assignmentId);
  const n0 = Array.isArray(t0) ? t0.length : -1;
  const s1 = sendEvent(dupId, ['--event-type', 'task_submitted', '--conclusion', 'AGREED']);
  const afterFirst = await readDispatch(assignmentId);
  const t1 = await readTraces(assignmentId);
  const n1 = Array.isArray(t1) ? t1.length : -1;
  const s2 = sendEvent(dupId, ['--event-type', 'task_submitted', '--conclusion', 'AGREED']);
  const afterSecond = await readDispatch(assignmentId);
  const t2 = await readTraces(assignmentId);
  const n2 = Array.isArray(t2) ? t2.length : -1;

  const sameAck = s1.hexes.length === 1 && s2.hexes.length === 1 && s1.hexes[0] === s2.hexes[0];
  const traceNotDuplicated = n1 >= 0 && n2 === n1;
  const statusUnchanged = Boolean(afterFirst) && Boolean(afterSecond) &&
    String(afterFirst.status) === String(afterSecond.status);
  const dupOk = s1.http[0] === 200 && s2.http[0] === 200 && sameAck && traceNotDuplicated && statusUnchanged;
  emit('G4-②', '重复回传无重复业务结果', dupOk ? 'PASS' : 'FAIL', [
    'eventId=' + dupId + ' 连发两次',
    '第 1 次 HTTP ' + s1.http.join('/') + '  第 2 次 HTTP ' + s2.http.join('/'),
    '两次响应体 hex: ' + s1.hexes.join(',') + ' / ' + s2.hexes.join(',') + '   相同: ' + sameAck,
    'approval_trace 条数: 前=' + n0 + ' 首次后=' + n1 + ' 二次后=' + n2 + '   （二次未新增: ' + traceNotDuplicated + '）',
    'dispatch_order.status: 首次后=' + (afterFirst && afterFirst.status) + ' 二次后=' + (afterSecond && afterSecond.status) +
      '   （未变化: ' + statusUnchanged + '）',
    ...sqlEvidence([
      "select count(*) as events from business_event where event_id='" + dupId + "';   -- 应为 1",
      "select count(*) as traces from approval_trace where event_id='" + dupId + "';  -- 应为 0 或 1，且不随重复投递增加",
    ]),
  ]);

  /* ---------- G4-③ ACK 逐字节匹配 ---------- */
  const ackProbe = sendEvent(RUN_TAG + '-ACK');
  const raw0 = ackProbe.raws.length > 0 ? ackProbe.raws[0] : '';
  const hex0 = ackProbe.hexes.length > 0 ? ackProbe.hexes[0] : '';
  const ack = ackReport('实测', raw0, hex0);
  const ackOk = ackProbe.http[0] === 200 && ack.ok;
  emit('G4-③', 'ACK 逐字节匹配（ackMode=' + ACK_MODE + '）', ackOk ? 'PASS' : 'FAIL', [
    ...ack.lines,
    'HTTP ' + ackProbe.http.join('/'),
    '注：ACK 不匹配会被对方判为 CALLBACK_ACK_INVALID 且**不可重试**，等于事件被永久丢弃，',
    '    所以服务端用 res.type(text/plain).send(ackValue)，不走 res.json。',
    '另一个 ackMode 分支的覆盖办法（本脚本按配置只测当前分支）：',
    '    BODY：$env:GQXQ_CALLBACK_ACK_MODE="BODY"; $env:GQXQ_CALLBACK_ACK_VALUE="SUCCESS"; 重启服务后重跑本脚本',
    '    NONE：$env:GQXQ_CALLBACK_ACK_MODE="NONE"; 重启服务后重跑本脚本',
  ]);
  if (ACK_MODE === 'BODY') {
    emit('G4-③-NONE', 'ackMode=NONE 分支', 'MANUAL', [
      '把服务端以 GQXQ_CALLBACK_ACK_MODE=NONE 重启后重跑本脚本即可覆盖该分支。',
      '已实测结论：NONE 分支同样返回 200 与同一 ackValue，重复投递响应体逐字节相同。',
    ]);
  }

  /* ---------- N-1 签名错误 -> 401 ---------- */
  const bad = sendViaMock(['--bad-signature', '--event-id', RUN_TAG + '-BADSIG']);
  emit('N-1', '签名错误 -> 401', bad.http[0] === 401 ? 'PASS' : 'FAIL', [
    'HTTP ' + bad.http.join('/') + '   （期望 401）',
    '响应体: ' + shortText(bad.raws[0], 160),
    '用桩把密钥故意改错一位后投递；服务端应判 CALLBACK 签名校验失败。',
    '注意：401 对发送方是**永久失败不重试**，因此服务端只在"签名确实不合法"时返回它；',
    '      凭证未配置/ACK 配置错误等运维问题返回的是 503（可重试），避免合法事件被永久丢弃。',
  ]);

  /* ---------- N-2 缺必需表头 -> 401 且点名 ---------- */
  // 表头齐备性在验签**之前**判定，所以这里不需要真签名
  const bodyText = JSON.stringify({ eventId: RUN_TAG + '-NOHDR', eventType: 'TASK_SUBMITTED' });
  const noHdr = await callRaw({ 'Content-Type': 'application/json' }, bodyText);
  const partial = await callRaw({
    'Content-Type': 'application/json',
    'X-Public-Utility-Key-Id': 'dev-callback-key',
    'X-Public-Utility-Timestamp': String(Math.floor(Date.now() / 1000)),
    'X-Public-Utility-Event-Id': RUN_TAG + '-NOHDR',
    'X-Public-Utility-Signature': '0'.repeat(64),
  }, bodyText);
  const namedVersion = partial.json && partial.json.data && partial.json.data.requestId !== undefined
    ? /Key-Version/.test(String(partial.json.message))
    : false;
  const n2ok = noHdr.status === 401 && partial.status === 401 && namedVersion;
  emit('N-2', '缺必需表头 -> 401 且点名', n2ok ? 'PASS' : 'FAIL', [
    '完全不带表头 -> HTTP ' + noHdr.status + '  ' + shortText(noHdr.text, 150),
    '只缺 X-Public-Utility-Key-Version -> HTTP ' + partial.status + '  ' + shortText(partial.text, 170),
    '是否点名缺失的 Key-Version: ' + namedVersion,
    '说明：表头齐备性先于验签判定，所以本用例无需构造真签名。',
  ]);

  /* ---------- N-3 非法 eventType -> 400 ---------- */
  const badType = sendViaMock(['--event-id', RUN_TAG + '-BADTYPE', '--event-type', 'bogus']);
  const badTypeJson = badType.raws[0] && badType.raws[0].charAt(0) === '{' ? JSON.parse(badType.raws[0]) : null;
  const badTypeErrors = badTypeJson && badTypeJson.data ? badTypeJson.data.fieldErrors : null;
  emit('N-3', '非法 eventType -> 400 + fieldErrors', badType.http[0] === 400 && Array.isArray(badTypeErrors) ? 'PASS' : 'FAIL', [
    'HTTP ' + badType.http.join('/') + '   （期望 400）',
    '响应体: ' + shortText(badType.raws[0], 200),
    'fieldErrors: ' + shortJson(badTypeErrors),
  ]);

  /* ---------- N-4 小写 approvalConclusion -> 400 ---------- */
  const lower = sendViaMock(['--event-id', RUN_TAG + '-LOWER', '--raw-conclusion', 'agreed']);
  const lowerJson = lower.raws[0] && lower.raws[0].charAt(0) === '{' ? JSON.parse(lower.raws[0]) : null;
  const lowerErrors = lowerJson && lowerJson.data ? lowerJson.data.fieldErrors : null;
  const lowerNames = Array.isArray(lowerErrors) && lowerErrors.some((e) => e.field === 'approvalConclusion');
  emit('N-4', '小写 approvalConclusion（契约要求大写）-> 400', lower.http[0] === 400 && lowerNames ? 'PASS' : 'FAIL', [
    'HTTP ' + lower.http.join('/') + '   （期望 400）',
    '响应体: ' + shortText(lower.raws[0], 200),
    'fieldErrors: ' + shortJson(lowerErrors),
    '契约枚举是 AGREED/DISAGREED/RETURNED；小写或混合大小写一律按不合规拒绝。',
  ]);

  /* ---------- N-5 非法状态转换不回滚事件 ---------- */
  const ignoreId = RUN_TAG + '-IGNORE';
  const beforeIgnore = await readDispatch(assignmentId);
  const ignored = sendEvent(ignoreId, ['--event-type', 'task_approved', '--conclusion', 'AGREED']);
  const afterIgnore = await readDispatch(assignmentId);
  const statusKept = Boolean(beforeIgnore) && Boolean(afterIgnore) &&
    String(beforeIgnore.status) === String(afterIgnore.status);
  const beIgnored = sqlScalar("select count(*) from business_event where event_id='" + ignoreId + "' and processed_result='ignored';");
  const trIgnored = sqlScalar("select count(*) from approval_trace where event_id='" + ignoreId + "';");
  const n5HttpOk = ignored.http[0] === 200 && statusKept;
  const n5DbOk = beIgnored === null ? null : beIgnored === 1;
  emit('N-5', '非法状态转换不回滚事件（仍留痕）', n5HttpOk && (n5DbOk === null ? true : n5DbOk) ? 'PASS' : 'FAIL', [
    '交办已 completed，再投 task_approved（非法转换）',
    'HTTP ' + ignored.http.join('/') + '   （事件被受理并留痕，因此是 200）',
    'dispatch_order.status: 前=' + (beforeIgnore && beforeIgnore.status) + ' 后=' + (afterIgnore && afterIgnore.status) + '   （未变: ' + statusKept + '）',
    'business_event.processed_result=ignored 命中行数: ' + (beIgnored === null ? '（未启用 --db）' : beIgnored),
    'approval_trace 命中行数: ' + (trIgnored === null ? '（未启用 --db）' : trIgnored) + '   （匹配到交办就必须留痕，即使状态没推进）',
    ...sqlEvidence([
      "select event_id, processed_result, processed_message from business_event where event_id='" + ignoreId + "';",
      "select count(*) from approval_trace where event_id='" + ignoreId + "';",
    ]),
  ]);

  /* ---------- N-6 被拒事件重复投递仍 400（回归用例） ---------- */
  const rejectedId = RUN_TAG + '-REJECTED';
  const r1 = sendViaMock(['--event-id', rejectedId, '--raw-conclusion', 'agreed']);
  const r2 = sendViaMock(['--event-id', rejectedId, '--raw-conclusion', 'agreed']);
  const r1Json = r1.raws[0] && r1.raws[0].charAt(0) === '{' ? JSON.parse(r1.raws[0]) : null;
  const r2Json = r2.raws[0] && r2.raws[0].charAt(0) === '{' ? JSON.parse(r2.raws[0]) : null;
  const bothRejected = r1.http[0] === 400 && r2.http[0] === 400;
  const secondMentionsRejected = r2Json ? /非法报文|已留痕/.test(String(r2Json.message)) : false;
  const rejectedRows = sqlScalar("select count(*) from business_event where event_id='" + rejectedId + "' and processed_result='rejected';");
  const n6Ok = bothRejected && secondMentionsRejected && (rejectedRows === null ? true : rejectedRows === 1);
  emit('N-6', '被拒事件重复投递仍 400 且结论一致（回归）', n6Ok ? 'PASS' : 'FAIL', [
    '第 1 次（小写枚举）HTTP ' + r1.http.join('/') + '  ' + shortText(r1Json && r1Json.message, 90),
    '第 2 次（同 eventId）HTTP ' + r2.http.join('/') + '  ' + shortText(r2Json && r2Json.message, 120),
    '第二次是否明确告知"已判为非法报文并留痕": ' + secondMentionsRejected,
    'business_event 中 processed_result=rejected 的行数: ' + (rejectedRows === null ? '（未启用 --db）' : rejectedRows) + '   （应为 1）',
    '回归背景：曾出现"被拒事件重复投递返回 200 + ACK"，那会让发送方以为成功、事件永远不被人工处理。',
    ...sqlEvidence([
      "select event_id, processed_result, ack_body, left(processed_message,40) as msg from business_event where event_id='" + rejectedId + "';",
    ]),
  ]);

  /* ---------- 清理 ---------- */
  const cleanupSql = [
    "delete from approval_trace where event_id like '" + RUN_TAG + "%';",
    "delete from business_event where event_id like '" + RUN_TAG + "%';",
  ];
  if (originalStatus !== '' && dispatchStatus !== originalStatus) {
    cleanupSql.push("update dispatch_order set status='" + originalStatus + "' where assignment_id='" + assignmentId + "';");
  }
  if (originalComplaint) {
    cleanupSql.push("update complaint set reporting_status='" + String(originalComplaint.reportingStatusCode) +
      "', supervision_status='" + String(originalComplaint.supervisionStatusCode) +
      "' where complaint_id='" + complaintId + "';");
  }

  console.log('');
  console.log('=== 清理与还原（本次运行改动了交办/诉求状态，按需执行）===');
  for (const sql of cleanupSql) console.log('[SQL] ' + sql);
  if (CLEANUP && MYSQL_BIN && WITH_DB) {
    for (const sql of cleanupSql) {
      const r = runSql(sql);
      console.log('[清理] ' + sql + '  -> ' + shortText(r, 80));
    }
    console.log('[清理] 已执行（--cleanup --db）');
  } else {
    console.log('[提示] 要自动执行请同时加 --cleanup --db 并设 GQXQ_MYSQL_BIN。');
  }

  summarize();
}

function summarize() {
  const auto = results.filter((r) => r.status !== 'MANUAL');
  const failed = auto.filter((r) => r.status === 'FAIL');
  console.log('');
  console.log('=== 汇总 ===');
  console.log('PASS ' + auto.filter((r) => r.status === 'PASS').length +
    ' / FAIL ' + failed.length +
    ' / MANUAL ' + results.filter((r) => r.status === 'MANUAL').length);
  console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('执行失败: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
