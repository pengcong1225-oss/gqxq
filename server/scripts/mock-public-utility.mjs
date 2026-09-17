#!/usr/bin/env node
/**
 * public-utility 本地桩服务器（G3 联调用）。
 *
 * 为什么必须真校验签名：
 *   本文件的核心价值不是"返回 200"，而是**按对方源码逐字重算签名与时间戳**。
 *   如果桩只是假装成功，那"签名写对了没有""bodySha256 是不是对实际发送字节求的哈希"
 *   这两个最容易错的点就完全测不出来——而这正是 G3 联调失败的头号原因。
 *   因此这里拿到的**原始字节**直接参与校验，绝不重新序列化请求体。
 *
 * 对照实现（对方源码）：
 *   HmacRequestAuthenticator.sign / sha256
 *   IntegrationSignatureFilter（路径、请求头、1 MiB、15 字段白名单、401/413/422/409）
 *   GqxqSensitiveAssignmentAdapter（sceneCode -> created/disposition）
 *   IntegrationAppService.authenticate（requestId 幂等 -> CONFLICT；nonce 唯一 -> INTEGRATION_REPLAY）
 *
 * 用法：
 *   node server/scripts/mock-public-utility.mjs [--port 8099] [--secret dev-secret] [--key-id dev-key]
 *     --replay-once | --replay            首个/所有请求回 409 INTEGRATION_REPLAY
 *     --conflict-once | --conflict         首个/所有请求回 409 CONFLICT
 *     --timeout-once | --timeout           首个/所有请求直接挂住不响应（测超时）
 *     --auth-fail-once | --auth-fail       首个/所有请求回 401 INTEGRATION_AUTHENTICATION_FAILED
 *     --skew <seconds>                     时间戳校验窗口（默认 300，可调小以测时钟偏移）
 */
import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const PORT = Number(valueOf('--port', '8099'));
const APP_CODE = valueOf('--app', 'gqxq');
const SECRET = valueOf('--secret', 'dev-secret');
const KEY_ID = valueOf('--key-id', 'dev-key');
const SKEW_SECONDS = Number(valueOf('--skew', '300'));

const MAX_BODY_BYTES = 1_048_576;
const TASK_FIELDS = new Set([
  'sourceAppCode', 'sourceBusinessId', 'requestId', 'sceneCode', 'templateCode', 'templateVersion',
  'title', 'deadline', 'focusFlag', 'enterpriseSubjects', 'prefilledData',
  'approvalDefinitionCode', 'approvalDefinitionVersion', 'callbackPolicy', 'metadata',
]);
const SUBJECT_FIELDS = new Set(['subjectCode', 'subjectName', 'contactUserCode', 'contactUserName']);
const CALLBACK_FIELDS = new Set(['subscriptionCode', 'deliveryRequired']);
const PATH_PATTERN = new RegExp('^/api/integrations/(' + APP_CODE + ')/tasks$');
const SCENE_SENSITIVE = 'GQXQ_SENSITIVE_DISPATCH';

/* ---------------- 故障注入 ---------------- */
function faultMode(base) {
  if (has(base + '-once')) return 'once';
  if (has(base)) return 'always';
  return null;
}
const faults = {
  replay: faultMode('--replay'),
  conflict: faultMode('--conflict'),
  timeout: faultMode('--timeout'),
  authFail: faultMode('--auth-fail'),
};
function faultActive(name) {
  const mode = faults[name];
  if (mode === null) return false;
  if (mode === 'once') faults[name] = null;
  return true;
}

/* ---------------- 状态 ---------------- */
const usedNonces = new Set();
/** requestId -> { bodySha256, taskId, payload } */
const requestStore = new Map();
/** taskId -> task 对象 */
const taskStore = new Map();
let nextTaskId = 9001;

