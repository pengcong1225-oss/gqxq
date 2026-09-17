// G2 责任单位分配服务：匹配 / 调整诉求的责任企业。
//
// 这是 enterprise_code / enterprise_name 的**唯一人工写入口**——G1 明确把这两列定义为
// 「人工受保护字段」，外部重传不得覆盖；因此本文件与 intakeService 的保护白名单互为对照。
import { AppError } from '../http/errors';
import type { AssignEnterpriseResult } from '../types/api';
import { withTransaction } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { lockComplaintByAnyKey } from '../repositories/dispatchRepo';
import { insertAssignment, updateComplaintEnterprise } from '../repositories/assignmentRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { optionalText, requiredText, type OperatorContext } from './dispatchService';

export async function assignEnterprise(
  idOrNo: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<AssignEnterpriseResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const enterpriseCode = requiredText(body.enterpriseCode, 'enterpriseCode', 64);
  const enterpriseName = requiredText(body.enterpriseName, 'enterpriseName', 255);
  const reason = optionalText(body.reason, 'reason', 500);
  const now = new Date();

  return withTransaction(async (tx) => {
    const complaint = await lockComplaintByAnyKey(tx, idOrNo);
    if (!complaint) throw AppError.notFound('诉求不存在');

    const beforeCode = complaint.enterprise_code;
    const beforeName = complaint.enterprise_name;
    const unchanged = beforeCode === enterpriseCode && beforeName === enterpriseName;

    // 敏感命中且此前"待匹配"：现在单位已明确 -> 推进为 none（是否交办由总账另行决定）
    const nextSupervision =
      complaint.supervision_status === 'pending_match' ? 'none' : complaint.supervision_status;

    // 无论前后值是否相同都留痕：操作员确实执行了一次"确认责任单位"的动作，可审计性优先于少写一行
    const assignmentLogId = await insertAssignment(tx, {
      complaintId: complaint.complaint_id,
      beforeCode,
      beforeName,
      afterCode: enterpriseCode,
      afterName: enterpriseName,
      matchType: 'manual',
      reason: reason ?? (unchanged ? '确认责任单位（前后值相同）' : null),
      operatorId: ctx.userId,
      operatorName: ctx.userName,
      createdAt: now,
    });

    await updateComplaintEnterprise(tx, {
      complaintId: complaint.complaint_id,
      enterpriseCode,
      enterpriseName,
      matchedAt: now,
      matchReason: reason,
      supervisionStatus: nextSupervision,
      updatedAt: now,
    });

    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: complaint.complaint_no,
      action: 'ASSIGN_ENTERPRISE',
      bizType: 'complaint',
      bizId: complaint.complaint_id,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: {
        beforeCode,
        beforeName,
        afterCode: enterpriseCode,
        afterName: enterpriseName,
        unchanged,
        reason,
        supervisionStatusBefore: complaint.supervision_status,
        supervisionStatusAfter: nextSupervision,
      },
      createdAt: now,
    });

    return {
      complaintId: complaint.complaint_id,
      assignmentLogId,
      beforeEnterpriseCode: beforeCode,
      beforeEnterpriseName: beforeName,
      afterEnterpriseCode: enterpriseCode,
      afterEnterpriseName: enterpriseName,
      supervisionStatus: nextSupervision,
    };
  });
}
