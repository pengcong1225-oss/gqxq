// mysql2 连接池：运行期**唯一**的数据访问入口。
// 业务查询一律走 repositories 里手写的参数化 SQL，不使用 ORM。
import mysql from 'mysql2/promise';
import { env } from '../config/env';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4',
  // 时区口径（2026-09-17 实测修正，务必不要改回 'Z'）：
  //   gqxq_service 里的 DATETIME 存的是 **Asia/Shanghai 墙钟时间**，证据有三：
  //     1) MySQL 服务器 TIMEDIFF(NOW(), UTC_TIMESTAMP()) = 08:00:00；
  //     2) 既有数据 complaint.created_at = 2026-06-29 13:40:36，与 Flyway 安装时刻同刻（本地墙钟）；
  //     3) 平台侧 JDBC 连接串用的是 serverTimezone=Asia/Shanghai。
  //   若这里写 'Z'，mysql2 会把墙钟当 UTC 读，同一行比真实时刻晚 8 小时，
  //   并与平台侧（Java）对同一行的解释相差 8 小时。
  //   对外 API 仍返回 ISO-8601 UTC（toISOString 得到 Z），由前端本地化展示。
  timezone: '+08:00',
  dateStrings: false,
  namedPlaceholders: true,
  // 禁止多语句，防注入踩踏
  multipleStatements: false,
});

/** 启动时校验数据库连通；失败即让进程退出（反 Mock 回退门禁） */
export async function assertDbReachable(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('select 1');
  } finally {
    conn.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export type Row = mysql.RowDataPacket;
export type ResultSetHeader = mysql.ResultSetHeader;
