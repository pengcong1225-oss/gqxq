import { resolveAccessContext, runWithAccessContext } from '../auth/accessScope';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { resolveAuthorization } from '../services/roleService';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { findAuthIdentity } from '../repositories/userRepo';
import { bearerToken, findBoundUserId, verifyPlatformToken } from '../auth/platformIdentity';
import { checkLegacyPlatformAccess, checkManagedSession, findManagedBySubject, findManagedByUser, type ManagedSession } from '../auth/managedIdentity';
import { AppError } from '../http/errors';
import { gqxqOidc } from '../auth/gqxqOidc';
import { isOidcSessionMarker } from '../auth/oidcRelyingParty';

interface GqxqJwtPayload {
  sub?: string;
  username?: string;
  sessionVersion?: number;
  managedSession?: ManagedSession;
}

function verifyLocalToken(token: string): GqxqJwtPayload {
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.username !== 'string') {
      throw AppError.unauthenticated('令牌缺少必要字段');
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.unauthenticated((error as { name?: string }).name === 'TokenExpiredError' ? '登录已过期，请重新登录' : '令牌无效');
  }
}

async function authenticate(token: string) {
  const claims = gqxqOidc ? null : await verifyPlatformToken(token);
  if (claims?.iss && claims.sub) {
    if (await findManagedBySubject(claims.iss, claims.sub)) throw AppError.unauthenticated('请通过门户进入诉求应用');
    const userId = await findBoundUserId(claims.iss, claims.sub);
    if (!userId || await findManagedByUser(userId)) {
      throw AppError.unauthenticated('当前平台账号尚未绑定本系统账号，请联系管理员绑定');
    }
    await checkLegacyPlatformAccess(userId, claims);
    return await findAuthIdentity(pool, userId);
  }
  const local = verifyLocalToken(token);
  const identity = await findAuthIdentity(pool, local.sub!);
  if (!identity || identity.status !== 1 || local.sessionVersion !== identity.sessionVersion) return null;
  const managed = await findManagedByUser(identity.userId);
  if (managed) await checkManagedSession(managed, local.managedSession);
  else {
    if (local.managedSession !== undefined) throw AppError.unauthenticated('登录状态已失效，请重新登录');
    await checkLegacyPlatformAccess(identity.userId);
  }
  return identity;
}

/** Reload current business roles and restrictions for each protected operation. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) throw AppError.unauthenticated('缺少 Bearer 令牌');
    const oidcSession = isOidcSessionMarker(token);
    if (oidcSession) res.setHeader('Cache-Control', 'no-store');
    const identity = oidcSession ? await gqxqOidc?.authenticate(req, token) : await authenticate(token);
    if (!identity || identity.status !== 1) throw AppError.unauthenticated('登录状态已失效，请重新登录');
    const authorization = await resolveAuthorization(identity.userId);
    req.user = {
      accountType: identity.accountType,
      id: identity.userId,
      username: identity.username,
      roles: authorization.roleCodes,
      permissionCodes: authorization.permissionCodes,
      authorizationVersion: authorization.authorizationVersion,
      mustChangePassword: identity.mustChangePassword,
      sessionVersion: identity.sessionVersion,
    };
    req.accessContext = await resolveAccessContext(identity.userId, authorization);
    runWithAccessContext(req.accessContext, () => next());
  } catch (err) {
    next(err);
  }
}
