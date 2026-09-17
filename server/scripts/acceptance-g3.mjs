#!/usr/bin/env node
/**
 * G3 验收矩阵执行器 —— 出站：把敏感交办推送为 public-utility 填报任务。
 *
 * 对应《2026-09-17-诉求平台落地计划.md》G3 的验收项：
 *   ① 同一 requestId 多次推送，两系统都只有一个任务（重推返回同一 task.id）
 *   ② 篡改 body / 签名 -> 对方 401（协议层构造）
 *   ③ 重用 nonce -> 409 INTEGRATION_REPLAY，且换新 nonce 可成功
 *   ④ 超时重试不产生第二条任务（同 requestId、同 body、新 nonce）
 *   ⑤ 响应 task.id 落库可查（dispatch_order.reporting_task_id 与 dispatch_request_log.task_id）
 *   ⑥ organizationCode 会被 422（证实对方 DTO 与验签白名单漂移，gqxq 侧必须不发送）
 *   ⑦ 成功推送后 complaint.reporting_status=pushed 且 source_event_status 未被改写（三轴不互相覆盖）
 *   ⑧ 失败分支 conflict：只 1 次尝试，且不改状态与任务号
 *   ⑨ 失败分支 auth_failed：不可重试，且不改状态
 *   ⑩ 失败分支 replay：换新 nonce 重试成功，两次尝试都留痕
 *   ⑪ 协议：时间戳超出 ±300s -> 401
 *   ⑫ 协议：body 超过 1 MiB -> 413 PAYLOAD_TOO_LARGE
 *
 * ---------------------------------------------------------------------------
 * 用法（两种桩模式，二选一）
 * ---------------------------------------------------------------------------
 * 前置：后端必须已经指向**测试库**并与桩使用同一套凭证启动。例如：
 *
 *   cd server
 *   $env:GQXQ_DB_NAME='gqxq_service_test'
 *   $env:GQXQ_PU_BASE_URL='http://localhost:8099'
 *   $env:GQXQ_PU_KEY_ID='dev-key'; $env:GQXQ_PU_SECRET='dev-secret'
 *   $env:PORT='3313'
 *   node dist/index.js
 *
 * 模式 A（默认，推荐）：本脚本自己按需拉起/停掉桩服务器，并用 child_process
 *   restart 注入 --conflict / --replay-once / --auth-fail / --timeout-once 四种故障。
 *   GQXQ_BASE=http://localhost:3313/api/v1 GQXQ_LOGIN_PASSWORD=*** node server/scripts/acceptance-g3.mjs
 *
 * 模式 B（--no-mock）：调用方**自己**把桩起在约定端口，本脚本只做就绪探针、不启动也不停止它。
 *   此时故障注入项（⑧⑨⑩⑫之一）会因桩未按需重启而无法覆盖 —— 脚本会把对应项标为 FAIL 并在证据里写明。
 *   node server/scripts/acceptance-g3.mjs --no-mock --mock-port 8099
 *
 * 其它开关：
 *   --dry                 不发任何请求、不启动桩；逐项打印 MANUAL 与将要检查的内容
 *   --mock-port <n>       桩端口（默认 8099，也可用 GQXQ_MOCK_PORT）
 *   --mock-key-id <id>    桩期望的 keyId（默认取 GQXQ_PU_KEY_ID，再退回 server/.env，再退回 dev-key）
 *   --mock-secret <s>     桩期望的 secret（同上，默认取 GQXQ_PU_SECRET / server/.env / dev-secret）
 *
 * 环境变量：GQXQ_BASE、GQXQ_LOGIN_USERNAME、GQXQ_LOGIN_PASSWORD、GQXQ_DB_NAME（仅用于打印清理 SQL）
 *
 * 说明：
 *   * 本脚本在目标库新建诉求（sourceId 前缀 ACCG3）与交办，**请指向测试库 gqxq_service_test**。
 *   * 跑完会打印清理 SQL；脚本本身不删数据（避免误删真库）。
 *   * 不占用 3100：桩默认 8099，接口基址由 GQXQ_BASE 指定。
 *   * 协议层检查会用**独立实现**的 HMAC 重算签名后手工构造请求——
 *     这是刻意为之：如果连独立实现都算不对，就说明签名规格理解错了，而不是桩在放水。
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const BASE = (process.env.GQXQ_BASE || 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const DRY = hasFlag('--dry');
const NO_MOCK = hasFlag('--no-mock');
const MANAGE_MOCK = !DRY && !NO_MOCK;
const DB_NAME = process.env.GQXQ_DB_NAME || 'gqxq_service';
const MOCK_PORT = Number(flagValue('--mock-port', process.env.GQXQ_MOCK_PORT || '8099'));
const MOCK_BASE = 'http://localhost:' + MOCK_PORT;
const APP_CODE = 'gqxq';
const TASK_PATH = '/api/integrations/' + APP_CODE + '/tasks';

/* ---------------- 桩凭证：与后端保持一致（不写死真实凭据） ---------------- */
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const matched = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (matched !== null) out[matched[1]] = matched[2].trim();
    }
  } catch {
    /* 文件不存在就当作空配置 */
  }
  return out;
}
const dotEnv = readEnvFile(join(SERVER_DIR, '.env'));
const MOCK_KEY_ID = flagValue('--mock-key-id', process.env.GQXQ_PU_KEY_ID || dotEnv.GQXQ_PU_KEY_ID || 'dev-key');
const MOCK_SECRET = flagValue('--mock-secret', process.env.GQXQ_PU_SECRET || dotEnv.GQXQ_PU_SECRET || 'dev-secret');

