import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../http/errors';

interface GqxqJwtPayload {
  sub?: string;
  username?: string;
  roles?: string[];
}

/**
 * Bearer 令牌校验中间件（跨切面件，由主线独占维护）。
 * 设计约束（方案 §5.9）：令牌载荷只放 sub / username / roles，不放权限明细，
 * 这样权限回收后老令牌不会继续带着旧权限。
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
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

  req.user = {
    id: payload.sub,
    username: payload.username,
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
  };
  next();
}
