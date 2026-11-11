import { env } from '../config/env';
import type { Queryable } from './complaintSourceLogRepo';

export interface FinalReportingResult {
  eventId: string;
  value: string | null;
}

/** Caller holds the complaint lock. Never fall back from a task to another round of the complaint. */
export async function readFinalReportingResult(
  db: Queryable, complaintId: string, assignmentId: string | null,
): Promise<FinalReportingResult | null> {
  if (assignmentId === null) return null;
  // Traces are appended only after the complaint lock is acquired. Resolve their exact
  // event IDs first: scanning the inbox by task would lock a late callback that is itself
  // waiting for this complaint, reversing ingestion's event -> complaint lock order.
  const [traces] = await db.query(
    'select event_id as eventId from approval_trace where complaint_id = ? and assignment_id = ?' +
    " and event_type = 'task_approved' and approval_conclusion = 'agreed' order by id desc for update",
    [complaintId, assignmentId],
  );
  for (const trace of traces as Array<{ eventId: string }>) {
    const [rows] = await db.query(
      'select e.event_id as eventId, e.payload from dispatch_order d straight_join business_event e' +
      ' on e.task_id = d.reporting_task_id and e.source_business_id = d.complaint_id' +
      ' and e.subject_code = d.target_enterprise_code' +
      ' where d.assignment_id = ? and d.complaint_id = ? and e.event_id = ?' +
      " and d.status in ('completed', 'archived') and e.source_app_code = ?" +
      " and e.event_type = 'task_approved' and e.approval_conclusion = 'agreed'" +
      " and e.processed_result = 'applied'" +
      " and (coalesce(json_extract(e.payload, '$.contractVersion'), 1) <> 2" +
      " or (json_unquote(json_extract(e.payload, '$.assignmentId')) = d.assignment_id" +
      " and json_unquote(json_extract(e.payload, '$.requestId')) = d.request_id))" +
      ' limit 1 for update',
      [assignmentId, complaintId, trace.eventId, env.pu.appCode],
    );
    const row = (rows as Array<{ eventId: string; payload: unknown }>)[0];
    if (!row) continue;
    let payload: unknown = row.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>).enterpriseDisposalResult;
    return {
      eventId: row.eventId,
      value: value == null ? null : typeof value === 'string' ? value : JSON.stringify(value),
    };
  }
  return null;
}
