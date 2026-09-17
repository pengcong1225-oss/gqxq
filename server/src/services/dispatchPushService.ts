// G3 出站：把敏感交办推送为 public-utility 的填报任务。
//
// 幂等与重试语义（摘自落地计划 §3.1，逐条落实）：
//   同 requestId + 完全相同 body -> 对方 200 且返回**首次**的 task.id -> 视为成功，登记本地 taskId
//   同 requestId + 不同 body      -> 409 CONFLICT -> **不可自动重试**，转人工
//   同 nonce 重放                 -> 409 INTEGRATION_REPLAY -> 换**新 nonce + 新时间戳**重试
//   网络超时                      -> 结果未知 -> 用同 requestId、**同 body**、新 nonce、新时间戳重试，绝不新建交办
//
// 因此本文件的重试循环**只有一处序列化**：serializeOnce 得到的 bodyBytes 被所有尝试复用，
// 每次尝试只换 nonce 与时间戳。这是"同 requestId + 完全相同 body"能命中对方幂等分支的前提。
import { AppError } from '../http/errors';
import type { DispatchRequestLogItem, PushDispatchResult, PushResultKind } from '../types/api';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { cut } from '../repositories/complaintSourceLogRepo';
import {
  assertPuCredentials,
  buildAttempt,
  integrationTaskPath,
  postIntegrationTask,
  serializeOnce,
  type PuTransportOutcome,
} from '../clients/publicUtilityClient';
import { findOrderByAssignmentId } from '../repositories/dispatchRepo';
import { findRequestLogsByAssignment, insertRequestLog } from '../repositories/dispatchRequestLogRepo';
import {
  markDispatchPushed,
  preparePush,
  recordPushFailure,
  type OperatorContext,
  type PushPreparation,
} from './dispatchService';

/** 对方 IntegrationSignatureFilter.TASK_FIELDS —— 顶层只接受这 15 个字段，多一个即 422 */
export const PU_TASK_FIELDS = [
  'sourceAppCode',
  'sourceBusinessId',
  'requestId',
  'sceneCode',
  'templateCode',
  'templateVersion',
  'title',
  'deadline',
  'focusFlag',
  'enterpriseSubjects',
  'prefilledData',
  'approvalDefinitionCode',
  'approvalDefinitionVersion',
  'callbackPolicy',
  'metadata',
] as const;

const SCENE_SENSITIVE_DISPATCH = 'GQXQ_SENSITIVE_DISPATCH';
const TEMPLATE_CODE = 'GQXQ_SENSITIVE_DISPATCH';
const TEMPLATE_VERSION = 1;
const APPROVAL_DEFINITION_CODE = 'GQXQ_SUPERVISION_APPROVAL';
const APPROVAL_DEFINITION_VERSION = 1;
const CALLBACK_SUBSCRIPTION_CODE = 'GQXQ_TASK_RESULT';

/**
 * 单次调用的最大尝试次数。
 * 只对 retryable 的结果（replay / timeout / network_error / 5xx）继续换 nonce 重试；
 * conflict / auth_failed / payload_too_large / validation_failed 一次即止，靠人工处理。
 */
const MAX_PUSH_ATTEMPTS = 3;

/**
 * 库里的 datetime 存的是 Asia/Shanghai 墙钟，连接池把它读成对应时刻的 Date。
 * 这里还原成**带 +08:00 偏移**的 ISO-8601 —— 对方用 OffsetDateTime.parse 解析，缺偏移会 422。
 */
export function toOffsetIso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

/**
 * 构造 15 字段载荷。
 * 刻意**不发送 organizationCode**：它在对方 DTO（IntegrationTaskRequest）里存在，
 * 但不在验签过滤器的白名单里，发出去会被 422。这是对方的 DTO 与白名单漂移，gqxq 侧规避。
 */
