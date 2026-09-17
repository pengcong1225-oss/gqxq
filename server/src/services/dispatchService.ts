// G2 敏感交办服务：列表 / 详情 / 创建（幂等）/ 受控撤销。
//
// 唯一性口径（务必保持）：一个诉求同一轮只能有一条**进行中**交办。
//   进行中 = pending / pushed / accepted / processing / returned（与 uk_active_dispatch 生成列一致）。
//   该约束由数据库唯一键裁决，本文件**不**用"先查后插"判断唯一性：
//   直接插入并捕获重复键，然后回读既有记录返回 created=false。
//   终态（completed/rejected/archived/cancelled）不占用约束名额，因此可以在其后新建下一条交办。
import { AppError } from '../http/errors';
import type { FieldError } from '../http/errors';
import type {
  CreateDispatchRequest,
  CreateDispatchResult,
  DispatchOrderDetail,
  DispatchOrderFilter,
  DispatchOrderListItem,
  Paged,
} from '../types/api';
import { labelOf, TERMINAL_SUPERVISION_STATUSES } from '../domain/enums';
import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { allocateBizNo, shanghaiDate } from '../db/sequence';
import { insertAudit } from '../repositories/auditLogRepo';
import {
  cancelDispatchOrder,
  findActiveOrderByComplaint,
  findComplaintRefByAnyKey,
  findOrderByAssignmentId,
  findOrderPage,
  insertDispatchOrder,
  isDuplicateKey,
  lockComplaintByAnyKey,
  lockOrderStatus,
  rowToDispatchDetail,
  rowToDispatchListItem,
  supervisionStatusWithoutActiveDispatch,
  updateComplaintReportingStatus,
  updateComplaintSupervision,
  updatePushSuccess,
  type LockedComplaint,
} from '../repositories/dispatchRepo';
import { insertAssignment, updateComplaintEnterprise } from '../repositories/assignmentRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { parseShanghaiBoundary } from './complaintService';

/** 操作者上下文：来自 requireAuth 注入的 req.user 与 requestContext 注入的 remoteIp */
export interface OperatorContext {
  userId: string | null;
  userName: string | null;
  clientIp: string | null;
}

const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;
const MAX_KEYWORD_LENGTH = 100;

const DISPATCH_TYPES = ['auto', 'manual'] as const;
const TRIGGER_TYPES = ['sensitive_word', 'manual_flag'] as const;

/* ---------------- 参数解析 ---------------- */

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (Array.isArray(v) && typeof v[0] === 'string') {
    const t = v[0].trim();
    return t === '' ? undefined : t;
  }
  return undefined;
}

function stringList(v: unknown): string[] | undefined {
  const raw = firstString(v);
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return parts.length > 0 ? parts : undefined;
}

function intParam(v: unknown, name: string, min: number, max: number | undefined, fallback: number): number {
  const raw = firstString(v);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw AppError.validation('参数 ' + name + ' 必须是整数', [{ field: name, message: '必须是整数' }]);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? '不小于 ' + min : min + ' 到 ' + max;
    throw AppError.validation('参数 ' + name + ' 必须在 ' + range + ' 之间', [
      { field: name, message: '取值范围 ' + range },
    ]);
  }
  return n;
}

export interface ParsedDispatchQuery {
  filter: DispatchOrderFilter;
  page: number;
  size: number;
}

export function parseDispatchListQuery(query: Record<string, unknown>): ParsedDispatchQuery {
  const page = intParam(query.page, 'page', 1, undefined, 1);
  const size = intParam(query.size, 'size', 1, MAX_SIZE, DEFAULT_SIZE);

  const keyword = firstString(query.keyword);
  if (keyword !== undefined && keyword.length > MAX_KEYWORD_LENGTH) {
    throw AppError.validation('参数 keyword 长度不能超过 ' + MAX_KEYWORD_LENGTH, [
      { field: 'keyword', message: '最长 ' + MAX_KEYWORD_LENGTH + ' 字符' },
    ]);
  }

  const startRaw = firstString(query.startDate);
  const endRaw = firstString(query.endDate);

  return {
    page,
    size,
    filter: {
      keyword,
      status: stringList(query.status),
      complaintId: firstString(query.complaintId),
      targetEnterpriseCode: firstString(query.targetEnterpriseCode),
      startDate: startRaw === undefined ? undefined : parseShanghaiBoundary(startRaw, 'startDate', 'start'),
      endDate: endRaw === undefined ? undefined : parseShanghaiBoundary(endRaw, 'endDate', 'end'),
    },
  };
}

