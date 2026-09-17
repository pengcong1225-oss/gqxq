// report_todo（待查报告待办）。
//
// 本批次只做**待办入口**：报告正文、审批与发布规则待业务确认，不在这里造模板（落地计划 G5）。
// uk_rt_analysis 保证"一条分析记录只生成一个待查入口"。
import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx';
import type { ReportTodoItem, ReportTodoStatus } from '../types/api';
import { cut, type Queryable } from './complaintSourceLogRepo';
import { toIso } from './complaintMapper';
import { isDuplicateKey } from './dispatchRepo';

export const REPORT_TODO_STATUSES: readonly ReportTodoStatus[] = ['pending', 'in_progress', 'done'];

export function isReportTodoStatus(value: unknown): value is ReportTodoStatus {
  return typeof value === 'string' && (REPORT_TODO_STATUSES as readonly string[]).includes(value);
}

const STATUS_LABELS: Record<ReportTodoStatus, string> = {
  pending: '待生成',
  in_progress: '生成中',
  done: '已完成',
};

export interface ReportTodoRow {
  id: number;
  todoId: string;
  analysisId: string;
  complaintId: string;
  reportId: string | null;
  status: string;
  note: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export function rowToReportTodoItem(r: ReportTodoRow): ReportTodoItem {
  const status = String(r.status);
  return {
    id: Number(r.id),
    todoId: String(r.todoId),
    analysisId: String(r.analysisId),
    complaintId: String(r.complaintId),
    reportId: r.reportId === null || r.reportId === undefined ? null : String(r.reportId),
    status: isReportTodoStatus(status) ? status : 'pending',
    statusName: isReportTodoStatus(status) ? STATUS_LABELS[status] : status,
    note: r.note === null || r.note === undefined ? null : String(r.note),
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

const SELECT_COLUMNS =
  'id, todo_id as todoId, analysis_id as analysisId, complaint_id as complaintId,' +
  ' report_id as reportId, status, note, created_at as createdAt, updated_at as updatedAt';

export interface InsertTodoOutcome {
  todoId: string;
  created: boolean;
}

/** 幂等：撞 uk_rt_analysis 时回读既有待办并返回 created=false */
export async function insertTodoIfAbsent(
  tx: Tx,
  input: { analysisId: string; complaintId: string; note: string | null; createdAt: Date }
): Promise<InsertTodoOutcome> {
  const todoId = 'RPT-' + randomUUID();
  try {
    await tx.execute(
      'insert into report_todo (todo_id, analysis_id, complaint_id, report_id, status, note, created_at) ' +
        "values (?, ?, ?, null, 'pending', ?, ?)",
      [
        todoId,
        cut(input.analysisId, 64),
        cut(input.complaintId, 64),
        cut(input.note, 500),
        input.createdAt,
      ]
    );
    return { todoId, created: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const [rows] = await tx.query(
      'select todo_id as todoId from report_todo where analysis_id = ? limit 1',
      [input.analysisId]
    );
    const row = (rows as unknown as Array<{ todoId: string }>)[0];
    if (!row) throw err;
    return { todoId: String(row.todoId), created: false };
  }
}

export async function findTodoPage(
  db: Queryable,
  filter: { status?: string },
  page: number,
  size: number
): Promise<{ content: ReportTodoItem[]; total: number }> {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    parts.push('status = ?');
    params.push(filter.status);
  }
  const where = parts.length > 0 ? ' where ' + parts.join(' and ') : '';

  const [countRows] = await db.query('select count(*) as total from report_todo' + where, params);
  const total = Number((countRows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from report_todo' + where +
      ' order by created_at desc, id desc limit ? offset ?',
    [...params, size, (page - 1) * size]
  );
  return { content: (rows as unknown as ReportTodoRow[]).map(rowToReportTodoItem), total };
}

export async function findTodoByAnalysisId(
  db: Queryable,
  analysisId: string
): Promise<ReportTodoItem | null> {
  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from report_todo where analysis_id = ? limit 1',
    [analysisId]
  );
  const row = (rows as unknown as ReportTodoRow[])[0];
  return row ? rowToReportTodoItem(row) : null;
}