/* ---------------- 工具 ---------------- */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function sign(secret, method, path, timestamp, nonce, bodySha256) {
  const canonical = ['v1', method.toUpperCase(), path, timestamp, nonce, bodySha256].join('\n');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(canonical, 'utf8')).digest('hex');
}
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
function apiError(res, status, code, message) {
  sendJson(res, status, {
    code,
    message,
    requestId: randomUUID(),
    fieldErrors: {},
    timestamp: new Date().toISOString(),
  });
}
/**
 * 读原始请求体；超过 1 MiB 返回 null。
 * 注意：超限时**不能**立刻 destroy——那样客户端看到的是 ECONNRESET 而不是 413。
 * 必须把剩余字节读完（丢弃）再回应，才能让对方拿到明确的 PAYLOAD_TOO_LARGE。
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------- 载荷校验（对照 IntegrationSignatureFilter + IntegrationTaskRequest） ---------------- */
function onlyFields(object, allowed) {
  return Object.keys(object).every((key) => allowed.has(key));
}
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validatePayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body 必须是单个 JSON 对象';
  if (!onlyFields(body, TASK_FIELDS)) {
    const extra = Object.keys(body).filter((key) => !TASK_FIELDS.has(key));
    return '白名单外字段：' + extra.join(', ');
  }
  for (const field of ['sourceAppCode', 'sourceBusinessId', 'requestId', 'sceneCode', 'templateCode', 'title', 'deadline']) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') return field + ' 必填且必须是非空字符串';
  }
  if (!Number.isInteger(body.templateVersion) || body.templateVersion < 1) return 'templateVersion 必须是 >=1 的整数';
  if (typeof body.focusFlag !== 'boolean') return 'focusFlag 必须是布尔值';
  if (typeof body.prefilledData !== 'object' || body.prefilledData === null || Array.isArray(body.prefilledData)) {
    return 'prefilledData 必填且必须是对象';
  }
  if (!Array.isArray(body.enterpriseSubjects) || body.enterpriseSubjects.length < 1) {
    return 'enterpriseSubjects 至少 1 项';
  }
  for (const subject of body.enterpriseSubjects) {
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return 'enterpriseSubjects[] 必须是对象';
    if (!onlyFields(subject, SUBJECT_FIELDS)) return 'enterpriseSubjects[] 含白名单外字段';
    if (typeof subject.subjectCode !== 'string' || subject.subjectCode === '') return 'subjectCode 必填';
    if (typeof subject.subjectName !== 'string' || subject.subjectName === '') return 'subjectName 必填';
  }
  if (body.callbackPolicy !== undefined && body.callbackPolicy !== null) {
    if (typeof body.callbackPolicy !== 'object' || Array.isArray(body.callbackPolicy)) return 'callbackPolicy 必须是对象';
    if (!onlyFields(body.callbackPolicy, CALLBACK_FIELDS)) return 'callbackPolicy 含白名单外字段';
  }
  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
    return 'metadata 必须是对象';
  }
  if (!OFFSET_ISO.test(body.deadline)) return 'deadline 必须是带时区偏移的 ISO-8601';
  if (body.title.length > 200) return 'title 超过 200 字符';
  return null;
}

