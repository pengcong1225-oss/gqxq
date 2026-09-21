// app_user 表的数据访问层。
// 纪律：只写手写参数化 SQL，不引入 ORM，不用 select *（列清单与 M1 迁移逐字对应）。
// 时间口径以 db/pool.ts 为准：列里存的是 **Asia/Shanghai 墙钟**，连接池 timezone='+08:00'；
// 写库传 Date 即按墙钟落，读出的 Date 再 toISOString() 得到对外 UTC 串。
import type { AppRole, UserInfo, UserAdminFilter, UserAdminItem } from '../types/api';

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

/**
 * 鉴权用的**最小身份视图**（Task #35 收尾补）。
 *
 * 为什么需要它：JWT 载荷里带着 `roles` 声明，TTL 8 小时。RBAC 上线后角色就是
 * 授权依据，如果 requireAuth 只验签名、直接拿令牌里的 roles，那么
 * PATCH /users 的「禁用」「降级」要等到对方令牌自然过期才生效 ——
 * 被降级的 admin 在这 8 小时里照样能进 /users。令牌只证明**身份**，
 * 档位与启停状态必须以这一条查询的结果为准（默认拒绝的延伸：查不到即拒绝）。
 *
 * 与 findByUsername/findByUserId 的区别：这里**绝不 select password_hash**
 * （每个鉴权请求都会走它，不该顺带把哈希读进内存），也不带 permissions（不参与鉴权）。
 */
export interface AuthIdentity {
  userId: string;
  username: string;
  roles: string[];
  status: number;
}

export async function findAuthIdentity(
  exec: SqlExecutor,
  userId: string
): Promise<AuthIdentity | null> {
  const rows = await queryRows(
    exec,
    'select user_id, username, roles, status from app_user where user_id = ? limit 1',
    [userId]
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    userId: toStr(row.user_id),
    username: toStr(row.username),
    roles: toStringArray(row.roles),
    status: toNum(row.status),
  };
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

/* ==================== 用户管理（Task #35） ====================
 * 与上面登录路径分开写：登录**必须**读 password_hash，用户管理**绝不**读它。
 * 因此这里的 SELECT 列表单独一套（ADMIN_USER_COLUMNS 里没有 password_hash），
 * 不靠"读出来再删掉字段" —— 少一条能把哈希带出仓储层的路径。
 */

/** SqlExecutor.query 的返回是 unknown；行集在这里统一收窄（与 queryOne 同一口径） */
async function queryRows(exec: SqlExecutor, sql: string, values?: unknown[]): Promise<Row[]> {
  const result = (await exec.query(sql, values)) as [unknown, unknown];
  return Array.isArray(result[0]) ? (result[0] as Row[]) : [];
}

const ADMIN_USER_COLUMNS =
  'id, user_id, username, real_name, roles, status, last_login_at, created_at';

/** 管理视图的行：与 AppUserRow 的差别只在没有 password_hash / permissions */
export interface AdminUserRow {
  userId: string;
  username: string;
  realName: string;
  roles: string[];
  status: number;
  lastLoginAt: Date | null;
  createdAt: Date | null;
}

function toBoolStatus(v: number): 0 | 1 {
  return v === 1 ? 1 : 0;
}

function mapAdminRow(r: Row): AdminUserRow {
  return {
    userId: toStr(r.user_id),
    username: toStr(r.username),
    realName: toStr(r.real_name),
    roles: toStringArray(r.roles),
    status: toNum(r.status),
    lastLoginAt: toDateOrNull(r.last_login_at),
    createdAt: toDateOrNull(r.created_at),
  };
}

function buildAdminWhere(filter: UserAdminFilter): { text: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.keyword !== undefined) {
    // 转义 '!' 而不是反斜杠（与 enterpriseRepo / complaintRepo 同口径：
    // 反斜杠转义在本机 MySQL 的默认 sql_mode 下会报语法错误）
    const kw = '%' + filter.keyword.replace(/[!%_]/g, (m) => '!' + m) + '%';
    parts.push("(username like ? escape '!' or real_name like ? escape '!')");
    params.push(kw, kw);
  }
  if (filter.role !== undefined) {
    // roles 是 json 列；json_contains 对 ["admin"] 这类标量数组成立（MySQL 5.7+/8）
    parts.push("json_contains(roles, json_quote(?))");
    params.push(filter.role);
  }
  if (filter.status !== undefined) {
    parts.push('status = ?');
    params.push(filter.status);
  }
  return { text: parts.length > 0 ? ' where ' + parts.join(' and ') : '', params };
}

