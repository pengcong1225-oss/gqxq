// G5 本系统办结 + 交办归档。
//
// 业主确认的办结口径：**最终审批通过 + 纠偏全部确认之后，再由人工显式办结**。
// 机器只负责提供条件与校验——本文件不做任何"自动办结"，也不把状态推进当成办结。
import type { CloseComplaintResult, DispatchOrderDetail } from '../types/api';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { findComplaintRefByAnyKey, findOrderByAssignmentId, rowToDispatchDetail } from '../repositories/dispatchRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { requiredText, type OperatorContext } from './dispatchService';
import { pendingCorrectionCount } from './correctionService';

/** 可归档的交办状态：只有走完填报审批链路的终态才允许归档 */
const ARCHIVABLE_DISPATCH_STATUSES = ['completed', 'rejected'] as const;

interface CloseRow {
  complaint_no: string;
  reporting_status: string;
  supervision_status: string;
  closed_in_system: number | null;
  closed_at: unknown;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_basis: string | null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function closeComplaint(
  idOrNo: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<CloseComplaintResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  // 依据必填：规格要求确认人 / 时间 / 依据三者缺一不可，缺依据的办结等于没有留痕
  const basis = requiredText(body.basis, 'basis', 500);

  const ref = await findComplaintRefByAnyKey(pool, idOrNo);
  if (!ref) throw AppError.notFound('诉求不存在');
  const complaintId = String(ref.complaint_id);
  const now = new Date();

  return withTransaction(async (tx) => {
    const [rows] = await tx.query(
      'select complaint_no, reporting_status, supervision_status, closed_in_system,' +
        ' closed_at, closed_by, closed_by_name, closed_basis' +
        ' from complaint where complaint_id = ? for update',
      [complaintId]
    );
    const row = (rows as unknown as CloseRow[])[0];
    if (!row) throw AppError.notFound('诉求不存在');

    if (Number(row.closed_in_system ?? 0) === 1) {
      throw new AppError('INVALID_STATE_TRANSITION', '该诉求已在本系统办结，不能重复办结');
    }
    if (String(row.reporting_status) !== 'approved') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '该诉求填报审批状态为 ' + String(row.reporting_status) + '，只有最终审批通过（approved）后才能办结'
      );
    }
    const pending = await pendingCorrectionCount(tx, complaintId);
    if (pending > 0) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '该诉求仍有 ' + pending + ' 项待纠偏，纠偏全部确认后才能办结'
      );
    }

    await tx.execute(
      'update complaint set closed_in_system = 1, closed_at = ?, closed_by = ?, closed_by_name = ?,' +
        ' closed_basis = ?, updated_at = ? where complaint_id = ?',
      [now, ctx.userId, ctx.userName, basis, now, complaintId]
    );

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: row.complaint_no,
      action: 'COMPLAINT_CLOSE',
      bizType: 'complaint',
      bizId: complaintId,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: {
        basis,
        reportingStatus: String(row.reporting_status),
        supervisionStatus: String(row.supervision_status),
        // 办结是本系统独立标记，**不改写来源事件状态**（落地计划 G5 / 设计文档 §4.1）
        sourceEventStatusUntouched: true,
      },
      createdAt: now,
    });

    return {
      complaintId,
      closedInSystem: true,
      closedAt: now.toISOString(),
      closedBy: ctx.userId,
      closedByName: ctx.userName,
      closedBasis: basis,
    };
  });
}

export async function archiveDispatchOrder(
  assignmentId: string,
  ctx: OperatorContext
): Promise<DispatchOrderDetail> {
  const now = new Date();

  return withTransaction(async (tx) => {
    const [rows] = await tx.query(
      'select status, complaint_id as complaintId from dispatch_order where assignment_id = ? for update',
      [assignmentId]
    );
    const row = (rows as unknown as Array<{ status: string; complaintId: string }>)[0];
    if (!row) throw AppError.notFound('交办单不存在');

    const status = String(row.status);
    const complaintId = String(row.complaintId);

    // 已归档：幂等返回既有记录，不重复写审计
    if (status === 'archived') {
      const existing = await findOrderByAssignmentId(tx, assignmentId);
      if (!existing) throw AppError.notFound('交办单不存在');
      return rowToDispatchDetail(existing);
    }

    if (!(ARCHIVABLE_DISPATCH_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '交办当前状态为 ' + status + '，只有 completed / rejected 才能归档'
      );
    }

    const pending = await pendingCorrectionCount(tx, complaintId);
    if (pending > 0) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '该诉求仍有 ' + pending + ' 项待纠偏，纠偏全部确认后才能归档'
      );
    }

    await tx.execute(
      "update dispatch_order set status = 'archived', archived_at = ?, updated_at = ? where assignment_id = ?",
      [now, now, assignmentId]
    );

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: assignmentId,
      action: 'DISPATCH_ARCHIVE',
      bizType: 'dispatch_order',
      bizId: complaintId,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: { statusBefore: status, statusAfter: 'archived' },
      createdAt: now,
    });

    const updated = await findOrderByAssignmentId(tx, assignmentId);
    if (!updated) throw AppError.notFound('交办单不存在');
    return rowToDispatchDetail(updated);
  });
}