/* ---------------- 输出工具（与 acceptance-g1/g2 同风格） ---------------- */
const results = [];
let authToken = null;

function shortJson(value, max) {
  try {
    const text = JSON.stringify(value);
    const limit = max || 240;
    return text && text.length > limit ? text.slice(0, limit) + ' …' : String(text);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 桩进程管理 ---------------- */
let mockProc = null;

function startMock(flags) {
  const args = ['scripts/mock-public-utility.mjs', '--port', String(MOCK_PORT), '--key-id', MOCK_KEY_ID, '--secret', MOCK_SECRET];
  mockProc = spawn('node', args.concat(flags || []), { cwd: SERVER_DIR, stdio: 'ignore' });
}
function stopMock() {
  if (mockProc !== null) {
    mockProc.kill();
    mockProc = null;
  }
}
async function probeMock(timeoutMs) {
  try {
    const res = await fetch(MOCK_BASE + '/health', { signal: AbortSignal.timeout(timeoutMs || 1000) });
    await res.text();
    return true;
  } catch {
    return false;
  }
}
async function waitMockReady(tries) {
  const max = tries || 60;
  for (let i = 0; i < max; i += 1) {
    if (await probeMock(1000)) return true;
    await sleep(150);
  }
  return false;
}
async function restartMockWith(flags) {
  stopMock();
  await sleep(400);
  startMock(flags);
  return waitMockReady();
}

/* ---------------- 独立实现的签名（对照对方 HmacRequestAuthenticator） ---------------- */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function signIndependently(secret, method, path, timestamp, nonce, bodySha256) {
  const canonical = ['v1', method.toUpperCase(), path, timestamp, nonce, bodySha256].join('\n');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(canonical, 'utf8')).digest('hex');
}

/**
 * 手工构造一个协议层请求打桩；返回 { status, json, nonce }。
 *
 * overrides.signUsingPayload 用于**故意制造签名与 body 不匹配**：
 * 签名按该载荷算，实际发送的却是 payload —— 服务端会用收到的原始字节重算 sha256，
 * 于是签名校验必然失败。这正是"篡改 body"的等价场景。
 */
async function callMock(payload, overrides) {
  const opts = overrides || {};
  const bodyText = JSON.stringify(payload);
  const bodyBytes = Buffer.from(bodyText, 'utf8');
  const signedBytes = opts.signUsingPayload !== undefined
    ? Buffer.from(JSON.stringify(opts.signUsingPayload), 'utf8')
    : bodyBytes;
  const timestamp = opts.timestamp !== undefined ? opts.timestamp : String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce !== undefined ? opts.nonce : randomUUID();
  const bodySha256 = sha256Hex(signedBytes);
  const signature = opts.signature !== undefined
    ? opts.signature
    : signIndependently(MOCK_SECRET, 'POST', TASK_PATH, timestamp, nonce, bodySha256);
  try {
    const res = await fetch(MOCK_BASE + TASK_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PU-Key-Id': MOCK_KEY_ID,
        'X-PU-Timestamp': timestamp,
        'X-PU-Nonce': nonce,
        'X-PU-Signature': signature,
      },
      body: bodyBytes,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, text, json, nonce };
  } catch (err) {
    return { status: 0, text: '', json: null, nonce, error: err && err.message ? err.message : String(err) };
  }
}