/** G2 共用参数校验助手（dispatch / assignment / disposition 三条路径共用一份口径） */
export function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw AppError.validation('参数 ' + field + ' 必须是字符串', [{ field, message: '必须是字符串' }]);
  }
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw AppError.validation('参数 ' + field + ' 长度不能超过 ' + max, [
      { field, message: '最长 ' + max + ' 字符' },
    ]);
  }
  return trimmed;
}

export function requiredText(raw: unknown, field: string, max: number): string {
  const value = optionalText(raw, field, max);
  if (value === null) {
    throw AppError.validation('参数 ' + field + ' 必填', [{ field, message: '必填且不能为空' }]);
  }
  return value;
}

const HAS_OFFSET = /(Z|z|[+-]\d{2}:?\d{2})$/;

/** deadline 必须是**带时区偏移**的 ISO-8601：不带偏移的本地时间在不同机器上含义不同，拒绝猜测 */
function parseDeadline(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (!HAS_OFFSET.test(value)) {
    throw AppError.validation('参数 deadline 必须带时区偏移', [
      { field: 'deadline', message: '形如 2026-09-20T18:00:00+08:00' },
    ]);
  }
  const at = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(at.getTime())) {
    throw AppError.validation('参数 deadline 不是合法时间', [{ field: 'deadline', message: '无法解析' }]);
  }
  return at;
}

function enumParam<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T | null {
  const value = firstString(raw);
  if (value === undefined) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    throw AppError.validation('参数 ' + field + ' 只能是 ' + allowed.join(' / '), [
      { field, message: '取值 ' + allowed.join(' / ') },
    ]);
  }
  return value as T;
}

function isTerminal(status: string): boolean {
  return (TERMINAL_SUPERVISION_STATUSES as readonly string[]).includes(status);
}

function hasEnterprise(complaint: LockedComplaint): boolean {
  return complaint.enterprise_code !== null && String(complaint.enterprise_code).trim() !== '';
}

/* ---------------- 查询 ---------------- */

export async function listDispatchOrders(
  query: Record<string, unknown>
): Promise<Paged<DispatchOrderListItem>> {
  const { filter, page, size } = parseDispatchListQuery(query);
  const { rows, total } = await findOrderPage(filter, page, size);
  return {
    content: rows.map(rowToDispatchListItem),
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
  };
}

export async function getDispatchOrder(assignmentId: string): Promise<DispatchOrderDetail> {
  const row = await findOrderByAssignmentId(pool, assignmentId);
  if (!row) throw AppError.notFound('交办单不存在');
  return rowToDispatchDetail(row);
}

/* ---------------- 创建（幂等） ---------------- */