/* ---------------- 请求处理 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const tag = req.method + ' ' + path;

  // 健康探针：仅供联调编排用，**不参与故障注入**。
  // 否则一个就绪探测就可能把 --timeout-once 这种一次性故障提前用掉，
  // 让后续真正的推送测不到该分支（这是本桩第一版真实踩到的坑）。
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'UP' });
    return;
  }

  const matched = PATH_PATTERN.exec(path);
  if (req.method !== 'POST' || matched === null) {
    console.log('[mock-pu] ' + tag + ' -> 401 (路径或方法不合法)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }

  // 故障注入放在路径/方法校验之后：非任务请求不会消耗一次性故障
  if (faultActive('authFail')) {
    console.log('[mock-pu] ' + tag + ' -> 401 (注入 auth-fail)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }
  if (faultActive('timeout')) {
    console.log('[mock-pu] ' + tag + ' -> 挂住不响应 (注入 timeout)');
    return; // 故意不响应，让客户端超时
  }

  const keyId = req.headers['x-pu-key-id'];
  const timestamp = req.headers['x-pu-timestamp'];
  const nonce = req.headers['x-pu-nonce'];
  const signature = req.headers['x-pu-signature'];
  if (!keyId || !timestamp || !nonce || !signature || keyId !== KEY_ID) {
    console.log('[mock-pu] ' + tag + ' -> 401 (请求头缺失或 keyId 不匹配)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }

  const rawBody = await readRawBody(req);
  if (rawBody === null) {
    console.log('[mock-pu] ' + tag + ' -> 413');
    apiError(res, 413, 'PAYLOAD_TOO_LARGE', 'Integration request body is too large');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.log('[mock-pu] ' + tag + ' -> 422 (JSON 解析失败)');
    apiError(res, 422, 'VALIDATION_FAILED', 'Malformed or missing JSON request body');
    return;
  }

  const problem = validatePayload(parsed);
  if (problem !== null) {
    console.log('[mock-pu] ' + tag + ' -> 422 (' + problem + ')');
    apiError(res, 422, 'VALIDATION_FAILED', 'Malformed or missing JSON request body');
    return;
  }

  if (parsed.sourceAppCode !== matched[1]) {
    console.log('[mock-pu] ' + tag + ' -> 401 (路径 {app} 与 body.sourceAppCode 不一致)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }

  // 关键：用**收到的原始字节**重算 bodySha256，再重算签名做常量时间比对
  const bodySha256 = sha256Hex(rawBody);
  const expected = sign(SECRET, req.method, path, String(timestamp), String(nonce), bodySha256);
  const signatureOk =
    Buffer.from(expected, 'utf8').length === Buffer.from(String(signature), 'utf8').length &&
    createHash('sha256').update(expected).digest('hex') ===
      createHash('sha256').update(String(signature)).digest('hex');
  if (!signatureOk) {
    console.log('[mock-pu] ' + tag + ' -> 401 (签名不匹配；bodySha256=' + bodySha256.slice(0, 12) + '…)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }

  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > SKEW_SECONDS) {
    console.log('[mock-pu] ' + tag + ' -> 401 (时间戳偏差 ' + String(skew) + 's > ' + SKEW_SECONDS + 's)');
    apiError(res, 401, 'INTEGRATION_AUTHENTICATION_FAILED', 'Integration authentication failed');
    return;
  }

  if (faultActive('replay')) {
    console.log('[mock-pu] ' + tag + ' -> 409 INTEGRATION_REPLAY (注入 replay)');
    apiError(res, 409, 'INTEGRATION_REPLAY', 'Integration request nonce has already been used');
    return;
  }
  if (faultActive('conflict')) {
    console.log('[mock-pu] ' + tag + ' -> 409 CONFLICT (注入 conflict)');
    apiError(res, 409, 'CONFLICT', 'Request conflicts with current state');
    return;
  }

  // requestId 幂等：先判载荷冲突，再判 nonce 重放（与对方 authenticate 的顺序一致）
  const existing = requestStore.get(parsed.requestId);
  let firstSeen = true;
  if (existing !== undefined) {
    if (existing.bodySha256 !== bodySha256) {
      console.log('[mock-pu] ' + tag + ' -> 409 CONFLICT (同 requestId 但 body 不同)');
      apiError(res, 409, 'CONFLICT', 'Request conflicts with current state');
      return;
    }
    firstSeen = false;
  }

  if (usedNonces.has(String(nonce))) {
    console.log('[mock-pu] ' + tag + ' -> 409 INTEGRATION_REPLAY (nonce 已用过)');
    apiError(res, 409, 'INTEGRATION_REPLAY', 'Integration request nonce has already been used');
    return;
  }
  usedNonces.add(String(nonce));

  if (parsed.sceneCode !== SCENE_SENSITIVE) {
    // 普通诉求不应调用本接口；对方按"只在 gqxq 自行归档"返回
    requestStore.set(parsed.requestId, { bodySha256, taskId: null, payload: parsed });
    console.log('[mock-pu] ' + tag + ' -> 200 created=false ARCHIVE_ONLY_IN_GQXQ');
    sendJson(res, 200, { created: false, disposition: 'ARCHIVE_ONLY_IN_GQXQ', task: null });
    return;
  }

  if (!firstSeen) {
    const task = taskStore.get(existing.taskId);
    console.log('[mock-pu] ' + tag + ' -> 200 幂等命中，返回首次 task.id=' + String(existing.taskId));
    sendJson(res, 200, { created: true, disposition: 'SENSITIVE_ASSIGNMENT', task });
    return;
  }

  const taskId = nextTaskId;
  nextTaskId += 1;
  const task = {
    id: taskId,
    sourceAppCode: parsed.sourceAppCode,
    sourceBusinessId: parsed.sourceBusinessId,
    requestId: parsed.requestId,
    sceneCode: parsed.sceneCode,
    templateCode: parsed.templateCode,
    templateVersion: parsed.templateVersion,
    title: parsed.title,
    deadline: parsed.deadline,
    focusFlag: parsed.focusFlag,
    status: 'PENDING',
    prefilledData: parsed.prefilledData,
    items: parsed.enterpriseSubjects.map((subject, index) => ({
      id: taskId * 10 + index + 1,
      subjectId: index + 1,
      subjectCode: subject.subjectCode,
      subjectName: subject.subjectName,
      formInstanceId: taskId * 100 + index + 1,
      status: 'PENDING',
    })),
  };
  taskStore.set(taskId, task);
  requestStore.set(parsed.requestId, { bodySha256, taskId, payload: parsed });
  console.log('[mock-pu] ' + tag + ' -> 200 created=true task.id=' + String(taskId) + ' 企业=' + parsed.enterpriseSubjects[0].subjectCode);
  sendJson(res, 200, { created: true, disposition: 'SENSITIVE_ASSIGNMENT', task });
});

server.listen(PORT, () => {
  console.log('[mock-pu] public-utility 桩已启动: http://localhost:' + PORT);
  console.log('[mock-pu] 路径: /api/integrations/' + APP_CODE + '/tasks    keyId=' + KEY_ID + '   时间戳窗口=±' + SKEW_SECONDS + 's');
  const active = Object.entries(faults).filter(([, mode]) => mode !== null);
  console.log('[mock-pu] 故障注入: ' + (active.length === 0 ? '(无)' : active.map(([n, m]) => n + '=' + m).join(', ')));
});