export function buildTaskPayload(prep: PushPreparation): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sourceAppCode: env.pu.appCode,
    sourceBusinessId: prep.complaintId,
    requestId: prep.requestId,
    sceneCode: SCENE_SENSITIVE_DISPATCH,
    templateCode: TEMPLATE_CODE,
    templateVersion: TEMPLATE_VERSION,
    title: cut(prep.complaintTitle, 200),
    deadline: toOffsetIso(prep.deadline),
    focusFlag: true,
    enterpriseSubjects: [
      {
        subjectCode: cut(prep.targetEnterpriseCode, 128),
        subjectName: cut(prep.targetEnterpriseName, 200),
      },
    ],
    prefilledData: {
      complaintNo: prep.complaintNo ?? undefined,
      sourceEventNo: prep.sourceEventNo ?? undefined,
      dispatchRequirement: prep.requirement ?? '',
    },
    approvalDefinitionCode: APPROVAL_DEFINITION_CODE,
    approvalDefinitionVersion: APPROVAL_DEFINITION_VERSION,
    callbackPolicy: { subscriptionCode: CALLBACK_SUBSCRIPTION_CODE, deliveryRequired: true },
    metadata: {
      reason: prep.reason ?? undefined,
      dispatchType: prep.dispatchType ?? undefined,
      triggerType: prep.triggerType ?? undefined,
      focusLabel: '重点关注',
    },
  };

  // 防御：字段名一旦写错或将来被人"顺手加一个字段"，这里立刻炸，而不是等对方 422
  const unexpected = Object.keys(payload).filter(
    (key) => !(PU_TASK_FIELDS as readonly string[]).includes(key)
  );
  if (unexpected.length > 0) {
    throw AppError.internal('构造出的任务载荷含对方白名单外字段：' + unexpected.join(', '));
  }
  return payload;
}

