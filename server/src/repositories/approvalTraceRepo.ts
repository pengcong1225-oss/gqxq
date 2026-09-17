// approval_trace（追加写）：签收/提交/退回/最终审批轨迹。
// 一条回传事件被**匹配到交办**时写一行；未匹配到交办的事件只在 business_event 留痕，不写轨迹。
// 设计约束：只 insert，不 update、不 delete（迁移设计 §3.3）。
import { randomUUID } from 'node:crypto';
import type { ApprovalTraceItem } from '../types/api';
import { cut, type Queryable } from './complaintSourceLogRepo';
import { toIso } from './complaintMapper';

export interface InsertApprovalTraceInput {
  complaintId: string | null;
  assignmentId: string | null;
  taskId: string;
  eventId: string;
  /** 已规范化的小写事件类型 */
  eventType: string;
  approvalConclusion: string | null;
  submissionVersion: number | null;
  actorName: string | null;
  occurredAt: Date;
  summary: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export async function insertApprovalTrace(db: Queryable, input: InsertApprovalTraceInput): Promise<string> {
  const traceId = 'ATR-' + randomUUID();
  await db.execute(
    'insert into approval_trace ' +
      '(trace_id, complaint_id, assignment_id, task_id, event_id, event_type, approval_conclusion,' +
      ' submission_version, actor_name, occurred_at, summary, detail, created_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      traceId,
      cut(input.complaintId, 64),
      cut(input.assignmentId, 64),
      cut(input.taskId, 128),
      cut(input.eventId, 128),
      input.eventType,
      cut(input.approvalConclusion, 16),
      input.submissionVersion,
      cut(input.actorName, 64),
      input.occurredAt,
      cut(input.summary, 500),
      input.detail === null ? null : JSON.stringify(input.detail),
      input.createdAt,
    ]
  );
  return traceId;
}

/** 交办详情页的审批轨迹（按发生时间升序，同刻按自增 id 稳定排序） */
export async function listTracesByAssignment(
  db: Queryable,
  assignmentId: string
): Promise<ApprovalTraceItem[]> {
  const [rows] = await db.query(
    'select id, trace_id as traceId, task_id as taskId, event_id as eventId, event_type as eventType,' +
      ' approval_conclusion as approvalConclusion, submission_version as submissionVersion,' +
      ' actor_name as actorName, occurred_at as occurredAt, summary' +
      ' from approval_trace where assignment_id = ? order by occurred_at asc, id asc',
    [assignmentId]
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    traceId: String(r.traceId),
    taskId: String(r.taskId),
    eventId: String(r.eventId),
    eventType: String(r.eventType),
    approvalConclusion: r.approvalConclusion === null || r.approvalConclusion === undefined
      ? null
      : String(r.approvalConclusion),
    submissionVersion:
      r.submissionVersion === null || r.submissionVersion === undefined
        ? null
        : Number(r.submissionVersion),
    actorName: r.actorName === null || r.actorName === undefined ? null : String(r.actorName),
    occurredAt: toIso(r.occurredAt),
    summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
  }));
}
