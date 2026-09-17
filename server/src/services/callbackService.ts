// G4 入站：接收 public-utility 的结果事件回传。
//
// 职责：独立验签（算法与入站不同）-> 按 event_id 幂等 -> 推进交办/诉求状态 -> 写审批轨迹与审计
//       -> 按 ackMode 返回**逐字节精确**的 ACK。
//
// 三处高危点，实现时按下面的注释严格执行：
//   1) 签名要对**原始 body 字节**求 sha256（见 clients/callbackSignature.ts 头部说明）。
//   2) ACK：ackMode=BODY 时响应体必须逐字节等于 ackValue，且**不可重试**的 CALLBACK_ACK_INVALID
//      意味着 ACK 配错等于事件被永久丢弃 —— 所以这里绝不 res.json。
//   3) 非法状态转换**不能丢事件**：事件仍要留痕，processed_result 记为 ignored 并写明原因。
//
// 已知契约缺口（落地计划 §3.2 明确标注）：这 4 个事件类型**无法表达"企业签收"**，
// 因此 dispatch_order.status='accepted' 不经由回调到达。这里不自行造事件类型。
import { env } from '../config/env';
import { withTransaction } from '../db/tx';
import { pool } from '../db/pool';
import type { FieldError } from '../http/errors';
import type { ApprovalConclusion, BusinessEventType, CallbackAcceptedResult } from '../types/api';
import { insertAudit } from '../repositories/auditLogRepo';
import {
  findEventById,
  insertBusinessEvent,
  updateEventProcessing,
  type ProcessedResult,
} from '../repositories/businessEventRepo';
import { insertApprovalTrace } from '../repositories/approvalTraceRepo';
import { verifyCallbackSignature, CALLBACK_TIMESTAMP_TOLERANCE_SECONDS } from '../clients/callbackSignature';

/* ==================== 线上枚举 -> 项目口径 ==================== */

/**
 * 线上契约用**大写**枚举，项目内一律**小写**。
 * 这里以小写集合为唯一真源，同时校验原始值确实是大写：
 *   * 严格符合契约（大写才算合法，大小写混用一律按不合规处理）
 *   * 业务代码里不出现大写枚举字面量，与全仓"枚举一律小写"的口径一致
 */
const EVENT_TYPES = ['task_submitted', 'task_approved', 'task_rejected', 'task_returned'] as const;
const CONCLUSIONS = ['agreed', 'disagreed', 'returned'] as const;

type EventType = (typeof EVENT_TYPES)[number];
type Conclusion = (typeof CONCLUSIONS)[number];

function normalizeWireEnum(raw: string, allowed: readonly string[]): string | null {
  if (raw !== raw.toUpperCase()) return null;
  const lower = raw.toLowerCase();
  return allowed.includes(lower) ? lower : null;
}

/* ==================== 事件载荷校验 ==================== */

interface ParsedEvent {
  eventId: string;
  eventType: EventType;
  sourceAppCode: string;
  sourceBusinessId: string;
  taskId: string;
  sceneCode: string;
  subjectCode: string;
  subjectName: string;
  approvalConclusion: Conclusion;
  templateVersion: number;
  submissionVersion: number | null;
  occurredAt: Date;
  approvedAt: Date | null;
}

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/;

