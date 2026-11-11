// Global endpoint policy and route-local capability guards use one permission
// source. Rejection audits identify the authenticated actor, without request bodies.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { GQXQ_APP_CODE } from '../services/intakeService';
import { pool } from '../db/pool';
import { insertAudit } from '../repositories/auditLogRepo';
import { AppError } from '../http/errors';
import { isAllowed } from '../auth/rolePolicy';

/** 审计里 resource_code 记顶层路径段（列宽 128，够；也便于按模块筛） */
function resourceOf(path: string): string {
  const seg = path.replace(/^\/+/, '').split('/')[0] ?? '';
  return seg === '' ? 'root' : seg;
}

/**
 * 403 留痕。失败不掩盖 403 本身（拒绝对外的语义比记全审计更重要），
 * 但**必须**先把审计落库再返回——与登录失败审计同一口径，禁止"无声拒绝"。
 */
async function logDenied(req: Request, reason: string): Promise<void> {
  const path = req.baseUrl !== undefined && req.baseUrl !== '' ? req.baseUrl + req.path : req.path;
  try {
    await insertAudit(pool, {
      userId: req.user?.id ?? null,
      appCode: GQXQ_APP_CODE,
      resourceCode: resourceOf(req.path),
      action: 'ACCESS_DENIED',
      bizType: 'http',
      bizId: (req.method + ' ' + path).slice(0, 128),
      result: 'rejected',
      clientIp: req.remoteIp ?? null,
      detail: {
        username: req.user?.username ?? null,
        roles: req.user?.roles ?? [],
        method: req.method,
        path,
        reason,
        requestId: req.requestId,
      },
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('[' + req.requestId + '] ACCESS_DENIED 审计写入失败（403 仍照常返回）:', err);
  }
}

/**
 * 全局策略判定。挂在 routes/index.ts 的 requireAuth 之后、各业务 router 之前。
 * 机器对机器端点不经过这里（它们挂在 requireAuth 之前，见映射表 §2）。
 */
export function enforceRolePolicy(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (user === undefined) {
      // 装配错误：全局判定被挂到了 requireAuth 之前。宁可 401 也不放行。
      next(AppError.unauthenticated('未认证或登录已过期'));
      return;
    }
    const decision = isAllowed(user, req.method, req.path);
    if (decision.allowed) {
      next();
      return;
    }
    await logDenied(req, decision.reason);
    next(AppError.forbidden());
  };
}

/** Route-local guard uses the same capability as the global endpoint policy. */
export function requirePermission(code: import('../auth/permissionCatalog').PermissionCode): RequestHandler {
  return async (req, _res, next) => {
    if (!req.user) return next(AppError.unauthenticated());
    const adminProtected = code === 'system.users.manage' || code === 'system.roles.manage';
    if ((!adminProtected || req.user.roles.includes('admin')) && req.user.permissionCodes?.includes(code) && !req.user.mustChangePassword) return next();
    await logDenied(req, '缺少权限 '+code);
    next(AppError.forbidden());
  };
}
