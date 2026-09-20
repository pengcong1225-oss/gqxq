// G2 责任单位确认：enterprise_code / enterprise_name 的**唯一人工写实现**。
//
// 为什么只有一个实现（业主 2026-09-20 裁定「匹配责任单位收敛进纠偏入口」之后）：
//   总账的「匹配单位」按钮已下线，责任单位现在有两个入口——
//   ① POST /complaints/:idOrNo/assignment（保留给外部/脚本复用）
//   ② 纠偏确认「企业名称/归属」（correctionService 写回 complaint 时复用本文件的 confirmResponsibleEnterpriseInTx）
//   两处都必须走同一段：主数据校验 + code/name 成对写 + 前后值留痕。
//   分成两份实现必然漂移，漂移的结果就是 enterprise_code 与 enterprise_name 对上不上。
//
// G1 把这两列定义为「人工受保护字段」，外部重传不得覆盖（见 intakeService 的 PROTECTED_REQUEST_KEYS），
// 因此能写它们的只有本文件。
import { AppError } from '../http/errors';
import type { AssignEnterpriseResult } from '../types/api';
import type { Tx } from '../db/tx';
import { withTransaction } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { lockComplaintByAnyKey } from '../repositories/dispatchRepo';
import { insertAssignment, updateComplaintEnterprise } from '../repositories/assignmentRepo';
import { findEnterpriseByCodeIn } from '../repositories/enterpriseRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { optionalText, requiredText, type OperatorContext } from './dispatchService';

/** enterprise_code 与 complaint.enterprise_code 同为 varchar(64)，超长的输入必须在进库前被拒（对齐列宽，见 HANDOVER §6-④） */
const ENTERPRISE_CODE_MAX = 64;

/** 责任单位写回的触发入口，只进审计 detail，不参与业务判断 */
export type ResponsibleEnterpriseSource = 'assignment' | 'correction';

/**
 * 调用方**必须已经锁住**这条 complaint 行（for update），本函数不再自行加锁：
 * 纠偏确认在同一个事务里先锁 complaint 再锁 correction_item，加锁顺序由调用方固定。
 */
export interface EnterpriseWriteTarget {
  complaintId: string;
  complaintNo: string;
  currentEnterpriseCode: string | null;
  currentEnterpriseName: string | null;
  currentSupervisionStatus: string;
}

export interface ConfirmResponsibleEnterpriseInput {
  /** 主数据登记编码；必须能在 enterprise 表里查到，查不到直接报错，不静默回落 */
  enterpriseCode: string;
  /** 调用方给出的企业名称：只用于与登记值核对，写回一律以 enterprise 表为准 */
  enterpriseName: string | null;
  reason: string | null;
  ctx: OperatorContext;
  now: Date;
  source: ResponsibleEnterpriseSource;
}

/**
 * 确认责任单位：校验主数据 -> 成对写 code + name + responsible_matched_at -> 追加 complaint_assignment 留痕 -> 审计。
 *
 * 三条硬要求（2026-09-20 批次）：
 *   1) enterprise_code 必须是 enterprise 表里的登记值，匹配不到 -> 400 VALIDATION_FAILED（不是 500，也不静默写脏数据）；
 *   2) enterprise_code 与 enterprise_name 必须成对写，名称取主数据登记值，二者不可能各说一套；
 *   3) 调用方给的名称与登记值不一致时直接报错——悄悄用登记值覆盖操作员看到的名字，等于让他以为写进去的是另一个主体。
 */