function parseOffsetIso(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  // 契约是 date-time（RFC3339），必须带时区偏移；否则无法确定时刻
  if (!OFFSET_SUFFIX.test(text)) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验回传事件。
 * 返回 fieldErrors 而非抛异常，便于把"校验失败"也留痕到 business_event。
 *
 * 关于未知字段：契约是 additionalProperties:false，但这里**不因额外字段拒绝事件**——
 * 回调是对方推给我们的，对方一旦新增字段就静默丢事件，代价远大于宽容；
 * 事件原文整包落 business_event.payload，仍然可审计。
 */
function validateEvent(body: unknown): { ok: true; event: ParsedEvent } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: 'body', message: '请求体必须是单个 JSON 对象' }] };
  }
  const str = (field: string, max: number, required = true): string | null => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors.push({ field, message: '必填' });
      return null;
    }
    if (typeof raw !== 'string') {
      errors.push({ field, message: '必须是字符串' });
      return null;
    }
    if (raw.length > max) {
      errors.push({ field, message: '长度不能超过 ' + max });
      return null;
    }
    return raw;
  };

  const eventId = str('eventId', 128);
  const rawEventType = str('eventType', 64);
  const sourceAppCode = str('sourceAppCode', 64);
  const sourceBusinessId = str('sourceBusinessId', 128);
  const taskId = str('taskId', 128);
  const sceneCode = str('sceneCode', 64);
  const rawConclusion = str('approvalConclusion', 16);

  if (sourceAppCode !== null && !/^[a-z][a-z0-9-]{1,63}$/.test(sourceAppCode)) {
    errors.push({ field: 'sourceAppCode', message: '必须匹配 ^[a-z][a-z0-9-]{1,63}$' });
  }
  if (sceneCode !== null && !/^[A-Z][A-Z0-9_]{1,63}$/.test(sceneCode)) {
    errors.push({ field: 'sceneCode', message: '必须匹配 ^[A-Z][A-Z0-9_]{1,63}$' });
  }

  let eventType: string | null = null;
  if (rawEventType !== null) {
    eventType = normalizeWireEnum(rawEventType, EVENT_TYPES);
    if (eventType === null) {
      errors.push({ field: 'eventType', message: '只允许 ' + EVENT_TYPES.map((t) => t.toUpperCase()).join('/') });
    }
  }
  let conclusion: string | null = null;
  if (rawConclusion !== null) {
    conclusion = normalizeWireEnum(rawConclusion, CONCLUSIONS);
    if (conclusion === null) {
      errors.push({ field: 'approvalConclusion', message: '只允许 ' + CONCLUSIONS.map((c) => c.toUpperCase()).join('/') });
    }
  }

  const subject = body.enterpriseSubject;
  let subjectCode: string | null = null;
  let subjectName: string | null = null;
  if (!isPlainObject(subject)) {
    errors.push({ field: 'enterpriseSubject', message: '必填且必须是对象' });
  } else {
    const sc = subject.subjectCode;
    const sn = subject.subjectName;
    if (typeof sc !== 'string' || sc === '' || sc.length > 128) {
      errors.push({ field: 'enterpriseSubject.subjectCode', message: '必填且长度 1..128' });
    } else subjectCode = sc;
    if (typeof sn !== 'string' || sn === '' || sn.length > 200) {
      errors.push({ field: 'enterpriseSubject.subjectName', message: '必填且长度 1..200' });
    } else subjectName = sn;
  }

  if (!isPlainObject(body.enterpriseDisposalResult)) {
    errors.push({ field: 'enterpriseDisposalResult', message: '必填且必须是对象' });
  }
  if (!Array.isArray(body.attachments)) {
    errors.push({ field: 'attachments', message: '必填且必须是数组' });
  } else {
    (body.attachments as unknown[]).forEach((item, index) => {
      if (!isPlainObject(item)) {
        errors.push({ field: 'attachments[' + index + ']', message: '必须是对象' });
        return;
      }
      if (typeof item.attachmentId !== 'string' || item.attachmentId === '') {
        errors.push({ field: 'attachments[' + index + '].attachmentId', message: '必填' });
      }
      if (typeof item.fileName !== 'string' || item.fileName === '') {
        errors.push({ field: 'attachments[' + index + '].fileName', message: '必填' });
      }
      if (typeof item.contentType !== 'string') {
        errors.push({ field: 'attachments[' + index + '].contentType', message: '必填' });
      }
      if (typeof item.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(item.sha256)) {
        errors.push({ field: 'attachments[' + index + '].sha256', message: '必须是 64 位 hex' });
      }
    });
  }

  const templateVersion = body.templateVersion;
  if (typeof templateVersion !== 'number' || !Number.isInteger(templateVersion) || templateVersion < 1) {
    errors.push({ field: 'templateVersion', message: '必须是 >=1 的整数' });
  }

  let submissionVersion: number | null = null;
  if (body.submissionVersion !== undefined && body.submissionVersion !== null) {
    if (typeof body.submissionVersion !== 'number' || !Number.isInteger(body.submissionVersion) || body.submissionVersion < 1) {
      errors.push({ field: 'submissionVersion', message: '必须是 >=1 的整数' });
    } else submissionVersion = body.submissionVersion;
  }

  const occurredAt = parseOffsetIso(body.occurredAt);
  if (occurredAt === null) {
    errors.push({ field: 'occurredAt', message: '必填，且必须是带时区偏移的 ISO-8601' });
  }
  let approvedAt: Date | null = null;
  if (body.approvedAt !== undefined && body.approvedAt !== null) {
    approvedAt = parseOffsetIso(body.approvedAt);
    if (approvedAt === null) errors.push({ field: 'approvedAt', message: '必须是带时区偏移的 ISO-8601' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    event: {
      eventId: eventId as string,
      eventType: eventType as EventType,
      sourceAppCode: sourceAppCode as string,
      sourceBusinessId: sourceBusinessId as string,
      taskId: taskId as string,
      sceneCode: sceneCode as string,
      subjectCode: subjectCode as string,
      subjectName: subjectName as string,
      approvalConclusion: conclusion as Conclusion,
      templateVersion: templateVersion as number,
      submissionVersion,
      occurredAt: occurredAt as Date,
      approvedAt,
    },
  };
}

/* ==================== ACK ==================== */

export interface AckResolution {
  ok: boolean;
  ackBody: string;
  reason: string | null;
}

/**
 * 解析要返回的 ACK 响应体。
 *
 * ackMode=BODY：响应体必须**逐字节等于**订阅上配置的 ackValue；
 *   对方 CallbackSignatureService 之外的 HttpCallbackTransport.ackMatches 用
 *   MessageDigest.isEqual(ackValue.getBytes(UTF_8), response) 做常量时间比较，
 *   多一个换行/引号/外层 JSON 都会判成 CALLBACK_ACK_INVALID，而且该错误不可重试。
 * ackMode=NONE：对方只看 2xx，不看响应体；仍然返回一个稳定字符串，便于重复投递返回同一 ACK。
 *
 * ACK 长度上限 500 与 business_event.ack_body 列宽一致：超长会在留痕时被截断，
 * 导致重复投递返回的 ACK 与首次不一致 —— 因此直接在解析阶段判为配置错误。
 */
export function resolveAckBody(): AckResolution {
  if (env.callback.ackMode === 'BODY') {
    const value = env.callback.ackValue;
    if (value.length > 500) {
      return { ok: false, ackBody: '', reason: '回调 ACK 配置的 ackValue 超过 500 字节，与 ack_body 列宽不一致' };
    }
    return { ok: true, ackBody: value, reason: null };
  }
  if (env.callback.ackMode !== 'NONE') {
    return { ok: false, ackBody: '', reason: '回调 ACK 配置的 ackMode 只允许 NONE 或 BODY，当前为 ' + env.callback.ackMode };
  }
  return { ok: true, ackBody: env.callback.ackValue === '' ? 'OK' : env.callback.ackValue, reason: null };
}

/* ==================== 状态推进 ==================== */

interface DispatchRef {
  assignmentId: string;
  complaintId: string;
  status: string;
}

interface TransitionPlan {
  kind: 'applied' | 'ignored';
  summary: string;
  reason: string | null;
  toDispatchStatus: string | null;
  toReportingStatus: string | null;
  toSupervisionStatus: string | null;
}

/** 各事件允许的**当前**交办状态。与 domain/enums.ts 的监督状态枚举一致（小写）。 */
const ALLOWED_FROM: Record<EventType, readonly string[]> = {
  task_submitted: ['pushed', 'accepted', 'returned'],
  task_returned: ['processing'],
  task_approved: ['processing', 'returned'],
  task_rejected: ['processing', 'returned'],
};

function planTransition(event: ParsedEvent, current: string): TransitionPlan {
  const allowed = ALLOWED_FROM[event.eventType];
  if (!allowed.includes(current)) {
    return {
      kind: 'ignored',
      summary: '事件未推进状态',
      reason: '交办当前状态为 ' + current + '，不允许按 ' + event.eventType + ' 推进',
      toDispatchStatus: null,
      toReportingStatus: null,
      toSupervisionStatus: null,
    };
  }

  // 拟同意不得越过纠偏直接完成：只有 task_approved 且结论为 agreed 才允许置 completed
  if (event.eventType === 'task_approved' && event.approvalConclusion !== 'agreed') {
    return {
      kind: 'ignored',
      summary: '事件未推进状态',
      reason: 'task_approved 的 approvalConclusion 为 ' + event.approvalConclusion + '，只有 agreed 才允许完成',
      toDispatchStatus: null,
      toReportingStatus: null,
      toSupervisionStatus: null,
    };
  }

  const versionText = event.submissionVersion === null ? '' : '（第 ' + event.submissionVersion + ' 版）';
  switch (event.eventType) {
    case 'task_submitted':
      return {
        kind: 'applied',
        summary: '企业已提交处置结果' + versionText,
        reason: null,
        toDispatchStatus: 'processing',
        toReportingStatus: 'submitted',
        toSupervisionStatus: 'processing',
      };
    case 'task_returned':
      return {
        kind: 'applied',
        summary: '审批退回，待企业补正' + versionText,
        reason: null,
        toDispatchStatus: 'returned',
        toReportingStatus: 'returned',
        toSupervisionStatus: 'returned',
      };
    case 'task_approved':
      return {
        kind: 'applied',
        summary: '最终审批通过（同意），交办完成',
        reason: null,
        toDispatchStatus: 'completed',
        toReportingStatus: 'approved',
        toSupervisionStatus: 'completed',
      };
    case 'task_rejected':
      return {
        kind: 'applied',
        summary: '审批不同意',
        reason: null,
        toDispatchStatus: 'rejected',
        toReportingStatus: 'rejected',
        toSupervisionStatus: 'rejected',
      };
    default:
      return {
        kind: 'ignored',
        summary: '事件未推进状态',
        reason: '未知事件类型 ' + String(event.eventType),
        toDispatchStatus: null,
        toReportingStatus: null,
        toSupervisionStatus: null,
      };
  }
}

/* ==================== 数据库读写 ==================== */

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

/** 先按 task_id（G3 推送成功后回填的 reporting_task_id）找，再退回按 source_business_id 找 */
async function findDispatchRef(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  taskId: string,
  sourceBusinessId: string
): Promise<DispatchRef | null> {
  const [byTask] = (await tx.query(
    'select assignment_id as assignmentId, complaint_id as complaintId, status' +
      ' from dispatch_order where reporting_task_id = ? order by id desc limit 1 for update',
    [taskId]
  )) as [DispatchRef[], unknown];
  if (byTask.length > 0) return byTask[0];

  const [byComplaint] = (await tx.query(
    'select assignment_id as assignmentId, complaint_id as complaintId, status' +
      ' from dispatch_order where complaint_id = ? order by id desc limit 1 for update',
    [sourceBusinessId]
  )) as [DispatchRef[], unknown];
  return byComplaint.length > 0 ? byComplaint[0] : null;
}

/* ==================== 对外入口 ==================== */

export interface CallbackRequestInput {
  rawBody: Buffer;
  keyId: string | null;
  keyVersion: string | null;
  timestamp: string | null;
  headerEventId: string | null;
  signature: string | null;
  remoteIp: string | null;
}

export interface CallbackOutcome {
  /** 建议返回的 HTTP 状态码 */
  status: number;
  /** 2xx 时必须**逐字节**发给对方的响应体 */
  ackBody: string;
  retryAfterSeconds: number | null;
  result: CallbackAcceptedResult | null;
  message: string;
  fieldErrors: FieldError[] | null;
}

/** 审计失败不能掩盖主流程结果：单独吞掉并打日志 */
async function auditBestEffort(entry: Parameters<typeof insertAudit>[1]): Promise<void> {
  try {
    await insertAudit(pool, entry);
  } catch (err) {
    console.error('[callback] 写审计失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

function rejected(
  status: number,
  message: string,
  fieldErrors: FieldError[] | null,
  ackBody: string,
  retryAfterSeconds: number | null = null
): CallbackOutcome {
  return { status, ackBody, retryAfterSeconds, result: null, message, fieldErrors };
}

export async function handleCallback(input: CallbackRequestInput): Promise<CallbackOutcome> {
  const ack = resolveAckBody();
  const now = new Date();

  // ---------- 0) ACK 配置错误：返回 503（可重试），绝不 401 ----------
  // 配置没配好时若返回永久错误，对方就把事件丢了；503 会让它重试到我们修好为止。
  if (!ack.ok) {
    console.error('[callback] ACK 配置错误：' + String(ack.reason));
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_CONFIG_ERROR',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'failed',
      clientIp: input.remoteIp,
      detail: { reason: ack.reason, ackMode: env.callback.ackMode },
      createdAt: now,
    });
    return rejected(503, '回调 ACK 配置错误，请运维检查', null, '', 60);
  }

  // ---------- 1) 凭证未配置：同样返回 503 而不是 401 ----------
  if (env.callback.secret === '') {
    console.error('[callback] 未配置 GQXQ_CALLBACK_SECRET，无法验签');
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_CONFIG_ERROR',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'failed',
      clientIp: input.remoteIp,
      detail: { reason: 'missing callback secret' },
      createdAt: now,
    });
    return rejected(503, '回调凭证未配置，请运维检查', null, '', 60);
  }

  // ---------- 2) 请求头齐备 ----------
  const missingHeaders: string[] = [];
  if (!input.keyId) missingHeaders.push('X-Public-Utility-Key-Id');
  if (!input.keyVersion) missingHeaders.push('X-Public-Utility-Key-Version');
  if (!input.timestamp) missingHeaders.push('X-Public-Utility-Timestamp');
  if (!input.headerEventId) missingHeaders.push('X-Public-Utility-Event-Id');
  if (!input.signature) missingHeaders.push('X-Public-Utility-Signature');
  if (missingHeaders.length > 0) {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_AUTH_FAILED',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: { reason: 'missing_headers', missing: missingHeaders },
      createdAt: now,
    });
    return rejected(401, '缺少回调鉴权请求头：' + missingHeaders.join(', '), null, ack.ackBody);
  }

  // ---------- 3) 时间戳必须能解析成整数秒（签名依赖它） ----------
  const timestampText = String(input.timestamp).trim();
  const epochSeconds = /^\d{1,15}$/.test(timestampText) ? Number(timestampText) : Number.NaN;
  if (!Number.isFinite(epochSeconds)) {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_AUTH_FAILED',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: { reason: 'timestamp_malformed', timestamp: timestampText.slice(0, 32) },
      createdAt: now,
    });
    return rejected(401, '回调时间戳格式非法', null, ack.ackBody);
  }

  // ---------- 4) 独立验签（算法与入站不同，见 clients/callbackSignature.ts） ----------
  const checked = verifyCallbackSignature(env.callback.secret, epochSeconds, input.rawBody, String(input.signature));
  if (!checked.ok) {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_AUTH_FAILED',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: {
        reason: checked.reason,
        keyId: input.keyId,
        bodyBytes: input.rawBody.length,
      },
      createdAt: now,
    });
    return rejected(401, '回调签名校验失败', null, ack.ackBody);
  }

  // ---------- 5) 解析 JSON（验签之后才解析，未验签的内容一律不采信） ----------
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_REJECTED',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: { reason: 'malformed_json' },
      createdAt: now,
    });
    return rejected(400, '请求体不是合法 JSON', null, ack.ackBody);
  }

  const bodyEventId =
    isPlainObject(parsedBody) && typeof parsedBody.eventId === 'string' && parsedBody.eventId !== ''
      ? parsedBody.eventId
      : null;
  // 请求头里的 eventId 是投递幂等键；请求体里的必须一致，不一致说明报文被拼装过
  const eventId = bodyEventId;
  if (eventId === null) {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_REJECTED',
      bizType: 'business_event',
      bizId: input.headerEventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: { reason: 'missing_body_event_id' },
      createdAt: now,
    });
    return rejected(400, '事件缺少 eventId', [{ field: 'eventId', message: '必填' }], ack.ackBody);
  }
  const headerMismatch = input.headerEventId !== eventId;

  // ---------- 6) 幂等：已处理过就直接返回同一 ACK，不改任何业务状态 ----------
  const existing = await findEventById(pool, eventId);
  if (existing !== null) {
    const storedAck = existing.ackBody !== null && existing.ackBody !== '' ? existing.ackBody : ack.ackBody;
    const drift = storedAck !== ack.ackBody;

    // 首次投递就被判为非法报文（processed_result=rejected）：重复投递必须返回**同样的拒绝**。
    // 这里曾经返回 200 + ACK —— 那会让发送方以为这次成功了，而这条被拒事件永远不会被人工处理，
    // 两条投递的结论互相矛盾。eventId 是事件身份，报文修正后应当换新 eventId。
    if (existing.processedResult === 'rejected') {
      await auditBestEffort({
        userId: null,
        appCode: 'public-utility',
        resourceCode: null,
        action: 'CALLBACK_DUPLICATE',
        bizType: 'business_event',
        bizId: existing.sourceBusinessId,
        result: 'rejected',
        clientIp: input.remoteIp,
        detail: { eventId, previousProcessedResult: 'rejected' },
        createdAt: now,
      });
      return rejected(
        400,
        '事件此前已被判为非法报文并留痕，重复投递返回同一结论：' + (existing.processedMessage ?? ''),
        null,
        storedAck
      );
    }

    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_DUPLICATE',
      bizType: 'business_event',
      bizId: existing.sourceBusinessId,
      result: 'duplicate',
      clientIp: input.remoteIp,
      detail: { eventId, eventType: existing.eventType, ackDrift: drift },
      createdAt: now,
    });
    return {
      status: 200,
      ackBody: storedAck,
      retryAfterSeconds: null,
      result: {
        eventId,
        accepted: true,
        duplicate: true,
        processedResult: 'duplicate',
        eventType: existing.eventType as BusinessEventType,
        message: '事件已处理过，返回首次的 ACK' + (drift ? '（注意：当前 ACK 配置与首次不同）' : ''),
      },
      message: 'duplicate',
      fieldErrors: null,
    };
  }

  // ---------- 7) 时间戳窗口：签名有效但过旧 -> 503（可重试），绝不 401 ----------
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const skew = Math.abs(nowSeconds - epochSeconds);
  if (skew > CALLBACK_TIMESTAMP_TOLERANCE_SECONDS) {
    await auditBestEffort({
      userId: null,
      appCode: 'public-utility',
      resourceCode: null,
      action: 'CALLBACK_AUTH_FAILED',
      bizType: 'business_event',
      bizId: eventId,
      result: 'rejected',
      clientIp: input.remoteIp,
      detail: { reason: 'timestamp_out_of_window', skewSeconds: skew, tolerance: CALLBACK_TIMESTAMP_TOLERANCE_SECONDS },
      createdAt: now,
    });
    return rejected(
      503,
      '回调时间戳超出允许偏差（' + skew + 's > ' + CALLBACK_TIMESTAMP_TOLERANCE_SECONDS + 's），已按可重试处理',
      null,
      ack.ackBody,
      30
    );
  }

  // ---------- 8) 载荷校验：不合法也要留痕（processed_result=rejected） ----------
  const validated = validateEvent(parsedBody);
  if (!validated.ok) {
    try {
      await withTransaction(async (tx) => {
        await insertBusinessEvent(tx, {
          eventId,
          eventType: 'unknown',
          sourceAppCode: null,
          sourceBusinessId: null,
          taskId: null,
          sceneCode: null,
          subjectCode: null,
          subjectName: null,
          approvalConclusion: null,
          templateVersion: null,
          submissionVersion: null,
          occurredAt: null,
          approvedAt: null,
          payload: parsedBody as Record<string, unknown>,
          signatureKeyId: input.keyId,
          signatureKeyVersion: input.keyVersion,
          processedResult: 'rejected',
          processedMessage: '报文校验失败',
          ackBody: null,
          receivedAt: now,
        });
        await insertAudit(tx, {
          userId: null,
          appCode: 'public-utility',
          resourceCode: null,
          action: 'CALLBACK_REJECTED',
          bizType: 'business_event',
          bizId: eventId,
          result: 'rejected',
          clientIp: input.remoteIp,
          detail: { fieldErrors: validated.errors },
          createdAt: now,
        });
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // 并发下另一路已经写了这一事件：按重复投递处理
      const raced = await findEventById(pool, eventId);
      if (raced !== null) {
        return {
          status: 200,
          ackBody: raced.ackBody !== null && raced.ackBody !== '' ? raced.ackBody : ack.ackBody,
          retryAfterSeconds: null,
          result: { eventId, accepted: true, duplicate: true, processedResult: 'duplicate', eventType: null, message: '并发重复投递' },
          message: 'duplicate',
          fieldErrors: null,
        };
      }
    }
    return rejected(400, '回传事件校验失败', validated.errors, ack.ackBody);
  }

  const event = validated.event;

  // ---------- 9) 处理事件（事件行先插入占位 eventId，再在同一事务内落真实结果） ----------
  try {
    const outcome = await withTransaction(async (tx) => {
      // 9a) 抢占 eventId：并发重复投递会在任何业务状态变更之前被唯一键拦下
      await insertBusinessEvent(tx, {
        eventId,
        eventType: event.eventType,
        sourceAppCode: event.sourceAppCode,
        sourceBusinessId: event.sourceBusinessId,
        taskId: event.taskId,
        sceneCode: event.sceneCode,
        subjectCode: event.subjectCode,
        subjectName: event.subjectName,
        approvalConclusion: event.approvalConclusion,
        templateVersion: event.templateVersion,
        submissionVersion: event.submissionVersion,
        occurredAt: event.occurredAt,
        approvedAt: event.approvedAt,
        payload: parsedBody as Record<string, unknown>,
        signatureKeyId: input.keyId,
        signatureKeyVersion: input.keyVersion,
        processedResult: 'ignored', // 占位，下面覆盖；事务回滚不会留下这行
        processedMessage: null,
        ackBody: ack.ackBody,
        receivedAt: now,
      });

      // 9b) 匹配交办
      const ref = await findDispatchRef(tx, event.taskId, event.sourceBusinessId);
      if (ref === null) {
        const message = '未匹配到交办：reporting_task_id 与 complaint_id 都没有命中';
        await updateEventProcessing(tx, eventId, 'ignored', message);
        await insertAudit(tx, {
          userId: null,
          appCode: 'public-utility',
          resourceCode: null,
          action: 'CALLBACK_IGNORED',
          bizType: 'business_event',
          bizId: event.sourceBusinessId,
          result: 'success',
          clientIp: input.remoteIp,
          detail: { eventId, eventType: event.eventType, taskId: event.taskId, reason: 'dispatch_not_found' },
          createdAt: now,
        });
        return {
          processedResult: 'ignored' as ProcessedResult,
          message,
          eventType: event.eventType as BusinessEventType,
        };
      }

      // 9c) 计算并推进状态
      const plan = planTransition(event, ref.status);
      let processedResult: ProcessedResult = 'ignored';
      if (plan.kind === 'applied' && plan.toDispatchStatus !== null) {
        await tx.execute(
          'update dispatch_order set status = ?, updated_at = ? where assignment_id = ?',
          [plan.toDispatchStatus, now, ref.assignmentId]
        );
        await tx.execute(
          'update complaint set reporting_status = ?, supervision_status = ?, updated_at = ? where complaint_id = ?',
          [plan.toReportingStatus, plan.toSupervisionStatus, now, ref.complaintId]
        );
        processedResult = 'applied';
      }
      await updateEventProcessing(tx, eventId, processedResult, plan.reason ?? plan.summary);

      // 9d) 审批轨迹（匹配到交办才写）
      await insertApprovalTrace(tx, {
        complaintId: ref.complaintId,
        assignmentId: ref.assignmentId,
        taskId: event.taskId,
        eventId,
        eventType: event.eventType,
        approvalConclusion: event.approvalConclusion,
        submissionVersion: event.submissionVersion,
        actorName: event.subjectName,
        occurredAt: event.occurredAt,
        summary: plan.summary,
        detail: {
          dispatchStatusBefore: ref.status,
          dispatchStatusAfter: plan.toDispatchStatus,
          reportingStatusAfter: plan.toReportingStatus,
          reason: plan.reason,
          approvalHistory: isPlainObject(parsedBody) ? parsedBody.approvalHistory ?? null : null,
          attachmentCount: isPlainObject(parsedBody) && Array.isArray(parsedBody.attachments) ? parsedBody.attachments.length : 0,
        },
        createdAt: now,
      });

      // 9e) 审计
      const auditBase = {
        userId: null,
        appCode: 'public-utility',
        resourceCode: ref.assignmentId,
        bizType: 'dispatch_order',
        bizId: ref.complaintId,
        clientIp: input.remoteIp,
        detail: {
          eventId,
          eventType: event.eventType,
          approvalConclusion: event.approvalConclusion,
          dispatchStatusBefore: ref.status,
          dispatchStatusAfter: plan.toDispatchStatus,
          taskId: event.taskId,
          reason: plan.reason,
        },
        createdAt: now,
      };
      if (processedResult === 'applied') {
        await insertAudit(tx, { ...auditBase, action: 'CALLBACK_APPLIED', result: 'success' });
      } else {
        await insertAudit(tx, { ...auditBase, action: 'CALLBACK_IGNORED', result: 'rejected' });
      }

      return {
        processedResult,
        message: plan.reason ?? plan.summary,
        eventType: event.eventType as BusinessEventType,
      };
    });

    const notice = headerMismatch ? '（注意：请求头 eventId 与报文 eventId 不一致）' : '';
    return {
      status: 200,
      ackBody: ack.ackBody,
      retryAfterSeconds: null,
      result: {
        eventId,
        accepted: true,
        duplicate: false,
        processedResult: outcome.processedResult,
        eventType: outcome.eventType,
        message: outcome.message + notice,
      },
      message: outcome.processedResult,
      fieldErrors: null,
    };
  } catch (err) {
    // 并发重复投递：唯一键兜底，回读并返回同一 ACK（不要把 500 抛给调用方）
    if (isDuplicateKey(err)) {
      const raced = await findEventById(pool, eventId);
      if (raced !== null) {
        return {
          status: 200,
          ackBody: raced.ackBody !== null && raced.ackBody !== '' ? raced.ackBody : ack.ackBody,
          retryAfterSeconds: null,
          result: {
            eventId,
            accepted: true,
            duplicate: true,
            processedResult: 'duplicate',
            eventType: raced.eventType as BusinessEventType,
            message: '并发重复投递，返回首次的 ACK',
          },
          message: 'duplicate',
          fieldErrors: null,
        };
      }
    }
    throw err;
  }
}