/* ---------------- gqxq API 调用 ---------------- */
async function call(method, path, body) {
  if (DRY) return { dry: true, status: 0 };
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
    return { ok: res.ok, status: res.status, text, json, data: json === null ? null : json.data };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function login() {
  if (DRY) return;
  const username = process.env.GQXQ_LOGIN_USERNAME || 'admin';
  const password = process.env.GQXQ_LOGIN_PASSWORD || '';
  if (password === '') {
    console.log('[鉴权] 未设置 GQXQ_LOGIN_PASSWORD，受保护接口会 401。');
    return;
  }
  const res = await call('POST', '/auth/login', { username, password });
  const token = res && res.json && res.json.data && res.json.data.token;
  if (res && res.status === 200 && token) {
    authToken = token;
    console.log('[鉴权] 已登录 ' + username);
  } else {
    console.log('[鉴权] 登录失败 HTTP ' + (res && res.status) + ' ' + shortJson(res && res.json));
  }
}

/* ---------------- 测试数据构造 ---------------- */
let seq = 0;
async function newComplaint(tag) {
  seq += 1;
  const sourceId = 'ACCG3' + tag + '-' + Date.now() + '-' + seq;
  const res = await call('POST', '/external/yijiejieban/appeal', {
    sourceId,
    title: '[G3验收] ' + tag,
    content: 'G3 验收用例：爆管、大面积停水。',
    source: 'G3验收',
    districtName: '西陵区',
  });
  const data = res && res.json ? res.json.data : null;
  return { sourceId, complaintId: data ? data.complaintId : null, res };
}
async function assignEnterprise(complaintId) {
  return call('POST', '/complaints/' + encodeURIComponent(complaintId) + '/assignment', {
    enterpriseCode: 'ENT-WATER-001',
    enterpriseName: '宜昌市供水总公司',
    reason: 'G3验收-分配',
  });
}
async function newDispatch(complaintId) {
  const deadline = new Date(Date.now() + 3 * 86400000);
  const offsetIso = new Date(deadline.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
  const res = await call('POST', '/dispatch/orders', {
    complaintId,
    targetEnterpriseCode: 'ENT-WATER-001',
    targetEnterpriseName: '宜昌市供水总公司',
    reason: 'G3验收',
    requirement: '请核实情况并填报企业处置结果。',
    deadline: offsetIso,
    dispatchType: 'manual',
    triggerType: 'manual_flag',
  });
  const data = res && res.json ? res.json.data : null;
  return { assignmentId: data && data.order ? data.order.assignmentId : null, res };
}
/** 建一条"可推送"的交办（诉求 -> 分配责任单位 -> 建交办） */
async function newReadyDispatch(tag) {
  const created = await newComplaint(tag);
  if (created.complaintId === null) throw new Error('新建诉求失败: ' + shortJson(created.res));
  const assigned = await assignEnterprise(created.complaintId);
  if (assigned.status !== 200) throw new Error('分配责任单位失败: ' + shortJson(assigned.json));
  const dispatch = await newDispatch(created.complaintId);
  if (dispatch.assignmentId === null) throw new Error('创建交办失败: ' + shortJson(dispatch.res));
  return { complaintId: created.complaintId, assignmentId: dispatch.assignmentId };
}

function probePayload(requestId, title) {
  return {
    sourceAppCode: APP_CODE,
    sourceBusinessId: 'CPL-G3-ACCEPTANCE',
    requestId,
    sceneCode: 'GQXQ_SENSITIVE_DISPATCH',
    templateCode: 'GQXQ_SENSITIVE_DISPATCH',
    templateVersion: 1,
    title: title || '[G3验收] 协议探针',
    deadline: '2026-09-20T18:00:00+08:00',
    focusFlag: true,
    enterpriseSubjects: [{ subjectCode: 'ENT-WATER-001', subjectName: '宜昌市供水总公司' }],
    prefilledData: { complaintNo: 'CS202609170001' },
    approvalDefinitionCode: 'GQXQ_SUPERVISION_APPROVAL',
    approvalDefinitionVersion: 1,
    callbackPolicy: { subscriptionCode: 'GQXQ_TASK_RESULT', deliveryRequired: true },
    metadata: { probe: true },
  };
}

/** 每项验收依赖的桩模式；--no-mock 时用于说明为什么某些项无法自动覆盖 */
const ITEM_TITLES = [
  ['G3-①', '同一 requestId 多次推送，两系统都只有一个任务（重推返回同一 task.id）'],
  ['G3-②', '篡改 body / 签名 -> 对方 401'],
  ['G3-③', '重用 nonce -> 409 INTEGRATION_REPLAY，且换新 nonce 可成功'],
  ['G3-④', '超时重试不产生第二条任务（同 requestId、同 body、新 nonce）'],
  ['G3-⑤', '响应 task.id 落库可查（dispatch_order 与 dispatch_request_log）'],
  ['G3-⑥', 'organizationCode 会被 422（对方白名单漂移，gqxq 侧必须不发送）'],
  ['G3-⑦', '成功推送后 reporting_status=pushed 且 source_event_status 未被改写'],
  ['G3-⑧', '失败分支 conflict：只 1 次尝试且不改状态与任务号'],
  ['G3-⑨', '失败分支 auth_failed：不可重试且不改状态'],
  ['G3-⑩', '失败分支 replay：换新 nonce 重试成功且两次都留痕'],
  ['G3-⑪', '协议：时间戳超出 ±300s -> 401'],
  ['G3-⑫', '协议：body 超过 1 MiB -> 413 PAYLOAD_TOO_LARGE'],
];

function emitDryRun() {
  for (const [id, title] of ITEM_TITLES) {
    const needsMock = id !== 'G3-①' && id !== 'G3-⑤' && id !== 'G3-⑦';
    emit(id, title, 'MANUAL', [
      '(--dry：未发送任何请求，也未启动桩)',
      '依赖: ' + (needsMock ? '需要桩服务器 ' + MOCK_BASE : '仅需后端 ' + BASE),
    ]);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  console.log('=== G3 验收矩阵执行器 acceptance-g3.mjs ===');
  console.log('接口基址: ' + BASE + (DRY ? '   (--dry)' : ''));
  console.log('桩服务器: ' + MOCK_BASE + '   keyId=' + MOCK_KEY_ID + (NO_MOCK ? '   (--no-mock：不管理桩)' : '   (本脚本按需拉起/重启)'));
  console.log('目标库(仅用于打印清理 SQL): ' + DB_NAME);

  if (DRY) {
    emitDryRun();
    printSummary();
    return 0;
  }

  /* ---------- 预检 ---------- */
  const health = await call('GET', '/health');
  if (health.error !== undefined || health.status !== 200) {
    emit('G3-⓪', '后端就绪', 'FAIL', [
      '无法访问 ' + BASE + '/health：' + (health.error || ('HTTP ' + health.status)),
      '请先按文件头说明启动后端，并把 GQXQ_PU_BASE_URL 指向 ' + MOCK_BASE,
    ]);
    printSummary();
    return 1;
  }

  if (MANAGE_MOCK) {
    startMock([]);
    if (!(await waitMockReady())) {
      emit('G3-⓪', '桩服务器就绪', 'FAIL', ['无法访问 ' + MOCK_BASE + '/health', '可改用 --no-mock 自行启动桩']);
      printSummary();
      return 1;
    }
  } else if (!(await probeMock(1500))) {
    emit('G3-⓪', '桩服务器就绪（--no-mock）', 'FAIL', [
      '桩 ' + MOCK_BASE + ' 不可达，但传了 --no-mock。',
      '请自行启动：node server/scripts/mock-public-utility.mjs --port ' + MOCK_PORT + ' --key-id ' + MOCK_KEY_ID + ' --secret <与后端一致>',
    ]);
    printSummary();
    return 1;
  }

  await login();
  if (!authToken) {
    emit('G3-⓪', '鉴权', 'FAIL', ['未取得令牌（GQXQ_LOGIN_PASSWORD 未设置或登录失败），受保护接口都会 401。']);
    printSummary();
    return 1;
  }

  /* ================= 协议层（桩处于干净模式） ================= */
  console.log('\n--- 协议层：独立重算签名后手工构造请求 ---');

  // G3-② 篡改 body / 签名 -> 401
  await checkG32();

  // G3-⑪ 时间戳超出 ±300s
  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  const staleRes = await callMock(probePayload('PROBE-' + randomUUID()), { timestamp: staleTs });
  emit('G3-⑪', '协议：时间戳超出 ±300s -> 401', staleRes.status === 401 ? 'PASS' : 'FAIL', [
    '用 now-3600s 作为 X-PU-Timestamp（签名按该过期时间戳正确计算）',
    '响应: HTTP ' + staleRes.status + ' code=' + (staleRes.json && staleRes.json.code),
    '判据：对方时间戳容差 ±300 秒，超窗必须 401 INTEGRATION_AUTHENTICATION_FAILED。',
  ]);

  // G3-③ 重用 nonce -> 409 INTEGRATION_REPLAY，换新 nonce 可成功
  const sharedNonce = randomUUID();
  const nonceFirst = await callMock(probePayload('PROBE-' + randomUUID()), { nonce: sharedNonce });
  const nonceSecond = await callMock(probePayload('PROBE-' + randomUUID()), { nonce: sharedNonce });
  const nonceThird = await callMock(probePayload('PROBE-' + randomUUID()));
  const passNonce =
    nonceFirst.status === 200 &&
    nonceSecond.status === 409 && nonceSecond.json && nonceSecond.json.code === 'INTEGRATION_REPLAY' &&
    nonceThird.status === 200;
  emit('G3-③', '重用 nonce -> 409 INTEGRATION_REPLAY，且换新 nonce 可成功', passNonce ? 'PASS' : 'FAIL', [
    '同一 nonce 连发两次 -> HTTP ' + nonceFirst.status + ' / ' + nonceSecond.status +
      '，第二次 code=' + (nonceSecond.json && nonceSecond.json.code),
    '换一个新 nonce 再发 -> HTTP ' + nonceThird.status + '（应恢复成功）',
    '判据：nonce 重放必须被拒；换新 nonce + 新时间戳后可继续，这正是 gqxq 侧的重试策略。',
    '[SQL] SELECT attempt, result, error_code, nonce FROM dispatch_request_log WHERE result = \'replay\' ORDER BY id DESC LIMIT 5;',
  ]);

  // G3-⑥ organizationCode -> 422
  const withOrganization = probePayload('PROBE-' + randomUUID());
  withOrganization.organizationCode = 'ORG-ACCEPTANCE';
  const orgRes = await callMock(withOrganization);
  emit('G3-⑥', 'organizationCode 会被 422（对方白名单漂移，gqxq 侧必须不发送）', orgRes.status === 422 ? 'PASS' : 'FAIL', [
    '在标准 15 字段载荷上多加 organizationCode 后发送',
    '响应: HTTP ' + orgRes.status + ' code=' + (orgRes.json && orgRes.json.code),
    '判据：organizationCode 在对方 DTO（IntegrationTaskRequest）里存在，但不在验签白名单（IntegrationSignatureFilter.TASK_FIELDS）里，',
    '      因此发送必然 422。gqxq 侧由 buildTaskPayload 的白名单断言保证绝不发送该字段。',
    '      同时这也说明：桩与真实对方在这一点上行为一致（都拒），该差异已向对方提缺陷。',
  ]);

  // G3-⑫ body > 1 MiB -> 413
  const oversized = probePayload('PROBE-' + randomUUID());
  oversized.prefilledData = { blob: 'x'.repeat(1_100_000) };
  const oversizedRes = await callMock(oversized);
  emit('G3-⑫', '协议：body 超过 1 MiB -> 413 PAYLOAD_TOO_LARGE', oversizedRes.status === 413 ? 'PASS' : 'FAIL', [
    '构造约 1.1 MiB 的 prefilledData 后发送',
    '响应: HTTP ' + oversizedRes.status + ' code=' + (oversizedRes.json && oversizedRes.json.code),
    '判据：对方 MAX_BODY_BYTES = 1_048_576；gqxq 侧 serializeOnce 也会在本地先拦掉（更早、错误更清楚）。',
  ]);

  /* ================= 端到端（桩仍处于干净模式） ================= */
  console.log('\n--- 端到端：走真实 gqxq API ---');

  const d1 = await newReadyDispatch('主用例');
  const push1 = await call('POST', '/dispatch/orders/' + d1.assignmentId + '/push');
  const push1Data = push1.data || {};
  const firstTaskId = push1Data.taskId;

  // 重推：同 requestId、同 body、新 nonce -> 对方返回首次 task.id
  const repush = await call('POST', '/dispatch/orders/' + d1.assignmentId + '/repush');
  const repushData = repush.data || {};
  const passG1 =
    push1Data.result === 'success' && typeof firstTaskId === 'string' &&
    repushData.result === 'success' && repushData.taskId === firstTaskId;
  emit('G3-①', '同一 requestId 多次推送，两系统都只有一个任务（重推返回同一 task.id）', passG1 ? 'PASS' : 'FAIL', [
    '首次推送: HTTP ' + push1.status + ' result=' + push1Data.result + ' taskId=' + firstTaskId,
    '重推    : HTTP ' + repush.status + ' result=' + repushData.result + ' taskId=' + repushData.taskId,
    '判据：两次返回同一个 task.id，说明对方按 requestId 幂等，没有创建第二个任务。',
    '[SQL] SELECT assignment_id, status, reporting_task_id, pushed_at FROM dispatch_order WHERE assignment_id = \'' + d1.assignmentId + '\';',
  ]);

  // G3-⑤ task.id 落库可查
  const detail1 = await call('GET', '/dispatch/orders/' + d1.assignmentId);
  const detail1Data = detail1.data || {};
  const logs1 = await call('GET', '/dispatch/orders/' + d1.assignmentId + '/push-logs');
  const logs1Data = logs1.data || { content: [], total: 0 };
  const logTaskIds = logs1Data.content.map((row) => row.taskId).filter((value) => value !== null);
  const passG5 =
    detail1Data.reportingTaskId === firstTaskId &&
    detail1Data.status === 'pushed' &&
    detail1Data.pushedAt !== null &&
    logTaskIds.length >= 1 && logTaskIds.every((value) => value === firstTaskId);
  emit('G3-⑤', '响应 task.id 落库可查（dispatch_order 与 dispatch_request_log）', passG5 ? 'PASS' : 'FAIL', [
    'GET /dispatch/orders/:id -> status=' + detail1Data.status + ' reportingTaskId=' + detail1Data.reportingTaskId +
      ' syncStatus=' + detail1Data.syncStatus + ' pushedAt=' + detail1Data.pushedAt,
    '推送日志 ' + logs1Data.total + ' 条，其中 task_id 非空的有 ' + logTaskIds.length + ' 条：' + shortJson(logTaskIds),
    '判据：响应里的 task.id 必须在两处都能查到，而不是只出现在 HTTP 响应里。',
    '[SQL] SELECT assignment_id, reporting_task_id, status FROM dispatch_order WHERE assignment_id = \'' + d1.assignmentId + '\';',
    '[SQL] SELECT attempt, result, task_id, http_status FROM dispatch_request_log WHERE assignment_id = \'' + d1.assignmentId + '\' ORDER BY attempt;',
  ]);

  // G3-⑦ 三轴不互相覆盖
  const complaint1 = await call('GET', '/complaints/' + encodeURIComponent(d1.complaintId));
  const complaint1Data = complaint1.data || {};
  const passG7 =
    complaint1Data.reportingStatusCode === 'pushed' &&
    complaint1Data.sourceEventStatusCode === 'unknown' &&
    complaint1Data.closedInSystem === false;
  emit('G3-⑦', '成功推送后 reporting_status=pushed 且 source_event_status 未被改写', passG7 ? 'PASS' : 'FAIL', [
    'GET /complaints/:id -> reportingStatus=' + complaint1Data.reportingStatusCode +
      ' sourceEventStatus=' + complaint1Data.sourceEventStatusCode +
      ' supervisionStatus=' + complaint1Data.supervisionStatusCode +
      ' closedInSystem=' + complaint1Data.closedInSystem,
    '判据：推送只推进"填报审批状态"这一条轴；来源事件状态（宜接就办，只读快照）必须保持 unknown，本系统办结必须为 false。',
    '[SQL] SELECT complaint_id, reporting_status, source_event_status, supervision_status, closed_in_system FROM complaint WHERE complaint_id = \'' + d1.complaintId + '\';',
  ]);

  /* ================= 失败分支：conflict ================= */
  console.log('\n--- 失败分支：注入 conflict ---');
  const conflictMockOk = MANAGE_MOCK ? await restartMockWith(['--conflict']) : await probeMock(1500);
  if (!conflictMockOk) {
    emit('G3-⑧', '失败分支 conflict：只 1 次尝试且不改状态与任务号', 'FAIL', ['桩不可用或无法按需重启']);
  } else {
    const before = await call('GET', '/dispatch/orders/' + d1.assignmentId);
    const conflictPush = await call('POST', '/dispatch/orders/' + d1.assignmentId + '/push');
    const conflictData = conflictPush.data || {};
    const after = await call('GET', '/dispatch/orders/' + d1.assignmentId);
    const logsAfter = await call('GET', '/dispatch/orders/' + d1.assignmentId + '/push-logs');
    const logsAfterData = logsAfter.data || { content: [], total: 0 };
    const lastLog = logsAfterData.content[logsAfterData.content.length - 1] || {};
    const passG8 =
      conflictData.result === 'conflict' && conflictData.retryable === false && conflictData.httpStatus === 409 &&
      lastLog.result === 'conflict' &&
      after.data.reportingTaskId === (before.data || {}).reportingTaskId &&
      after.data.status === (before.data || {}).status;
    emit('G3-⑧', '失败分支 conflict：只 1 次尝试且不改状态与任务号', passG8 ? 'PASS' : 'FAIL', [
      'POST /push -> result=' + conflictData.result + ' retryable=' + conflictData.retryable +
        ' httpStatus=' + conflictData.httpStatus + ' attempt=' + conflictData.attempt,
      '判据：CONFLICT 不可自动重试 —— 本次只追加 1 条日志（attempt=' + conflictData.attempt + '，',
      '      前两次分别是首次成功推送与幂等重推），日志最后一条就是本次；状态与任务号保持不变。',
      '状态 before/after = ' + (before.data || {}).status + ' / ' + (after.data || {}).status +
        '，任务号 before/after = ' + (before.data || {}).reportingTaskId + ' / ' + (after.data || {}).reportingTaskId,
      '[SQL] SELECT attempt, result, error_code, http_status FROM dispatch_request_log WHERE assignment_id = \'' + d1.assignmentId + '\' ORDER BY attempt;',
    ]);
  }

  /* ================= 失败分支：replay ================= */
  console.log('\n--- 失败分支：注入 replay ---');
  const replayMockOk = MANAGE_MOCK ? await restartMockWith(['--replay-once']) : await probeMock(1500);
  if (!replayMockOk) {
    emit('G3-⑩', '失败分支 replay：换新 nonce 重试成功且两次都留痕', 'FAIL', ['桩不可用或无法按需重启']);
  } else {
    const d2 = await newReadyDispatch('replay');
    const replayPush = await call('POST', '/dispatch/orders/' + d2.assignmentId + '/push');
    const replayData = replayPush.data || {};
    const logs2 = await call('GET', '/dispatch/orders/' + d2.assignmentId + '/push-logs');
    const logs2Data = logs2.data || { content: [], total: 0 };
    const rows = logs2Data.content;
    const passG10 =
      replayData.result === 'success' && replayData.attempt === 2 &&
      logs2Data.total === 2 && rows[0].result === 'replay' && rows[1].result === 'success' &&
      rows[0].nonce !== rows[1].nonce;
    emit('G3-⑩', '失败分支 replay：换新 nonce 重试成功且两次都留痕', passG10 ? 'PASS' : 'FAIL', [
      'POST /push -> result=' + replayData.result + ' attempt=' + replayData.attempt + '（应为 2）',
      '推送日志: ' + rows.map((row) => '#' + row.attempt + '=' + row.result + '/nonce=' + String(row.nonce).slice(0, 8)).join('  '),
      '判据：replay 可自动重试，但必须换新 nonce；两次尝试都要落库。',
      '[SQL] SELECT attempt, result, nonce FROM dispatch_request_log WHERE assignment_id = \'' + d2.assignmentId + '\' ORDER BY attempt;',
    ]);
  }

  /* ================= 失败分支：auth_failed ================= */
  console.log('\n--- 失败分支：注入 auth-fail ---');
  const authMockOk = MANAGE_MOCK ? await restartMockWith(['--auth-fail']) : await probeMock(1500);
  if (!authMockOk) {
    emit('G3-⑨', '失败分支 auth_failed：不可重试且不改状态', 'FAIL', ['桩不可用或无法按需重启']);
  } else {
    const d3 = await newReadyDispatch('authfail');
    const authPush = await call('POST', '/dispatch/orders/' + d3.assignmentId + '/push');
    const authData = authPush.data || {};
    const authDetail = await call('GET', '/dispatch/orders/' + d3.assignmentId);
    const authDetailData = authDetail.data || {};
    const passG9 =
      authData.result === 'auth_failed' && authData.retryable === false && authData.attempt === 1 &&
      authDetailData.status === 'pending' && authDetailData.reportingTaskId === null;
    emit('G3-⑨', '失败分支 auth_failed：不可重试且不改状态', passG9 ? 'PASS' : 'FAIL', [
      'POST /push -> result=' + authData.result + ' retryable=' + authData.retryable + ' attempt=' + authData.attempt,
      '交办状态: status=' + authDetailData.status + ' reportingTaskId=' + authDetailData.reportingTaskId,
      '判据：401 是凭证/时钟问题，盲目重试只会继续 401，所以只尝试 1 次；失败不得推进任何状态（仍 pending，可修好后重推）。',
      '[SQL] SELECT attempt, result, error_code, http_status FROM dispatch_request_log WHERE assignment_id = \'' + d3.assignmentId + '\';',
    ]);
  }

  /* ================= G3-④ 超时重试不产生第二条任务 ================= */
  console.log('\n--- 失败分支：注入 timeout（G3-④） ---');
  const timeoutMockOk = MANAGE_MOCK ? await restartMockWith(['--timeout-once']) : await probeMock(1500);
  if (!timeoutMockOk) {
    emit('G3-④', '超时重试不产生第二条任务（同 requestId、同 body、新 nonce）', 'FAIL', ['桩不可用或无法按需重启']);
  } else {
    const d4 = await newReadyDispatch('timeout');
    const timeoutPush = await call('POST', '/dispatch/orders/' + d4.assignmentId + '/push');
    const timeoutData = timeoutPush.data || {};
    const timeoutTaskId = timeoutData.taskId;
    const logs4 = await call('GET', '/dispatch/orders/' + d4.assignmentId + '/push-logs');
    const logs4Data = logs4.data || { content: [], total: 0 };
    const rows4 = logs4Data.content;
    // 再推一次：如果对方因为超时重试建了第二个任务，这里就会拿到不同的 task.id
    const timeoutRepush = await call('POST', '/dispatch/orders/' + d4.assignmentId + '/repush');
    const timeoutRepushData = timeoutRepush.data || {};
    const passG4 =
      timeoutData.result === 'success' && timeoutData.attempt === 2 &&
      rows4.length === 2 && rows4[0].result === 'timeout' && rows4[1].result === 'success' &&
      rows4[0].nonce !== rows4[1].nonce &&
      timeoutRepushData.taskId === timeoutTaskId;
    emit('G3-④', '超时重试不产生第二条任务（同 requestId、同 body、新 nonce）', passG4 ? 'PASS' : 'FAIL', [
      '第一次请求被桩挂住（客户端超时）-> 换新 nonce + 新时间戳、**同 requestId 同 body** 重试 -> result=' + timeoutData.result + ' attempt=' + timeoutData.attempt,
      '推送日志: ' + rows4.map((row) => '#' + row.attempt + '=' + row.result + '/nonce=' + String(row.nonce).slice(0, 8)).join('  '),
      '重试后再推一次，拿到的 task.id=' + timeoutRepushData.taskId + '，与首次成功的一致吗 = ' + (timeoutRepushData.taskId === timeoutTaskId),
      '判据：超时后**不能新建交办**；重试沿用同一 requestId，所以两系统都只有这一个任务。',
      '[SQL] -- 同 requestId 的两次尝试必须是同一份 body（逐字节），只有 nonce 不同：',
      '[SQL] SELECT request_id, attempt, result, nonce, LENGTH(request_body) AS len, SHA2(request_body,256) AS body_sha',
      '[SQL]   FROM dispatch_request_log WHERE assignment_id = \'' + d4.assignmentId + '\' ORDER BY attempt;',
    ]);
  }

  /* ---------- 清理 SQL ---------- */
  console.log('');
  console.log('=== 本脚本新建的数据（请指向测试库时自行清理）===');
  console.log('[SQL] DELETE FROM dispatch_request_log WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM dispatch_order WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM sensitive_hit WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM complaint_disposition WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM complaint_assignment WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM complaint_field_version WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG3%\');');
  console.log('[SQL] DELETE FROM complaint_source_log WHERE source_id LIKE \'ACCG3%\';');
  console.log('[SQL] DELETE FROM complaint WHERE source_id LIKE \'ACCG3%\';');

  return printSummary();
}

/* ---------------- G3-② 三段断言（拆出来避免主流程过长） ---------------- */
async function checkG32() {
  // 1) 合法签名 —— 必须能过，否则后面的"被拒"证明不了任何事
  const good = await callMock(probePayload('PROBE-' + randomUUID()));
  // 2) 篡改签名 —— 签名字段被改成全 f
  const badSignature = await callMock(probePayload('PROBE-' + randomUUID()), { signature: 'f'.repeat(64) });
  // 3) 篡改 body —— 按 A 算签名，实际发 B（服务端用收到的字节重算，必然对不上）
  const signedPayload = probePayload('PROBE-' + randomUUID(), '[G3验收] 原始载荷');
  const sentPayload = probePayload('PROBE-' + randomUUID(), '[G3验收] 篡改后的载荷');
  const tamperedBody = await callMock(sentPayload, { signUsingPayload: signedPayload });
  const rejected = [badSignature, tamperedBody].every(
    (r) => r.status === 401 && r.json && r.json.code === 'INTEGRATION_AUTHENTICATION_FAILED'
  );
  const pass = good.status === 200 && rejected;
  emit('G3-②', '篡改 body / 签名 -> 对方 401', pass ? 'PASS' : 'FAIL', [
    '合法签名请求      : HTTP ' + good.status + ' created=' + (good.json && good.json.created) + '（必须能过，否则后续判据无意义）',
    '篡改签名请求      : HTTP ' + badSignature.status + ' code=' + (badSignature.json && badSignature.json.code),
    '篡改 body 请求    : HTTP ' + tamperedBody.status + ' code=' + (tamperedBody.json && tamperedBody.json.code) +
      '（签名按 A 计算，实际发送 B）',
    '判据：对方用收到的**原始 body 字节**重算 sha256 并重算 HMAC；签名、body 任何一处不符都必须 401。',
    '说明：签名在此脚本里是**独立实现**（对照对方 HmacRequestAuthenticator），不经被测代码——',
    '      因此"合法能过 + 篡改被拒"才同时证明签名规格理解正确、且桩真在校验。',
  ]);
}

/** 圈码 ⓪①②… -> 序号，用于把汇总按验收项编号排好（localeCompare 会把⑩排到①后面） */
const CIRCLED_INDEX = { '⓪': 0 };
for (let i = 0; i < 20; i += 1) CIRCLED_INDEX[String.fromCodePoint(0x2460 + i)] = i + 1;
function idOrder(id) {
  const mark = id.replace('G3-', '');
  return CIRCLED_INDEX[mark] === undefined ? 999 : CIRCLED_INDEX[mark];
}

function printSummary() {
  const auto = results.filter((r) => r.status !== 'MANUAL');
  const failed = auto.filter((r) => r.status === 'FAIL');
  const sorted = results.slice().sort((a, b) => idOrder(a.id) - idOrder(b.id));
  console.log('');
  console.log('=== 汇总 ===');
  console.log('PASS ' + auto.filter((r) => r.status === 'PASS').length +
    ' / FAIL ' + failed.length +
    ' / MANUAL ' + results.filter((r) => r.status === 'MANUAL').length);
  console.log('逐项: ' + sorted.map((r) => r.id + '=' + r.status).join('  '));
  if (failed.length > 0) console.log('失败项: ' + failed.map((r) => r.id).join(', '));
  return failed.length > 0 ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('执行失败: ' + (err && err.message ? err.message : String(err)));
} finally {
  stopMock();
}
process.exit(exitCode);
