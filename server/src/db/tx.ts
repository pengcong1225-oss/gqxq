// 事务辅助。
import type { PoolConnection } from 'mysql2/promise';
import { pool } from './pool';

export type Tx = PoolConnection;

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // 回滚失败不掩盖原始异常
    }
    throw err;
  } finally {
    conn.release();
  }
}
