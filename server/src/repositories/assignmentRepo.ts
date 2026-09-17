// complaint_assignment（追加写）：责任单位分配留痕。
//
// 纪律：只 insert，不 update、不 delete。
// 前后值都记录，因此可以回查"谁在什么时候把责任单位从谁改成了谁、因为什么"。
// 注意 enterprise_code / enterprise_name 在 G1 里被定义为**人工受保护字段**，
// 外部重传不得覆盖；本文件是唯一允许改写它们的入口（人工分配）。
import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx';
import { cut, type Queryable } from './complaintSourceLogRepo';

export type AssignmentMatchType = 'manual' | 'manual_clear';

export interface InsertAssignmentInput {
  complaintId: string;
  beforeCode: string | null;
  beforeName: string | null;
  afterCode: string | null;
  afterName: string | null;
  matchType: AssignmentMatchType;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  createdAt: Date;
}

export async function insertAssignment(tx: Tx, input: InsertAssignmentInput): Promise<string> {
  const assignmentLogId = 'ASN-' + randomUUID();
  await tx.execute(
    'insert into complaint_assignment ' +
      '(assignment_log_id, complaint_id, before_enterprise_code, before_enterprise_name,' +
      ' after_enterprise_code, after_enterprise_name, match_type, reason, operator_id, operator_name, created_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      assignmentLogId,
      cut(input.complaintId, 64),
      cut(input.beforeCode, 64),
      cut(input.beforeName, 255),
      cut(input.afterCode, 64),
      cut(input.afterName, 255),
      input.matchType,
      cut(input.reason, 500),
      cut(input.operatorId, 64),
      cut(input.operatorName, 64),
      input.createdAt,
    ]
  );
  return assignmentLogId;
}

export interface UpdateComplaintEnterpriseInput {
  complaintId: string;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  /** 人工匹配时间；由调用方传 JS Date，驱动按 +08:00 落墙钟 */
  matchedAt: Date;
  matchReason: string | null;
  /** 推进后的督办状态（敏感且此前待匹配时由调用方传 'none'） */
  supervisionStatus: string;
  updatedAt: Date;
}

/** 把责任单位与匹配元数据写回 complaint。这是人工分配的唯一写入口。 */
export async function updateComplaintEnterprise(
  tx: Tx,
  input: UpdateComplaintEnterpriseInput
): Promise<number> {
  const [result] = await tx.execute(
    'update complaint set enterprise_code = ?, enterprise_name = ?, responsible_matched_at = ?,' +
      ' responsible_match_reason = ?, supervision_status = ?, updated_at = ? where complaint_id = ?',
    [
      cut(input.enterpriseCode, 64),
      cut(input.enterpriseName, 255),
      input.matchedAt,
      cut(input.matchReason, 500),
      input.supervisionStatus,
      input.updatedAt,
      input.complaintId,
    ]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

export interface AssignmentLogRow {
  assignmentLogId: string;
  beforeEnterpriseCode: string | null;
  beforeEnterpriseName: string | null;
  afterEnterpriseCode: string | null;
  afterEnterpriseName: string | null;
  matchType: string;
  reason: string | null;
  operatorName: string | null;
  createdAt: unknown;
}

/** 按诉求回查分配轨迹（详情/审计用） */
export async function listAssignmentsByComplaint(
  db: Queryable,
  complaintId: string
): Promise<AssignmentLogRow[]> {
  const [rows] = await db.query(
    'select assignment_log_id as assignmentLogId, before_enterprise_code as beforeEnterpriseCode,' +
      ' before_enterprise_name as beforeEnterpriseName, after_enterprise_code as afterEnterpriseCode,' +
      ' after_enterprise_name as afterEnterpriseName, match_type as matchType, reason,' +
      ' operator_name as operatorName, created_at as createdAt' +
      ' from complaint_assignment where complaint_id = ? order by created_at asc, id asc',
    [complaintId]
  );
  return rows as unknown as AssignmentLogRow[];
}
