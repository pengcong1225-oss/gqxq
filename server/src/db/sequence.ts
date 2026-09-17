// 按日发号器。
// 沿用现有编号格式：前缀 + yyyyMMdd + 4 位序号（真实样本见 docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md §3.1）
//   complaint_id  CPL202606240001
//   complaint_no  CS202606240001
//   assignment_id ASGN202606240001
//   order_no      JB202606240001
import type { Tx } from './tx';

const SEQ_PAD = 4;

/** 取 Asia/Shanghai 的业务日期，返回 yyyy-MM-dd */
export function shanghaiDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

/**
 * 原子发号：LAST_INSERT_ID(expr) 既写入又读回，插入与更新两条路径都不存在竞态。
 * 必须在与业务写入同一事务内调用，避免失败时空耗序号。
 */
export async function nextSequence(tx: Tx, seqKey: string, isoDate: string): Promise<number> {
  const [result] = await tx.query(
    'insert into number_sequence (seq_key, biz_date, current_value) values (?, ?, last_insert_id(1)) ' +
      'on duplicate key update current_value = last_insert_id(current_value + 1)',
    [seqKey, isoDate]
  );
  // 必须在**同一条语句**里取回分配值：mysql2 的 insertId 就是 LAST_INSERT_ID(expr) 的结果。
  // 不要写成 "insert 之后再 select last_insert_id()"——同一连接并发时，
  // 多条 insert 会先全部执行，随后所有 select 都读到最后一个值，导致重号（实测 3 路并发全部拿到 3）。
  const allocated = Number((result as { insertId?: number }).insertId);
  if (!Number.isInteger(allocated) || allocated < 1) {
    throw new Error('发号失败 ' + seqKey + '/' + isoDate + '：insertId=' + String(allocated));
  }
  return allocated;
}

export function formatBizNo(prefix: string, isoDate: string, seq: number): string {
  return prefix + compactDate(isoDate) + String(seq).padStart(SEQ_PAD, '0');
}

/** 一次拿到 "编号 + 序号" 的便捷封装 */
export async function allocateBizNo(
  tx: Tx,
  seqKey: string,
  prefix: string,
  isoDate: string
): Promise<string> {
  const seq = await nextSequence(tx, seqKey, isoDate);
  return formatBizNo(prefix, isoDate, seq);
}
