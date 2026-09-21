import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { findAuthIdentity } from '../repositories/userRepo';
import { AppError } from '../http/errors';

interface GqxqJwtPayload {
  sub?: string;
  username?: string;
  roles?: string[];
}

/**
 * Bearer 令牌校验中间件（跨切面件，由主线独占维护）。
 * 设计约束（方案 §5.9）：令牌载荷只放 sub / username / roles，不放权限明细。
 *
 * Task #35 收尾修的语义（映射表 §4-9），两段判定要分清：
 *   * 令牌只负责**证明身份**：签名对不对、过没过期、载荷齐不齐；
 *   * **授权依据（roles / 启停状态）以库里的当前值为准** —— 每个受保护请求回库点查一次
 *     user_id / username / roles / status（不读 password_hash，见 userRepo.findAuthIdentity）。
 *
 * 为什么不能继续用令牌里的 roles：RBAC 上线后角色就是判定输入，而令牌 TTL 是 8 小时。
 * 只验签名的话，「禁用账号」「把 admin 降成 handler」要等对方令牌自然过期才生效 ——
 * 期间被降级的 admin 照样进得来 /users。那是策略表的默认拒绝挡不住的越权窗口：
 * 它拒的是"角色不够的人"，而老令牌报的是"我还够"。
 * 因此 payload.username / payload.roles 不再进 req.user（只作为历史契约保留）。
 *
 * 401 的四种来源（都不写 ACCESS_DENIED —— 那是"已认证但越权"才记的动作）：
 *   缺 Bearer / 签名无效 / 已过期 / 载荷缺 sub 或库里查无此人、此人已被禁用。
 * 库读失败按"不放行"处理（错误透传给 errorHandler），绝不退化成"用令牌里的旧角色"。
 */
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
    if (identity === null || identity.status !== 1) {
      // 账号被禁用或被删（本批不提供删除，故实际只有禁用）⇒ 会话立即失效
      next(AppError.unauthenticated('登录状态已失效，请重新登录'));
      return;
    }
    req.user = {
      id: identity.userId,
      username: identity.username,
      roles: identity.roles,
    };
    next();
  } catch (err) {
    next(err);
  }
}