/** 分页的**行**（不是 DTO）：roleNames 由服务层补，仓储层不碰展示口径 */
export type AdminUserPage = {
  content: AdminUserRow[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
};

/** 分页列表（id 倒序 = 新号在前；同 id 不会出现两次，主键自增） */
export async function listAdminUsers(
  exec: SqlExecutor,
  filter: UserAdminFilter,
  page: number,
  size: number
): Promise<AdminUserPage> {
  const where = buildAdminWhere(filter);
  const countRows = await queryRows(
    exec,
    'select count(*) as total from app_user' + where.text,
    where.params
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await queryRows(
    exec,
    'select ' + ADMIN_USER_COLUMNS + ' from app_user' + where.text +
      ' order by id desc limit ? offset ?',
    [...where.params, size, (page - 1) * size]
  );
  return {
    content: rows.map(mapAdminRow),
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
  };
}

/** 建号。user_id 由调用方在事务内发号后传入，本函数不碰发号器。 */
export async function insertUser(
  exec: SqlExecutor,
  input: {
    userId: string;
    username: string;
    passwordHash: string;
    realName: string;
    roles: AppRole[];
    permissions: string[];
    now: Date;
  }
): Promise<void> {
  await exec.query(
    'insert into app_user ' +
      '(user_id, username, password_hash, real_name, roles, permissions, status, created_at, updated_at) ' +
      'values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    [
      input.userId,
      input.username,
      input.passwordHash,
      input.realName,
      JSON.stringify(input.roles),
      JSON.stringify(input.permissions),
      input.now,
      input.now,
    ]
  );
}

/** username 是否已占用（建号前置查重，也用来把 ER_DUP_ENTRY 之外的竞态兜住） */
export async function existsUsername(exec: SqlExecutor, username: string): Promise<boolean> {
  const rows = await queryRows(exec, 'select 1 from app_user where username = ? limit 1', [username]);
  return rows.length > 0;
}

/** 按 user_id 查管理视图（改号前取当前值，用于防呆判定与审计 before/after） */
export async function findAdminUserByUserId(
  exec: SqlExecutor,
  userId: string
): Promise<AdminUserRow | null> {
  const rows = await queryRows(
    exec,
    'select ' + ADMIN_USER_COLUMNS + ' from app_user where user_id = ? limit 1',
    [userId]
  );
  return rows.length > 0 ? mapAdminRow(rows[0]) : null;
}

/**
 * 启用中的 admin 人数。防呆用它：最后一个 admin 不能被禁用或降级，
 * 否则系统里再没有人能建号 / 改角色 —— 把自己锁死在门外。
 */
export async function countEnabledAdmins(exec: SqlExecutor): Promise<number> {
  const rows = await queryRows(
    exec,
    "select count(*) as total from app_user where status = 1 and json_contains(roles, json_quote('admin'))"
  );
  return Number(rows[0]?.total ?? 0);
}

/** 局部更新：real_name / roles / status 各自可缺省，未传的列不进 SET */
export async function updateUser(
  exec: SqlExecutor,
  userId: string,
  patch: {
    realName?: string;
    roles?: AppRole[];
    status?: 0 | 1;
    now: Date;
  }
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [patch.now];
  if (patch.realName !== undefined) {
    sets.push('real_name = ?');
    params.push(patch.realName);
  }
  if (patch.roles !== undefined) {
    sets.push('roles = ?');
    params.push(JSON.stringify(patch.roles));
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  params.push(userId);
  await exec.query('update app_user set ' + sets.join(', ') + ' where user_id = ?', params);
}

/** 管理视图 DTO（契约真源：types/api.ts 的 UserAdminItem）。roleNames 由服务层补。 */
export function toAdminUserItem(row: AdminUserRow): Omit<UserAdminItem, 'roleNames'> {
  return {
    userId: row.userId,
    username: row.username,
    realName: row.realName,
    roles: row.roles.map((r) => r as AppRole),
    status: toBoolStatus(row.status),
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    createdAt: row.createdAt === null ? null : row.createdAt.toISOString(),
  };
}
