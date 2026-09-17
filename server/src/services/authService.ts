// 鉴权服务：bcrypt 口令校验 + JWT 签发 + 登录审计。
// 设计要点（见 docs/2026-09-17-诉求平台G1详细实施方案.md §5.9）：
//   * 对外不区分"用户不存在 / 口令错误 / 已停用"，统一 401，防用户名枚举
//   * JWT 载荷只放 sub / username / roles，权限明细一律从库读（便于回收）
//   * 登录成功与失败都写 operation_audit_log（复用既有表，不新建 audit_log）
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { AppError } from '../http/errors';
import type { LoginResult, UserInfo } from '../types/api';
import {
  findByUserId,
  findByUsername,
  toUserInfo,
  touchLastLogin,
  type SqlExecutor,
} from '../repositories/userRepo';

export interface LoginContext {
  clientIp: string;
  requestId: string;
}

const APP_CODE = 'gqxq';
const RESOURCE_CODE = 'auth';
// 动作名沿用既有 operation_audit_log 口径（大写动作名），并非业务枚举。
const ACTION_LOGIN = 'LOGIN'; // gate-g1-allow
const ACTION_LOGIN_FAILED = 'LOGIN_FAILED'; // gate-g1-allow
const RESULT_SUCCESS = 'success';
const RESULT_FAILURE = 'failure';

/**
 * 用户名不存在时也执行一次 bcrypt 比较，抹平"用户是否存在"的响应耗时差异（防枚举）。
 * 注意：这不是默认口令——它是每次进程启动随机生成、永不匹配任何输入的哈希。
 */
const TIMING_DUMMY_HASH = bcrypt.hashSync(randomUUID(), 10);

const AUDIT_INSERT_SQL =
  'insert into operation_audit_log ' +
  '(audit_id, user_id, app_code, resource_code, action, biz_type, biz_id, result, client_ip, detail, created_at) ' +
  'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

interface AuditRecord {
  auditId: string;
  userId: string | null;
  action: string;
  result: string;
  bizId: string | null;
  clientIp: string;
  detail: string;
}

async function writeAudit(exec: SqlExecutor, rec: AuditRecord): Promise<void> {
  const ip = rec.clientIp === '' ? null : rec.clientIp;
  await exec.query(AUDIT_INSERT_SQL, [
    rec.auditId,
    rec.userId,
    APP_CODE,
    RESOURCE_CODE,
    rec.action,
    RESOURCE_CODE,
    rec.bizId,
    rec.result,
    ip,
    rec.detail,
    new Date(),
  ]);
}

/** 登录失败原因只写进审计明细，不进对外响应 */
function failureReason(userExists: boolean, matched: boolean): string {
  if (!userExists) return 'unknown_user';
  if (!matched) return 'bad_password';
  return 'disabled_user';
}

export async function login(
  username: string,
  password: string,
  ctx: LoginContext
): Promise<LoginResult> {
  const user = await findByUsername(pool, username);
  const hash = user === null ? TIMING_DUMMY_HASH : user.passwordHash;
  const matched = await bcrypt.compare(password, hash);

  if (user === null || !matched || user.status !== 1) {
    // 审计必须落库后才对外返回 401（禁止"无声失败"）
    await writeAudit(pool, {
      auditId: randomUUID(),
      userId: user === null ? null : user.userId,
      action: ACTION_LOGIN_FAILED,
      result: RESULT_FAILURE,
      bizId: username,
      clientIp: ctx.clientIp,
      detail: JSON.stringify({
        username,
        reason: failureReason(user !== null, matched),
        requestId: ctx.requestId,
      }),
    });
    throw AppError.unauthenticated('用户名或密码错误');
  }

  // 载荷只放 sub / username / roles；权限明细由 /auth/user-info 查库返回
  const token = jwt.sign(
    { sub: user.userId, username: user.username, roles: user.roles },
    env.jwtSecret,
    { algorithm: 'HS256', expiresIn: env.jwtTtlSeconds }
  );

  const now = new Date();
  await withTransaction(async (tx) => {
    await touchLastLogin(tx, user.userId, now);
    await writeAudit(tx, {
      auditId: randomUUID(),
      userId: user.userId,
      action: ACTION_LOGIN,
      result: RESULT_SUCCESS,
      bizId: user.username,
      clientIp: ctx.clientIp,
      detail: JSON.stringify({ username: user.username, requestId: ctx.requestId }),
    });
  });

  return { token, userInfo: toUserInfo(user) };
}

/** 令牌有效但用户已被删除或停用时同样按未认证处理 */
export async function currentUser(userId: string): Promise<UserInfo> {
  const user = await findByUserId(pool, userId);
  if (user === null || user.status !== 1) {
    throw AppError.unauthenticated('用户不存在或已停用');
  }
  return toUserInfo(user);
}
