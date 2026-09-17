// G2 归库处置服务：无需交办归库 / 误报归库。
//
// 硬约束（落地计划 G2）：
//   * 归库**绝不产生任何交办**——本文件不引用任何 dispatch 写入函数；
//   * is_sensitive 不改：自动命中的事实要留着，"这是误报"的判定记进 complaint_disposition，
//     这样日后能对比"当时为什么判定为误报"；
//   * 已有进行中交办时不允许归库：否则会出现"存在交办单、诉求却显示未交办"的矛盾状态，
//     必须先受控撤销交办再归库。
import { AppError } from '../http/errors';
import type { DispositionKind, DispositionResult } from '../types/api';
import { withTransaction } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { findActiveOrderByComplaint, lockComplaintByAnyKey } from '../repositories/dispatchRepo';
import {
  insertDisposition,
  isDispositionKind,
  updateComplaintAfterDisposition,
} from '../repositories/dispositionRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { optionalText, type OperatorContext } from './dispatchService';

export async function disposeComplaint(
  idOrNo: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<DispositionResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const rawDisposition = body.disposition;
  if (typeof rawDisposition !== 'string' || !isDispositionKind(rawDisposition.trim())) {
    throw AppError.validation('参数 disposition 只能是 no_dispatch_needed 或 false_positive', [
      { field: 'disposition', message: '取值 no_dispatch_needed / false_positive' },
    ]);
  }
  const disposition: DispositionKind = rawDisposition.trim() as DispositionKind;
  const reason = optionalText(body.reason, 'reason', 500);
  const now = new Date();

  return withTransaction(async (tx) => {
    const complaint = await lockComplaintByAnyKey(tx, idOrNo);
    if (!complaint) throw AppError.notFound('诉求不存在');

    const active = await findActiveOrderByComplaint(tx, complaint.complaint_id);
    if (active !== null) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '该诉求已有进行中交办（' + String(active.order_no) + '），请先受控撤销交办再归库'
      );
    }

    const dispositionId = await insertDisposition(tx, {
      complaintId: complaint.complaint_id,
      disposition,
      isSensitiveBefore: complaint.is_sensitive === 1,
      reason,
      operatorId: ctx.userId,
      operatorName: ctx.userName,
      createdAt: now,
    });

    await updateComplaintAfterDisposition(tx, complaint.complaint_id, now);

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: complaint.complaint_no,
      action: 'COMPLAINT_DISPOSITION',
      bizType: 'complaint',
      bizId: complaint.complaint_id,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: {
        disposition,
        reason,
        isSensitiveBefore: complaint.is_sensitive === 1,
        supervisionStatusBefore: complaint.supervision_status,
        supervisionStatusAfter: 'none',
      },
      createdAt: now,
    });

    return {
      complaintId: complaint.complaint_id,
      dispositionId,
      disposition,
      isSensitive: complaint.is_sensitive === 1,
      supervisionStatus: 'none',
    };
  });
}
