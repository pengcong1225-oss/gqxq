// 角色鉴权中间件。两条入口，一套真源（auth/rolePolicy 的 ROLE_POLICY）：
//   * enforceRolePolicy()：挂在 requireAuth 之后的**全局**判定，按策略表放行 / 拒绝，
//     表里没有的端点默认拒绝（视同 admin-only）——这条保证"新增路由漏声明"不会变成越权。
//   * requireRole(...roles)：给单个 router 显式加闸用（用户管理三条按此双重设防）。
//
// 401 / 403 语义分开（映射表 §4-3）：
//   没令牌 / 令牌失效 → requireAuth 已经给了 401，走不到这里；
//   有令牌但角色不够 → 403，且写一条 ACCESS_DENIED 审计（**落到真实操作人**）。
//   对外消息固定为「无权限，请联系管理员」，判定依据只进审计，不回给调用方
//   （否则等于把策略表枚举给未授权的人看）。
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { GQXQ_APP_CODE } from '../services/intakeService';
import { pool } from '../db/pool';
import { insertAudit } from '../repositories/auditLogRepo';
import { AppError } from '../http/errors';
import { isAllowed, matchRule, type Role } from '../auth/rolePolicy';

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

/**
 * 显式角色闸门（router 级）。与全局策略**同时生效**，取更严的一方：
 * 用户管理三条即靠它做第二道闸，防止有人误改策略表里的 /users 行。
 */
export function requireRole(...roles: Role[]): RequestHandler {
  const wanted = new Set<string>(roles);
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (user === undefined) {
      next(AppError.unauthenticated('未认证或登录已过期'));
      return;
    }
    const hit = user.roles.find((r) => wanted.has(r));
    if (hit !== undefined) {
      next();
      return;
    }
    await logDenied(req, 'requireRole 显式闸门要求 ' + Array.from(wanted).join('/') +
      '（端点策略：' + (matchRule(req.method, req.path)?.desc ?? '未声明，默认拒绝') + '）');
    next(AppError.forbidden());
  };
}
