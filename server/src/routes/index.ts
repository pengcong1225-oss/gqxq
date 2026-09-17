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
import { requireAuth } from '../middleware/requireAuth';

// 路由表由主线独占维护；各并行线只填充自己的 router 文件。
// 认证口径：/health、/auth/login、/external/* 不要求 Bearer，其余一律要求。
export function buildRouter(): Router {
  const root = Router();

  root.use(healthRouter);
  root.use(authRouter);
  root.use('/external', externalRouter);
  // 回调靠签名鉴权，必须挂在 requireAuth 之前
  root.use('/external/public-utility', publicUtilityCallbackRouter);

  root.use(requireAuth);
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
  root.use(legacyRouter);

  return root;
}
