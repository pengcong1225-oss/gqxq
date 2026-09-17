// complaint_disposition（追加写）：归库处置留痕。
//
// 两种处置（落地计划 G2）：
//   no_dispatch_needed  无需交办归库
//   false_positive      误报归库
// 两者都只留痕 + 把督办状态归位，**绝不产生任何交办**。
// is_sensitive 不改：自动命中的事实要保留，"这是误报"的判定记在本表里，便于回查对比。
import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx';
import { cut, type Queryable } from './complaintSourceLogRepo';

export type DispositionKindCode = 'no_dispatch_needed' | 'false_positive';

export const DISPOSITION_KINDS: readonly DispositionKindCode[] = ['no_dispatch_needed', 'false_positive'];

export function isDispositionKind(value: unknown): value is DispositionKindCode {
  return typeof value === 'string' && (DISPOSITION_KINDS as readonly string[]).includes(value);
}

export interface InsertDispositionInput {
  complaintId: string;
  disposition: DispositionKindCode;
  /** 处置前是否敏感，便于日后回查"当时判定为误报"的依据 */
  isSensitiveBefore: boolean;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  createdAt: Date;
}

export async function insertDisposition(tx: Tx, input: InsertDispositionInput): Promise<string> {
  const dispositionId = 'DSP-' + randomUUID();
  await tx.execute(
    'insert into complaint_disposition ' +
      '(disposition_id, complaint_id, disposition, is_sensitive_before, reason, operator_id, operator_name, created_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      dispositionId,
      cut(input.complaintId, 64),
      input.disposition,
      input.isSensitiveBefore ? 1 : 0,
      cut(input.reason, 500),
      cut(input.operatorId, 64),
      cut(input.operatorName, 64),
      input.createdAt,
    ]
  );
  return dispositionId;
}

/** 归库后督办状态归位为 none（无需交办 / 误报都不再需要交办） */
export async function updateComplaintAfterDisposition(
  tx: Tx,
  complaintId: string,
  updatedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    "update complaint set supervision_status = 'none', updated_at = ? where complaint_id = ?",
    [updatedAt, complaintId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

export interface DispositionRow {
  dispositionId: string;
  disposition: string;
  isSensitiveBefore: boolean;
  reason: string | null;
  operatorName: string | null;
  createdAt: unknown;
}

/** 按诉求回查处置轨迹（详情/审计用） */
export async function listDispositionsByComplaint(
  db: Queryable,
  complaintId: string
): Promise<DispositionRow[]> {
  const [rows] = await db.query(
    'select disposition_id as dispositionId, disposition, is_sensitive_before as isSensitiveBefore,' +
      ' reason, operator_name as operatorName, created_at as createdAt' +
      ' from complaint_disposition where complaint_id = ? order by created_at asc, id asc',
    [complaintId]
  );
  return rows as unknown as DispositionRow[];
}
