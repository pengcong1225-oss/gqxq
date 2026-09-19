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
  overtime_flag: number | null;
  source_synced_at: Date | null;
}

const SYNC_COLUMNS =
  'complaint_id, complaint_no, source_system, source_id, source_event_status, overtime_flag, source_synced_at';

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
 * 更新来源事件状态与超期时效标记。
 *
 * **只写这三列**：source_event_status、overtime_flag、source_synced_at。
 * 来源适配器**不得**触碰 reporting_status（填报审批结果）或 closed_*（本系统办结）——
 * 这是 G6 的硬验收项（适配器失败或成功都不改变填报结果与本系统办结状态）。
 * 因此这里刻意不提供"通用更新"入口，只有这一个窄接口；overtime_flag 也**只有**这里能写
 * （静态扫描见 scripts/verify-source-adapter.mjs G6-3 与 scripts/verify-file-source-adapter.ts F5）。
 *
 * overtimeFlag 传 null 表示"来源没给时效信息"，落库就是 NULL——**不压成 0**。
 *
 * 判重口径（M11 复核过，别加"无变化就跳过"的短路）：
 *   这里**不做**"来源状态没变即跳过"的判断——来源一旦给出可映射的原文就整条窄更新写回。
 *   若图省事加上 `if (code === row.source_event_status) return 0`，会漏掉两类真实变化：
 *     1) 「正常在办」(processing, NULL) -> 「超期结案」(completed, 1)：两轴都动，状态轴能救回来；
 *     2) 「正常结案」(completed, 0) -> 「超期结案」(completed, 1)：**状态轴完全没动**，
 *        只有 overtime_flag 该变——按状态判重就会静默丢掉这一次更正。
 *   另外 source_synced_at 每次都要刷新，所以这里也不存在"白写一次 UPDATE"的成本问题。
 */
export async function updateSourceEventStatus(
  tx: Tx,
  complaintId: string,
  code: string,
  overtimeFlag: 0 | 1 | null,
  syncedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    'update complaint set source_event_status = ?, overtime_flag = ?, source_synced_at = ? where complaint_id = ?',
    [code, overtimeFlag, syncedAt, complaintId]
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}
