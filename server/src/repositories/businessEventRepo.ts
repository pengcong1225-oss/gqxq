// business_event（回传业务事件）：event_id 唯一，是 G4 入站的**幂等键**。
// 设计约束：本表只 insert + 在本事务内 update 处理结果，不 delete（迁移设计 §3.3 追加写口径）。
// 并发重复投递靠 event_id 唯一键兜底，撞键后由 service 回读并返回同一 ACK。
import { cut, type Queryable } from './complaintSourceLogRepo';

/** 与 types/api.ts 的 CallbackAcceptedResult.processedResult 对齐 */
export type ProcessedResult = 'applied' | 'ignored' | 'rejected' | 'duplicate';

export interface InsertBusinessEventInput {
  eventId: string;
  /** 已转成小写入库：task_submitted / task_approved / task_rejected / task_returned */
  eventType: string;
  sourceAppCode: string | null;
  sourceBusinessId: string | null;
  taskId: string | null;
  sceneCode: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  /** agreed / disagreed / returned */
  approvalConclusion: string | null;
  templateVersion: number | null;
  submissionVersion: number | null;
  occurredAt: Date | null;
  approvedAt: Date | null;
  /** 事件原文（完整 parsed body） */
  payload: Record<string, unknown>;
  signatureKeyId: string | null;
  signatureKeyVersion: string | null;
  /**
   * 处理结果。落库时先写一个占位值，同一事务内由 updateEventProcessing 覆盖成真实结果；
   * 事务回滚时该行不会留下，所以占位值不会外泄。
   */
  processedResult: ProcessedResult;
  processedMessage: string | null;
  /** 本次返回给对方的 ACK 响应体；重复投递必须返回同一个 */
  ackBody: string | null;
  receivedAt: Date;
}

export interface ExistingBusinessEvent {
  eventId: string;
  eventType: string;
  processedResult: string;
  processedMessage: string | null;
  ackBody: string | null;
  sourceBusinessId: string | null;
  taskId: string | null;
}

/** 幂等查：按 event_id 找已处理过的事件 */
export async function findEventById(
  db: Queryable,
  eventId: string
): Promise<ExistingBusinessEvent | null> {
  const [rows] = await db.query(
    'select event_id as eventId, event_type as eventType, processed_result as processedResult,' +
      ' processed_message as processedMessage, ack_body as ackBody,' +
      ' source_business_id as sourceBusinessId, task_id as taskId' +
      ' from business_event where event_id = ? limit 1',
    [eventId]
  );
  const list = rows as unknown as ExistingBusinessEvent[];
  return list.length > 0 ? list[0] : null;
}

/**
 * 插入事件行。event_id 已被占用时抛 ER_DUP_ENTRY（由 service 捕获并转成"重复投递"分支）。
 * 注意：调用方负责把它放在事务里**靠前**的位置，用它来抢占 eventId，
 * 这样并发重复投递会在任何业务状态变更之前就被唯一键拦下。
 */
export async function insertBusinessEvent(db: Queryable, input: InsertBusinessEventInput): Promise<void> {
  await db.execute(
    'insert into business_event ' +
      '(event_id, event_type, source_app_code, source_business_id, task_id, scene_code,' +
      ' subject_code, subject_name, approval_conclusion, template_version, submission_version,' +
      ' occurred_at, approved_at, payload, signature_key_id, signature_key_version,' +
      ' processed_result, processed_message, ack_body, received_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      cut(input.eventId, 128),
      input.eventType,
      cut(input.sourceAppCode, 64),
      cut(input.sourceBusinessId, 128),
      cut(input.taskId, 128),
      cut(input.sceneCode, 64),
      cut(input.subjectCode, 128),
      cut(input.subjectName, 200),
      cut(input.approvalConclusion, 16),
      input.templateVersion,
      input.submissionVersion,
      input.occurredAt,
      input.approvedAt,
      JSON.stringify(input.payload),
      cut(input.signatureKeyId, 64),
      cut(input.signatureKeyVersion, 32),
      input.processedResult,
      cut(input.processedMessage, 500),
      cut(input.ackBody, 500),
      input.receivedAt,
    ]
  );
}

/** 同一事务内把占位结果覆盖成真实处理结果 */
export async function updateEventProcessing(
  db: Queryable,
  eventId: string,
  processedResult: ProcessedResult,
  processedMessage: string | null
): Promise<number> {
  const [result] = await db.execute(
    'update business_event set processed_result = ?, processed_message = ? where event_id = ?',
    [processedResult, cut(processedMessage, 500), eventId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}