export interface ClassifiedOutcome {
  result: PushResultKind;
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
  taskId: string | null;
  created: boolean;
  retryable: boolean;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 错误码处置表（落地计划 §3.1）逐条实现成可测分支 */
export function classifyOutcome(outcome: PuTransportOutcome): ClassifiedOutcome {
  if (outcome.kind === 'timeout') {
    return {
      result: 'timeout', httpStatus: null, errorCode: null, message: outcome.message,
      taskId: null, created: false, retryable: true,
    };
  }
  if (outcome.kind === 'network_error') {
    return {
      result: 'network_error', httpStatus: null, errorCode: null, message: outcome.message,
      taskId: null, created: false, retryable: true,
    };
  }

  const status = outcome.httpStatus;
  const body = parseJsonObject(outcome.bodyText);
  const code = body !== null && typeof body.code === 'string' ? body.code : null;
  const message =
    body !== null && typeof body.message === 'string'
      ? body.message
      : (outcome.bodyText.slice(0, 500) === '' ? null : outcome.bodyText.slice(0, 500));

  if (status === 200) {
    const created = body !== null && body.created === true;
    const task =
      body !== null && body.task !== null && typeof body.task === 'object' && !Array.isArray(body.task)
        ? (body.task as Record<string, unknown>)
        : null;
    const taskId =
      task !== null && task.id !== null && task.id !== undefined ? String(task.id) : null;
    if (created && taskId !== null) {
      return {
        result: 'success', httpStatus: status, errorCode: null, message: null,
        taskId, created: true, retryable: false,
      };
    }
    // 200 却没给出可用 task.id：对方接受了任务但拿不到任务号。
    // 重推只会得到同样的响应（同 requestId 幂等），所以不自动重试，转人工核对。
    return {
      result: 'validation_failed',
      httpStatus: status,
      errorCode: code,
      message:
        '对方返回 200 但未提供 task.id（created=' + String(created) + '），无法登记填报任务号，需人工核对',
      taskId: null,
      created,
      retryable: false,
    };
  }

  if (status === 401) {
    return {
      result: 'auth_failed', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 409) {
    if (code === 'INTEGRATION_REPLAY') { // gate-g1-allow：对方协议错误码，必须逐字比对，不能小写化
      return {
        result: 'replay', httpStatus: status, errorCode: code, message,
        taskId: null, created: false, retryable: true,
      };
    }
    return {
      result: 'conflict', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 413) {
    return {
      result: 'payload_too_large', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 422) {
    return {
      result: 'validation_failed', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }

  // 其它未列举状态（含 5xx）：归到传输类失败；httpStatus 原样记进日志便于定位。
  // 5xx 视为可重试，4xx 视为不可重试。
  return {
    result: 'network_error', httpStatus: status, errorCode: code, message,
    taskId: null, created: false, retryable: status >= 500,
  };
}

/**
 * 推送（push 与 repush 共用这一条代码路径）。
 *
 * 为什么 repush 不需要单独实现：重推的规定语义就是"同 requestId、同 body、新 nonce、新时间戳"，
 * 而这正是本函数每次调用都在做的事——body 由交办单当前内容重新构造，requestId 取自 dispatch_order.request_id
 * 且永不改变。所以让两个端点走同一实现，反而更能保证语义一致。
 *
 * 返回约定：前置校验失败（交办不存在 / 已终态 / 缺责任企业或截止时间）抛 AppError；
 * 一旦真的发出请求，无论对方成功还是失败都返回 200 的 PushDispatchResult，
 * 由 result/retryable/httpStatus/errorCode 表达结果——失败原因必须能被前端区分与展示。
 */
export async function pushDispatch(
  assignmentId: string,
  ctx: OperatorContext
): Promise<PushDispatchResult> {
  assertPuCredentials();
  const prep = await preparePush(assignmentId);
  const payload = buildTaskPayload(prep);
  // 唯一一次序列化；下面所有尝试复用这一份字节
  const serialized = serializeOnce(payload);
  const endpoint = integrationTaskPath(env.pu.appCode);

  let finalOutcome: ClassifiedOutcome | null = null;
  let lastAttempt = 0;

  for (let round = 0; round < MAX_PUSH_ATTEMPTS; round += 1) {
    const attempt = buildAttempt(serialized);
    const startedAt = new Date();
    const transport = await postIntegrationTask(attempt);
    const finishedAt = new Date();
    const classified = classifyOutcome(transport);

    lastAttempt = await insertRequestLog(pool, {
      assignmentId,
      complaintId: prep.complaintId,
      requestId: prep.requestId,
      endpoint,
      nonce: attempt.nonce,
      signature: attempt.signature,
      httpStatus: classified.httpStatus,
      result: classified.result,
      errorCode: classified.errorCode,
      errorMessage: classified.message,
      taskId: classified.taskId,
      requestBody: serialized.bodyText,
      responseBody: transport.kind === 'response' ? transport.bodyText : null,
      startedAt,
      finishedAt,
    });

    finalOutcome = classified;
    if (classified.result === 'success' || !classified.retryable) break;
  }

  if (finalOutcome === null) {
    throw AppError.internal('推送未产生任何结果（不应发生）');
  }

  if (finalOutcome.result === 'success' && finalOutcome.taskId !== null) {
    await markDispatchPushed(assignmentId, finalOutcome.taskId, ctx);
    return {
      assignmentId,
      requestId: prep.requestId,
      accepted: true,
      created: finalOutcome.created,
      taskId: finalOutcome.taskId,
      attempt: lastAttempt,
      result: 'success',
      httpStatus: finalOutcome.httpStatus,
      errorCode: null,
      message: null,
      retryable: false,
    };
  }

  await recordPushFailure(
    assignmentId,
    prep.complaintId,
    {
      result: finalOutcome.result,
      httpStatus: finalOutcome.httpStatus,
      errorCode: finalOutcome.errorCode,
      message: finalOutcome.message,
      attempt: lastAttempt,
    },
    ctx
  );

  return {
    assignmentId,
    requestId: prep.requestId,
    accepted: false,
    created: false,
    taskId: null,
    attempt: lastAttempt,
    result: finalOutcome.result,
    httpStatus: finalOutcome.httpStatus,
    errorCode: finalOutcome.errorCode,
    message: finalOutcome.message,
    retryable: finalOutcome.retryable,
  };
}

/** 推送尝试日志（按 attempt 升序），交办不存在时 404 */
export async function listPushLogs(
  assignmentId: string
): Promise<{ content: DispatchRequestLogItem[]; total: number }> {
  const order = await findOrderByAssignmentId(pool, assignmentId);
  if (!order) throw AppError.notFound('交办单不存在');
  const content = await findRequestLogsByAssignment(assignmentId, 200);
  return { content, total: content.length };
}
