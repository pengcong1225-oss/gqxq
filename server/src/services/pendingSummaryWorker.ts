import { pool } from '../db/pool';
import { findRecentlyChangedPendingComplaints, refreshPendingSummary, refreshPendingSummaryFor } from '../repositories/correctionRepo';

/**
 * 待纠偏队列汇总刷新。
 *
 * 策略（队列页只读汇总表，避免每次分页扫描 26 万条纠偏项）：
 *   * 启动时全量重建一次；
 *   * 每 20 秒做一次增量：只刷新近 2 分钟内新增/处理的纠偏项所属诉求（通常几条到几十条）；
 *   * 每 30 分钟全量重建一次，纠正增量可能漏掉的情况。
 */
export function startPendingSummaryWorker(incrementalMs = 20_000, fullMs = 30 * 60_000) {
  let busy = false;
  let since = new Date();
  const incremental = async () => {
    if (busy) return;
    busy = true;
    try {
      const ids = await findRecentlyChangedPendingComplaints(pool, since);
      for (const id of ids) await refreshPendingSummaryFor(pool, id);
      since = new Date(Date.now() - 120_000); // 留 2 分钟重叠，避免时钟/长事务漏项
    } catch {
      console.error('[pending-summary] incremental refresh failed');
    } finally {
      busy = false;
    }
  };
  const full = async () => {
    if (busy) return;
    busy = true;
    try {
      const total = await refreshPendingSummary(pool);
      console.log('[pending-summary] full rebuild ' + total + ' complaints');
      since = new Date(Date.now() - 120_000);
    } catch {
      console.error('[pending-summary] full rebuild failed; keeping previous snapshot');
    } finally {
      busy = false;
    }
  };
  void full();
  const incTimer = setInterval(() => void incremental(), incrementalMs);
  const fullTimer = setInterval(() => void full(), fullMs);
  incTimer.unref();
  fullTimer.unref();
  return () => {
    clearInterval(incTimer);
    clearInterval(fullTimer);
  };
}