export async function createDispatch(
  rawBody: unknown,
  ctx: OperatorContext
): Promise<CreateDispatchResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  // 必填项一次性收集：契约里 fieldErrors 是数组，只报第一个会让调用方反复试错
  const fieldErrors: FieldError[] = [];
  const requiredField = (field: string, max: number): string => {
    const value = optionalText(body[field], field, max);
    if (value === null) {
      fieldErrors.push({ field, message: '必填且不能为空' });
      return '';
    }
    return value;
  };
  const complaintIdOrNo = requiredField('complaintId', 64);
  const targetEnterpriseCode = requiredField('targetEnterpriseCode', 64);
  const targetEnterpriseName = requiredField('targetEnterpriseName', 255);
  if (fieldErrors.length > 0) {
    throw AppError.validation('必填参数缺失或为空：' + fieldErrors.map((e) => e.field).join(', '), fieldErrors);
  }
  const reason = optionalText(body.reason, 'reason', 500);
  const requirement = optionalText(body.requirement, 'requirement', 1000);
  const deadline = parseDeadline(body.deadline);
  const dispatchTypeInput = enumParam(body.dispatchType, 'dispatchType', DISPATCH_TYPES);
  const triggerTypeInput = enumParam(body.triggerType, 'triggerType', TRIGGER_TYPES);

  // 事务外先把业务键归一出来：唯一键冲突后需要用它回读既有交办
  const ref = await findComplaintRefByAnyKey(pool, complaintIdOrNo);
  if (!ref) throw AppError.notFound('诉求不存在');

  const receivedAt = new Date();
  const isoDate = shanghaiDate(receivedAt);
  let createdAssignmentId: string | null = null;
  let createdOrderNo: string | null = null;

  try {
    await withTransaction(async (tx) => {
      const complaint = await lockComplaintByAnyKey(tx, complaintIdOrNo);
      if (!complaint) throw AppError.notFound('诉求不存在');

      // 交办前必须明确责任单位：请求必须给出，且诉求若此前没有责任单位则本次补上
      if (!hasEnterprise(complaint)) {
        const logId = await insertAssignment(tx, {
          complaintId: complaint.complaint_id,
          beforeCode: null,
          beforeName: null,
          afterCode: targetEnterpriseCode,
          afterName: targetEnterpriseName,
          matchType: 'manual',
          reason: '创建交办时首次明确责任单位',
          operatorId: ctx.userId,
          operatorName: ctx.userName,
          createdAt: receivedAt,
        });
        await updateComplaintEnterprise(tx, {
          complaintId: complaint.complaint_id,
          enterpriseCode: targetEnterpriseCode,
          enterpriseName: targetEnterpriseName,
          matchedAt: receivedAt,
          matchReason: '创建交办时首次明确责任单位',
          supervisionStatus: complaint.supervision_status === 'pending_match' ? 'none' : complaint.supervision_status,
          updatedAt: receivedAt,
        });
        void logId;
      }

      const assignmentId = await allocateBizNo(tx, 'assignment', 'ASGN', isoDate);
      const orderNo = await allocateBizNo(tx, 'dispatch_order', 'JB', isoDate);
      const requestId = await allocateBizNo(tx, 'dispatch_request', 'AREQ', isoDate);

      // triggerType 不猜：报文给了就用，没给就按诉求是否敏感推导（数据驱动，非常量）
      const dispatchType = dispatchTypeInput ?? 'manual';
      const triggerType = triggerTypeInput ?? (complaint.is_sensitive === 1 ? 'sensitive_word' : 'manual_flag');

      // 直接插入。唯一性交给 uk_active_dispatch / uk_dispatch_request 裁决。
      await insertDispatchOrder(tx, {
        assignmentId,
        orderNo,
        complaintId: complaint.complaint_id,
        complaintTitle: complaint.title,
        dispatchType,
        triggerType,
        sensitiveWords: complaint.sensitive_keywords,
        targetEnterpriseCode,
        targetEnterpriseName,
        deadline,
        requestId,
        reason,
        requirement,
        createdBy: ctx.userId,
        createdByName: ctx.userName,
        createdAt: receivedAt,
      });

      await updateComplaintSupervision(tx, complaint.complaint_id, 'pending', receivedAt);

      await insertAudit(tx, {
        userId: ctx.userId,
        appCode: GQXQ_APP_CODE,
        resourceCode: orderNo,
        action: 'DISPATCH_CREATE',
        bizType: 'dispatch_order',
        // biz_id 用 complaint_id：诉求时间线按 biz_id 关联，用交办号会导致"创建交办"事件看不到
        bizId: complaint.complaint_id,
        result: 'success',
        clientIp: ctx.clientIp,
        detail: {
          assignmentId,
          complaintId: complaint.complaint_id,
          targetEnterpriseCode,
          targetEnterpriseName,
          dispatchType,
          triggerType,
          requestId,
          deadline: deadline === null ? null : deadline.toISOString(),
          complaintEnterpriseCode: complaint.enterprise_code,
          enterpriseDiffersFromDispatch:
            hasEnterprise(complaint) && complaint.enterprise_code !== targetEnterpriseCode,
        },
        createdAt: receivedAt,
      });

      createdAssignmentId = assignmentId;
      createdOrderNo = orderNo;
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      // 撞唯一键：该诉求已有进行中交办（唯一键保证最多一条）。回读既有记录，返回 created=false，不报错。
      const existing = await findActiveOrderByComplaint(pool, ref.complaint_id);
      if (existing) {
        await insertAudit(pool, {
          userId: ctx.userId,
          appCode: GQXQ_APP_CODE,
          resourceCode: String(existing.order_no),
          action: 'DISPATCH_CREATE',
          bizType: 'dispatch_order',
          bizId: ref.complaint_id,
          result: 'duplicate',
          clientIp: ctx.clientIp,
          detail: {
            assignmentId: String(existing.assignment_id),
            complaintId: ref.complaint_id,
            reason: '该诉求已有进行中交办，返回既有记录',
            existingStatus: String(existing.status),
          },
          createdAt: new Date(),
        });
        return { created: false, order: rowToDispatchDetail(existing) };
      }
      // 撞的不是有效交办唯一键，只能是 request_id 重复：属于幂等键异常，不能静默
      throw AppError.conflict('交办幂等请求号冲突，请重试');
    }
    throw err;
  }

  const actor = createdAssignmentId;
  if (actor === null) {
    throw AppError.internal('创建交办后未取到交办号');
  }
  if (createdOrderNo === null) {
    throw AppError.internal('创建交办后未取到交办单号');
  }
  const saved = await findOrderByAssignmentId(pool, actor);
  if (!saved) throw AppError.internal('创建交办后回读失败');
  return { created: true, order: rowToDispatchDetail(saved) };
}

