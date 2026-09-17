// app_user 表的数据访问层。
// 纪律：只写手写参数化 SQL，不引入 ORM，不用 select *（列清单与 M1 迁移逐字对应）。
// 时间列存 UTC（连接池 timezone 为 Z，写库时传 Date，mysql2 会按 UTC 序列化）。
import type { UserInfo } from '../types/api';

/**
 * 允许在「连接池」或「事务连接」上执行 SQL 的最小接口。
 * 这样登录成功时的 last_login_at 更新与审计写入可以落在同一个事务里。
 */
export interface SqlExecutor {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

type Row = Record<string, unknown>;

export interface AppUserRow {
  id: number;
  userId: string;
  username: string;
  passwordHash: string;
  realName: string;
  roles: string[];
  permissions: string[];
  status: number;
  lastLoginAt: Date | null;
}

const APP_USER_COLUMNS =
  'id, user_id, username, password_hash, real_name, roles, permissions, status, last_login_at';

function toStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * roles / permissions 是 json 列；mysql2 依配置可能返回已解析的数组或原始字符串。
 * 非数组一律返回空数组，绝不猜测内容。
 */
function toStringArray(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  let parsed: unknown = v;
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((x) => String(x)).filter((s) => s !== '');
}

function toDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapRow(r: Row): AppUserRow {
  return {
    id: toNum(r.id),
    userId: toStr(r.user_id),
    username: toStr(r.username),
    passwordHash: toStr(r.password_hash),
    realName: toStr(r.real_name),
    roles: toStringArray(r.roles),
    permissions: toStringArray(r.permissions),
    status: toNum(r.status),
    lastLoginAt: toDateOrNull(r.last_login_at),
  };
}

async function queryOne(
  exec: SqlExecutor,
  sql: string,
  values: unknown[]
): Promise<AppUserRow | null> {
  const result = (await exec.query(sql, values)) as [unknown, unknown];
  const rows = Array.isArray(result[0]) ? (result[0] as Row[]) : [];
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** 按登录名查（不带启用状态过滤，供登录路径统一处理"不存在/停用/口令错"） */
export async function findByUsername(
  exec: SqlExecutor,
  username: string
): Promise<AppUserRow | null> {
  return queryOne(
    exec,
    'select ' + APP_USER_COLUMNS + ' from app_user where username = ? limit 1',
    [username]
  );
}

/** 按业务主键 user_id 查（供 /auth/user-info 用令牌里的 sub 反查最新身份与权限） */
export async function findByUserId(
  exec: SqlExecutor,
  userId: string
): Promise<AppUserRow | null> {
  return queryOne(
    exec,
    'select ' + APP_USER_COLUMNS + ' from app_user where user_id = ? limit 1',
    [userId]
  );
}

/** 登录成功时记录最近登录时间（写入绝对时刻，按 UTC 落库） */
export async function touchLastLogin(
  exec: SqlExecutor,
  userId: string,
  at: Date
): Promise<void> {
  await exec.query('update app_user set last_login_at = ? where user_id = ?', [at, userId]);
}

/** 数据库行 -> 对外 DTO（契约唯一真源：types/api.ts 的 UserInfo） */
export function toUserInfo(row: AppUserRow): UserInfo {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    realName: row.realName,
    roles: row.roles,
    permissions: row.permissions,
  };
}
