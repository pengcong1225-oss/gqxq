import { Router } from 'express';
import { healthRouter } from './health';
import { complaintsRouter } from './complaints';
import { dashboardRouter } from './dashboard';
import { dictsRouter } from './dicts';
import { authRouter } from './auth';
import { externalRouter } from './externalYijiejieban';
import { publicUtilityCallbackRouter } from './publicUtilityCallback';
import { legacyRouter } from './legacy';
import { dispatchRouter } from './dispatch';
import { dispatchPushRouter } from './dispatchPush';
import { approvalTraceRouter } from './approvalTrace';
import { correctionsRouter } from './corrections';
import { analysisRouter } from './analysis';
import { dispatchArchiveRouter } from './dispatchArchive';
import { sourceRouter } from './source';
import { complaintActionsRouter } from './complaintActions';
import { enterprisesRouter } from './enterprises';
import { usersRouter } from './users';
import { requireAuth } from '../middleware/requireAuth';
import { enforceRolePolicy } from '../middleware/requireRole';

/**
 * 路由表由主线独占维护；各并行线只填充自己的 router 文件。
 *
 * 认证与授权（Task #35 起是两段，语义分开）：
 *   * **401 未认证** = requireAuth：缺 Bearer / 令牌无效或过期；
 *   * **403 无权限** = enforceRolePolicy：按 server/src/auth/rolePolicy.ts 的
 *     「角色 × 路由 × 方法」策略表判定，表里没有的端点**默认拒绝**（视同 admin-only）。
 *     新增路由必须同步加策略行 + 更新 docs/2026-09-21-角色权限映射.md（交付纪律，逐条可审计）。
 *
 * 不鉴权（也不鉴角色）的四条：/health、/auth/login、/external/yijiejieban/appeal、
 * /external/public-utility/callback。后两条是机器对机器：来源系统不持有平台账号，
 * 前者靠网络边界 + 载荷校验 + 入站留痕，后者靠签名 + ACK 逐字节 —— 见映射表 §2，
 * **必须**挂在 requireAuth 之前，本批一律不变。
 */
export function buildRouter(): Router {
  const root = Router();

  root.use(healthRouter);
  root.use(authRouter);
  root.use('/external', externalRouter);
  // 回调靠签名鉴权，必须挂在 requireAuth 之前
  root.use('/external/public-utility', publicUtilityCallbackRouter);

  root.use(requireAuth);
  // 全局角色闸门：必须在 requireAuth 之后、所有业务 router 之前
  root.use(enforceRolePolicy());
  root.use(complaintsRouter);
  root.use(complaintActionsRouter);
  root.use(enterprisesRouter);
  root.use(dashboardRouter);
  root.use(dictsRouter);
  root.use(dispatchRouter);
  root.use(dispatchPushRouter);
  root.use(approvalTraceRouter);
  root.use(correctionsRouter);
  root.use(analysisRouter);
  root.use(dispatchArchiveRouter);
  root.use(sourceRouter);
  root.use(usersRouter);
  root.use(legacyRouter);

  return root;
}
