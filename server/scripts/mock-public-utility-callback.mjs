#!/usr/bin/env node
/**
 * public-utility 回调的本地桩。
 *
 * 它按对方 CallbackSignatureService.java / HttpCallbackTransport.java 的规格
 * **独立重实现**签名与投递（刻意不与服务端共用实现：共用代码会把实现里的错误一起掩盖掉），
 * 并把响应体原样打印（含字节长度与十六进制），便于核对 ACK 是否**逐字节**匹配。
 *
 * 签名规格（与宜接就办入站完全不同：没有 v1、没有 method/path/nonce）：
 *   digest    = lowercaseHexSha256(exactBody)
 *   canonical = epochSeconds + "\n" + digest
 *   signature = lowercaseHex(HmacSha256(secretBytes, canonical UTF-8 bytes))
 *
 * 用法：
 *   node server/scripts/mock-public-utility-callback.mjs
 *   ... --repeat              同一 eventId 连发两次，验证幂等与「同一 ACK」
 *   ... --bad-signature       故意签错，验证 401
 *   ... --event-type task_returned --conclusion returned
 *   ... --task-id TASK-1 --source-business-id CPL202606240001
 *   ... --url http://localhost:3210/api/v1/external/public-utility/callback
 *   ... --secret <密钥>       覆盖 GQXQ_CALLBACK_SECRET / server/.env
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'http://localhost:3210/api/v1/external/public-utility/callback';

function parseArgs(argv) {
  const out = { repeat: false, badSignature: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repeat') out.repeat = true;
    else if (a === '--bad-signature') out.badSignature = true;
    else if (a === '--raw-conclusion') out.rawConclusion = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--secret') out.secret = argv[++i];
    else if (a === '--event-type') out.eventType = argv[++i];
    else if (a === '--conclusion') out.conclusion = argv[++i];
    else if (a === '--event-id') out.eventId = argv[++i];
    else if (a === '--task-id') out.taskId = argv[++i];
    else if (a === '--source-business-id') out.sourceBusinessId = argv[++i];
  }
  return out;
}

function readEnvFileSecret() {
  if (process.env.GQXQ_CALLBACK_SECRET) return process.env.GQXQ_CALLBACK_SECRET;
  try {
    const text = readFileSync(join(HERE, '..', '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^GQXQ_CALLBACK_SECRET=(.*)$/.exec(line.trim());
      if (m && m[1] !== '') return m[1];
    }
  } catch {
    /* 没有 .env 时交给上层报错 */
  }
  return '';
}

/* ---------- 签名：独立重实现 ---------- */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sign(secret, epochSeconds, exactBody) {
  const canonical = String(epochSeconds) + '\n' + sha256Hex(exactBody);
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(canonical, 'utf8')).digest('hex');
}

function buildEvent(opts) {
  const now = Date.now();
  return {
    eventId: opts.eventId || 'EVT-MOCK-' + now,
    // 线上契约的枚举是**大写**；服务端会拒绝小写/混合大小写（契约即契约）。
    // --raw-conclusion 用于故意发送不合规大小写，验证服务端确实拒绝。
    eventType: (opts.eventType || 'TASK_SUBMITTED').toUpperCase(),
    sourceAppCode: 'gqxq',
    sourceBusinessId: opts.sourceBusinessId || 'CPL202606240001',
    taskId: opts.taskId || 'TASK-MOCK-001',
    sceneCode: 'GQXQ_SENSITIVE_DISPATCH',
    enterpriseSubject: { subjectCode: 'ENT-WATER-001', subjectName: '宜昌市供水总公司' },
    enterpriseDisposalResult: { summary: '已核实并恢复供水', operator: '王经理' },
    approvalConclusion: opts.rawConclusion
      ? (opts.conclusion || 'agreed')
      : (opts.conclusion || 'AGREED').toUpperCase(),
    templateVersion: 1,
    submissionVersion: 1,
    attachments: [],
    occurredAt: new Date(now).toISOString(),
  };
}

function showResponse(label, res, bodyBuf) {
  console.log('--- ' + label + ' ---');
  console.log('HTTP ' + res.status);
  const ct = res.headers.get('content-type');
  const ra = res.headers.get('retry-after');
  if (ct) console.log('content-type: ' + ct);
  if (ra) console.log('retry-after: ' + ra);
  console.log('body 长度(字节): ' + bodyBuf.length);
  console.log('body 原文: <<<' + bodyBuf.toString('utf8') + '>>>');
  console.log('body hex : ' + bodyBuf.toString('hex'));
}

async function sendOnce(url, event, secret, badSignature) {
  const exactBody = Buffer.from(JSON.stringify(event), 'utf8');
  const epochSeconds = Math.floor(Date.now() / 1000);
  const signature = badSignature
    ? sign(secret + 'x', epochSeconds, exactBody)
    : sign(secret, epochSeconds, exactBody);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Utility-Key-Id': 'dev-callback-key',
      'X-Public-Utility-Key-Version': 'v1',
      'X-Public-Utility-Timestamp': String(epochSeconds),
      'X-Public-Utility-Event-Id': event.eventId,
      'X-Public-Utility-Signature': signature,
    },
    body: exactBody,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, signature, exactBody };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = opts.url || DEFAULT_URL;
  const secret = opts.secret || readEnvFileSecret();
  if (secret === '') {
    console.error('缺少密钥：请设置 GQXQ_CALLBACK_SECRET 或用 --secret 指定');
    process.exitCode = 2;
    return;
  }
  const event = buildEvent(opts);
  console.log('目标: ' + url);
  console.log('eventId: ' + event.eventId + '  eventType: ' + event.eventType + '  结论: ' + event.approvalConclusion);
  console.log('taskId: ' + event.taskId + '  sourceBusinessId: ' + event.sourceBusinessId);
  console.log('密钥长度: ' + secret.length + ' 字节');

  const first = await sendOnce(url, event, secret, opts.badSignature);
  console.log('signature: ' + first.signature);
  console.log('canonical 里的 body sha256: ' + sha256Hex(first.exactBody));
  showResponse(opts.badSignature ? '故意签错' : '第 1 次投递', first.res, first.buf);

  if (opts.repeat) {
    const second = await sendOnce(url, event, secret, opts.badSignature);
    showResponse('第 2 次投递（同一 eventId）', second.res, second.buf);
    const same = first.buf.equals(second.buf);
    console.log('两次响应体是否逐字节相同: ' + same);
    if (!same) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('投递失败: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
