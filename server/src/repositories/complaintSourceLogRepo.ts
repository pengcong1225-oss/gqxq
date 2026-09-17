// complaint_source_log（追加写）：每次外部投递都留一条，含重复投递与被拒报文。
// 设计约束：本表只 insert，不 update、不 delete（迁移设计 §3.3）。
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';

/** 事务内（PoolConnection）与事务外（Pool）都能用的最小句柄 */
export type Queryable = Pool | PoolConnection;

export type IntakeResultCode = 'created' | 'duplicate_same' | 'updated' | 'rejected';

export interface SourceLogEntry {
  sourceSystem: string;
  sourceId: string;
  /** 落库成功时回填；被拒时为 null */
  complaintId: string | null;
  payloadHash: string;
  /** 原始报文（完整 parsed body，便于与 payload_hash 互相校验） */
  payload: Record<string, unknown>;
  result: IntakeResultCode;
  message: string | null;
  remoteIp: string | null;
  requestId: string | null;
  /** 接收时间，一律传 UTC Date */
  receivedAt: Date;
}

export function cut(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

export async function insertSourceLog(db: Queryable, entry: SourceLogEntry): Promise<string> {
  const logId = 'CSL-' + randomUUID();
  await db.execute(
    'insert into complaint_source_log ' +
      '(log_id, source_system, source_id, complaint_id, payload_hash, payload, result, message, remote_ip, request_id, received_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      logId,
      cut(entry.sourceSystem, 64),
      cut(entry.sourceId, 128),
      cut(entry.complaintId, 64),
      entry.payloadHash,
      JSON.stringify(entry.payload),
      entry.result,
      cut(entry.message, 500),
      cut(entry.remoteIp, 64),
      cut(entry.requestId, 64),
      entry.receivedAt,
    ]
  );
  return logId;
}
