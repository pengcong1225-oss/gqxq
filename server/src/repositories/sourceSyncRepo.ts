// G6 来源同步的数据访问。复用既有的 sync_log 表，不新增日志表。
import { randomUUID } from 'node:crypto';
import { pool, type Row } from '../db/pool';
import type { Tx } from '../db/tx';

export interface ComplaintSourceRow {
  complaint_id: string;
  complaint_no: string;
  source_system: string | null;
  source_id: string | null;
  source_event_status: string;
  source_synced_at: Date | null;
}

const SYNC_COLUMNS =
  'complaint_id, complaint_no, source_system, source_id, source_event_status, source_synced_at';

/**
 * 按 数值 id / complaint_id / complaint_no 三种形式查。
 * 不用一条 SQL 混着比，避免 varchar 与数字隐式转换导致索引失效。
 */
export async function findComplaintForSync(idOrNo: string): Promise<ComplaintSourceRow | null> {
  const trimmed = idOrNo.trim();
  if (trimmed === '') return null;
  const numeric = /^\d+$/.test(trimmed);
  const sql = numeric
    ? 'select ' + SYNC_COLUMNS + ' from complaint where deleted = 0 and id = ? limit 1'
    : 'select ' + SYNC_COLUMNS + ' from complaint where deleted = 0 and (complaint_id = ? or complaint_no = ?) limit 1';
  const params = numeric ? [Number(trimmed)] : [trimmed, trimmed];
  const [rows] = await pool.query<Row[]>(sql, params);
  const row = (rows as unknown as ComplaintSourceRow[])[0];
  return row ?? null;
}

export interface SyncLogInput {
  complaintId: string;
  result: string;
  requestBody: string | null;
  responseBody: string | null;
  errorMessage: string | null;
}

export async function insertSyncLog(tx: Tx, input: SyncLogInput): Promise<void> {
  await tx.execute(
    'insert into sync_log (sync_log_id, app_code, target_system, biz_type, biz_id, result, ' +
      'request_body, response_body, retry_count, error_message) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    [
      'SYNC-' + randomUUID(),
      'gqxq',
      'yijiejieban',
      'complaint',
      input.complaintId,
      input.result,
      input.requestBody,
      input.responseBody,
      input.errorMessage,
    ]
  );
}

/**
 * 更新来源事件状态。
 *
 * **只写这两列**：source_event_status 与 source_synced_at。
 * 来源适配器**不得**触碰 reporting_status（填报审批结果）或 closed_*（本系统办结）——
 * 这是 G6 的硬验收项（适配器失败或成功都不改变填报结果与本系统办结状态）。
 * 因此这里刻意不提供"通用更新"入口，只有这一个窄接口。
 */
export async function updateSourceEventStatus(
  tx: Tx,
  complaintId: string,
  code: string,
  syncedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    'update complaint set source_event_status = ?, source_synced_at = ? where complaint_id = ?',
    [code, syncedAt, complaintId]
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}
