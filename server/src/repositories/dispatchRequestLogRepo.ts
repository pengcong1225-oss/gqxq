// dispatch_request_log（追加写）：每一次推送尝试一行，含 nonce / 签名 / 请求体 / 响应体 / 结果。
//
// attempt 的分配口径：uk_drl_request_attempt(request_id, attempt)。
//   attempt 只在同一个 request_id 内唯一，所以取 max(attempt)+1。
//   并发下（比如运维连点两次重推）可能撞键，因此这里捕获重复键后**重算再试**（最多 3 次），
//   而不是让一次真实发生过的推送因为日志写不进去而丢失痕迹。
import { randomUUID } from 'node:crypto';
import { pool, type Row } from '../db/pool';
import type { DispatchRequestLogItem, PushResultKind } from '../types/api';
import { cut, type Queryable } from './complaintSourceLogRepo';
import { isDuplicateKey } from './dispatchRepo';
import { toIso, toNum, toStr } from './complaintMapper';

const MAX_ATTEMPT_ALLOC_TRIES = 3;

export interface RequestLogEntry {
  assignmentId: string;
  complaintId: string | null;
  requestId: string;
  endpoint: string;
  nonce: string | null;
  signature: string | null;
  httpStatus: number | null;
  result: PushResultKind;
  errorCode: string | null;
  errorMessage: string | null;
  taskId: string | null;
  requestBody: string | null;
  responseBody: string | null;
  startedAt: Date;
  finishedAt: Date;
}

async function nextAttempt(db: Queryable, requestId: string): Promise<number> {
  const [rows] = await db.query<Row[]>(
    'select coalesce(max(attempt), 0) + 1 as next_attempt from dispatch_request_log where request_id = ?',
    [requestId]
  );
  const row = (rows as unknown as Array<{ next_attempt: number | string }>)[0];
  return Number(row === undefined ? 1 : row.next_attempt);
}

/** 写一行尝试日志，返回本次分配的 attempt 号 */
export async function insertRequestLog(db: Queryable, entry: RequestLogEntry): Promise<number> {
  const requestLogId = 'DRL-' + randomUUID();
  let lastError: unknown = null;
  for (let tries = 0; tries < MAX_ATTEMPT_ALLOC_TRIES; tries += 1) {
    const attempt = await nextAttempt(db, entry.requestId);
    try {
      await db.execute(
        'insert into dispatch_request_log (' +
          'request_log_id, assignment_id, complaint_id, request_id, direction, endpoint, nonce, signature,' +
          ' http_status, result, error_code, error_message, attempt, task_id, request_body, response_body,' +
          ' started_at, finished_at) ' +
          'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          requestLogId,
          cut(entry.assignmentId, 64),
          cut(entry.complaintId, 64),
          cut(entry.requestId, 128),
          'push',
          cut(entry.endpoint, 255),
          cut(entry.nonce, 128),
          cut(entry.signature, 128),
          entry.httpStatus,
          entry.result,
          cut(entry.errorCode, 64),
          cut(entry.errorMessage, 2000),
          attempt,
          cut(entry.taskId, 128),
          entry.requestBody,
          entry.responseBody,
          entry.startedAt,
          entry.finishedAt,
        ]
      );
      return attempt;
    } catch (err) {
      lastError = err;
      if (!isDuplicateKey(err)) throw err;
      // 撞 uk_drl_request_attempt：说明并发抢了同一个 attempt，重算后再试
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('写入 dispatch_request_log 失败：attempt 分配连续冲突');
}

export function rowToRequestLogItem(r: Record<string, unknown>): DispatchRequestLogItem {
  return {
    id: Number(r.id),
    requestLogId: String(r.request_log_id),
    assignmentId: String(r.assignment_id),
    requestId: String(r.request_id),
    attempt: toNum(r.attempt) ?? 0,
    nonce: toStr(r.nonce),
    httpStatus: toNum(r.http_status),
    result: String(r.result),
    errorCode: toStr(r.error_code),
    errorMessage: toStr(r.error_message),
    taskId: toStr(r.task_id),
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
    createdAt: toIso(r.created_at),
  };
}

export async function findRequestLogsByAssignment(
  assignmentId: string,
  limit: number
): Promise<DispatchRequestLogItem[]> {
  const [rows] = await pool.query<Row[]>(
    'select id, request_log_id, assignment_id, request_id, attempt, nonce, http_status, result,' +
      ' error_code, error_message, task_id, started_at, finished_at, created_at' +
      ' from dispatch_request_log where assignment_id = ? order by attempt asc, id asc limit ?',
    [assignmentId, limit]
  );
  return (rows as unknown as Array<Record<string, unknown>>).map(rowToRequestLogItem);
}