export async function confirmResponsibleEnterpriseInTx(
  tx: Tx,
  target: EnterpriseWriteTarget,
  input: ConfirmResponsibleEnterpriseInput
): Promise<AssignEnterpriseResult> {
  const enterpriseCode = (input.enterpriseCode ?? '').trim();
  if (enterpriseCode === '') {
    throw AppError.validation('enterpriseCode 不能为空', [
      { field: 'enterpriseCode', message: '责任单位编码必填' },
    ]);
  }
  if (enterpriseCode.length > ENTERPRISE_CODE_MAX) {
    throw AppError.validation('enterpriseCode 长度不能超过 ' + ENTERPRISE_CODE_MAX, [
      { field: 'enterpriseCode', message: '最长 ' + ENTERPRISE_CODE_MAX + ' 字符' },
    ]);
  }

  const master = await findEnterpriseByCodeIn(tx, enterpriseCode);
  if (master === null) {
    throw AppError.validation(
      '责任单位编码 ' + enterpriseCode + ' 不在企业主数据（enterprise 表）登记值里，本次不写回',
      [{ field: 'enterpriseCode', message: '必须从企业主数据里选，编码未登记' }]
    );
  }
  const enterpriseName = master.enterpriseName;
  if (input.enterpriseName !== null && input.enterpriseName.trim() !== '' && input.enterpriseName.trim() !== enterpriseName) {
    throw AppError.validation(
      '企业名称与主数据登记值不一致：编码 ' + enterpriseCode + ' 的登记名称是「' + enterpriseName + '」',
      [{ field: 'enterpriseName', message: '以企业主数据登记值为准' }]
    );
  }

  const beforeCode = target.currentEnterpriseCode;
  const beforeName = target.currentEnterpriseName;
  const unchanged = beforeCode === enterpriseCode && beforeName === enterpriseName;

  // 敏感命中且此前"待匹配"：现在单位已明确 -> 推进为 none（是否交办由总账另行决定）
  const nextSupervision =
    target.currentSupervisionStatus === 'pending_match' ? 'none' : target.currentSupervisionStatus;

  // 无论前后值是否相同都留痕：操作员确实执行了一次"确认责任单位"的动作，可审计性优先于少写一行
  const assignmentLogId = await insertAssignment(tx, {
    complaintId: target.complaintId,
    beforeCode,
    beforeName,
    afterCode: enterpriseCode,
    afterName: enterpriseName,
    matchType: 'manual',
    reason: input.reason ?? (unchanged ? '确认责任单位（前后值相同）' : null),
    operatorId: input.ctx.userId,
    operatorName: input.ctx.userName,
    createdAt: input.now,
  });

  await updateComplaintEnterprise(tx, {
    complaintId: target.complaintId,
    enterpriseCode,
    enterpriseName,
    matchedAt: input.now,
    matchReason: input.reason,
    supervisionStatus: nextSupervision,
    updatedAt: input.now,
  });

  await insertAudit(tx, {
    userId: input.ctx.userId,
    appCode: GQXQ_APP_CODE,
    resourceCode: target.complaintNo,
    action: 'ASSIGN_ENTERPRISE',
    bizType: 'complaint',
    bizId: target.complaintId,
    result: 'success',
    clientIp: input.ctx.clientIp,
    detail: {
      source: input.source,
      beforeCode,
      beforeName,
      afterCode: enterpriseCode,
      afterName: enterpriseName,
      unchanged,
      reason: input.reason,
      supervisionStatusBefore: target.currentSupervisionStatus,
      supervisionStatusAfter: nextSupervision,
    },
    createdAt: input.now,
  });

  return {
    complaintId: target.complaintId,
    assignmentLogId,
    beforeEnterpriseCode: beforeCode,
    beforeEnterpriseName: beforeName,
    afterEnterpriseCode: enterpriseCode,
    afterEnterpriseName: enterpriseName,
    supervisionStatus: nextSupervision,
  };
}

/**
 * POST /complaints/:idOrNo/assignment 的实现。
 * 按钮虽已下线（收敛进纠偏），路由与这条服务函数按裁定保留：外部/脚本仍可显式匹配单位，
 * 且它现在与纠偏共用 confirmResponsibleEnterpriseInTx，不再另有一份校验逻辑。
 */
export async function assignEnterprise(
  idOrNo: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<AssignEnterpriseResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const enterpriseCode = requiredText(body.enterpriseCode, 'enterpriseCode', ENTERPRISE_CODE_MAX);
  const enterpriseName = requiredText(body.enterpriseName, 'enterpriseName', 255);
  const reason = optionalText(body.reason, 'reason', 500);
  const now = new Date();

  return withTransaction(async (tx) => {
    const complaint = await lockComplaintByAnyKey(tx, idOrNo);
    if (!complaint) throw AppError.notFound('诉求不存在');

    return confirmResponsibleEnterpriseInTx(
      tx,
      {
        complaintId: complaint.complaint_id,
        complaintNo: complaint.complaint_no,
        currentEnterpriseCode: complaint.enterprise_code,
        currentEnterpriseName: complaint.enterprise_name,
        currentSupervisionStatus: complaint.supervision_status,
      },
      { enterpriseCode, enterpriseName, reason, ctx, now, source: 'assignment' }
    );
  });
}
