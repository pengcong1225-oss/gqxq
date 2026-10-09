import { resolveAccessContext, runWithAccessContext } from '../auth/accessScope';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { resolveAuthorization } from '../services/roleService';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { findAuthIdentity } from '../repositories/userRepo';
import { AppError } from '../http/errors';

interface GqxqJwtPayload {
  sub?: string;
  username?: string;
  roles?: string[];
  sessionVersion?: number;
}

/** Token proves identity/session version only. Each request reloads status,
 * current enabled role and permissions. Old role claims never authorize a request. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) {
    next(AppError.unauthenticated('缺少 Bearer 令牌'));
    return;
  }

  let payload: GqxqJwtPayload;
  try {
    payload = jwt.verify(matched[1], env.jwtSecret) as GqxqJwtPayload;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    next(AppError.unauthenticated(name === 'TokenExpiredError' ? '登录已过期，请重新登录' : '令牌无效'));
    return;
  }

  if (!payload.sub || !payload.username) {
    next(AppError.unauthenticated('令牌缺少必要字段'));
    return;
  }

  try {
    const identity = await findAuthIdentity(pool, payload.sub);
    if (identity === null || identity.status !== 1 || payload.sessionVersion !== identity.sessionVersion) {
      // 账号被禁用或被删（本批不提供删除，故实际只有禁用）⇒ 会话立即失效
      next(AppError.unauthenticated('登录状态已失效，请重新登录'));
      return;
    }
    const authorization = await resolveAuthorization(identity.userId);
    req.user = {
      accountType: identity.accountType,
      id: identity.userId,
      username: identity.username,
      roles: authorization.roleCodes,
      permissionCodes: authorization.permissionCodes,
      authorizationVersion: authorization.authorizationVersion,
      mustChangePassword: identity.mustChangePassword,
    };
    req.accessContext = await resolveAccessContext(identity.userId, authorization);
    runWithAccessContext(req.accessContext, () => next());
  } catch (err) {
    next(err);
  }
}