/* ---------------- 受控撤销 ---------------- */

export async function cancelDispatch(
  assignmentId: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<DispatchOrderDetail> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const cancelReason = optionalText(body.cancelReason ?? body.reason, 'cancelReason', 500);
  const cancelledAt = new Date();

  await withTransaction(async (tx) => {
    // 先锁再判状态：否则两个并发撤销会同时通过检查
    const currentStatus = await lockOrderStatus(tx, assignmentId);
    if (currentStatus === null) throw AppError.notFound('交办单不存在');
    if (isTerminal(currentStatus)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '交办单当前状态为「' + labelOf('supervision_status', currentStatus) + '」，已是终态，不允许撤销'
      );
    }

    await cancelDispatchOrder(tx, assignmentId, cancelReason, cancelledAt);

    const order = await findOrderByAssignmentId(tx, assignmentId);
    const complaintId = order === null ? null : String(order.complaint_id);
    if (complaintId !== null) {
      const complaint = await lockComplaintByAnyKey(tx, complaintId);
      if (complaint !== null) {
        const stillActive = await findActiveOrderByComplaint(tx, complaint.complaint_id);
        // 撤销后没有进行中交办了，督办状态必须归位，否则总账会显示"待推送"却没有交办单
        if (stillActive === null) {
          await updateComplaintSupervision(
            tx,
            complaint.complaint_id,
            supervisionStatusWithoutActiveDispatch(complaint),
            cancelledAt
          );
        }
      }
    }

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: assignmentId,
      action: 'DISPATCH_CANCEL',
      bizType: 'dispatch_order',
      bizId: complaintId,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: {
        assignmentId,
        complaintId,
        fromStatus: currentStatus,
        toStatus: 'cancelled',
        cancelReason,
      },
      createdAt: cancelledAt,
    });
  });

  const updated = await findOrderByAssignmentId(pool, assignmentId);
  if (!updated) throw AppError.internal('撤销后回读失败');
  return rowToDispatchDetail(updated);
}

/* ---------------- G3：推送准备与状态推进 ---------------- */

/** 一次推送所需的全部素材；由 preparePush 在发起 HTTP **之前**就把校验做完 */
export interface PushPreparation {
  assignmentId: string;
  requestId: string;
  complaintId: string;
  complaintNo: string | null;
  /** 来源系统业务键（宜接就办事件号），只作追溯用，进 prefilledData */
  sourceEventNo: string | null;
  complaintTitle: string;
  targetEnterpriseCode: string;
  targetEnterpriseName: string;
  requirement: string | null;
  reason: string | null;
  deadline: Date;
  dispatchType: string | null;
  triggerType: string | null;
  status: string;
  reportingTaskId: string | null;
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * 推送前置校验并取出所需字段。
 * 这里刻意把"能不能推"的判断放在 HTTP 之前：对方要求 deadline 必填、enterpriseSubjects 至少 1 项，
 * 本地缺这些字段时应当直接给出可修的 400，而不是发出去换一个语义模糊的 422。
 */
export async function preparePush(assignmentId: string): Promise<PushPreparation> {
  const row = await findOrderByAssignmentId(pool, assignmentId);
  if (!row) throw AppError.notFound('交办单不存在');

  const status = String(row.status);
  if (isTerminal(status)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      '交办单当前状态为「' + labelOf('supervision_status', status) + '」，已是终态，不允许推送'
    );
  }

  const targetEnterpriseCode = textOf(row.target_enterprise_code);
  const targetEnterpriseName = textOf(row.target_enterprise_name);
  const deadline = row.deadline instanceof Date ? row.deadline : null;

  const fieldErrors: FieldError[] = [];
  if (targetEnterpriseCode === '') {
    fieldErrors.push({ field: 'targetEnterpriseCode', message: '交办单没有责任企业编码，无法创建填报任务' });
  }
  if (targetEnterpriseName === '') {
    fieldErrors.push({ field: 'targetEnterpriseName', message: '交办单没有责任企业名称，无法创建填报任务' });
  }
  if (deadline === null) {
    fieldErrors.push({ field: 'deadline', message: '交办单没有截止时间；对方 deadline 必填且要求带时区偏移' });
  }
  if (fieldErrors.length > 0) {
    throw AppError.validation('交办单信息不完整，无法创建填报任务', fieldErrors);
  }

  return {
    assignmentId,
    requestId: String(row.request_id),
    complaintId: String(row.complaint_id),
    complaintNo: row.complaint_no === null || row.complaint_no === undefined ? null : String(row.complaint_no),
    sourceEventNo: row.source_event_no === null || row.source_event_no === undefined ? null : String(row.source_event_no),
    complaintTitle: textOf(row.complaint_title) === '' ? '敏感交办' : textOf(row.complaint_title),
    targetEnterpriseCode,
    targetEnterpriseName,
    requirement: row.requirement === null || row.requirement === undefined ? null : String(row.requirement),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    deadline: deadline as Date,
    dispatchType: row.dispatch_type === null || row.dispatch_type === undefined ? null : String(row.dispatch_type),
    triggerType: row.trigger_type === null || row.trigger_type === undefined ? null : String(row.trigger_type),
    status,
    reportingTaskId: row.reporting_task_id === null || row.reporting_task_id === undefined
      ? null
      : String(row.reporting_task_id),
  };
}

/**
 * 推送成功后的状态推进（在事务内做，先锁行再改）：
 *   dispatch_order.status -> pushed、reporting_task_id、pushed_at、sync_status -> success
 *   complaint.reporting_status -> pushed（只动这一条轴）
 *   写审计 DISPATCH_PUSH
 */
export async function markDispatchPushed(
  assignmentId: string,
  taskId: string,
  ctx: OperatorContext
): Promise<DispatchOrderDetail> {
  const pushedAt = new Date();

  await withTransaction(async (tx) => {
    const currentStatus = await lockOrderStatus(tx, assignmentId);
    if (currentStatus === null) throw AppError.notFound('交办单不存在');
    if (isTerminal(currentStatus)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '交办单当前状态为「' + labelOf('supervision_status', currentStatus) + '」，已是终态，不允许推送'
      );
    }

    await updatePushSuccess(tx, assignmentId, taskId, pushedAt);

    const order = await findOrderByAssignmentId(tx, assignmentId);
    const complaintId = order === null ? null : String(order.complaint_id);
    if (complaintId !== null) {
      await updateComplaintReportingStatus(tx, complaintId, 'pushed', pushedAt);
    }

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: assignmentId,
      action: 'DISPATCH_PUSH',
      bizType: 'dispatch_order',
      bizId: complaintId,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: { assignmentId, complaintId, taskId, fromStatus: currentStatus, toStatus: 'pushed' },
      createdAt: pushedAt,
    });
  });

  const updated = await findOrderByAssignmentId(pool, assignmentId);
  if (!updated) throw AppError.internal('推送成功后回读失败');
  return rowToDispatchDetail(updated);
}

/**
 * 推送失败只记审计，**不改 status**——交办仍是 pending，可以再推。
 * 交付纪律：失败就是失败，不允许为了"看起来成功"而推进状态。
 */
export async function recordPushFailure(
  assignmentId: string,
  complaintId: string | null,
  detail: { result: string; httpStatus: number | null; errorCode: string | null; message: string | null; attempt: number },
  ctx: OperatorContext
): Promise<void> {
  const at = new Date();
  await insertAudit(pool, {
    userId: ctx.userId,
    appCode: GQXQ_APP_CODE,
    resourceCode: assignmentId,
    action: 'DISPATCH_PUSH',
    bizType: 'dispatch_order',
    bizId: complaintId,
    result: 'failed',
    clientIp: ctx.clientIp,
    detail: { assignmentId, complaintId, ...detail },
    createdAt: at,
  });
}
