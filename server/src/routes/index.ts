import { Router } from 'express';
import { healthRouter } from './health';
import { complaintsRouter } from './complaints';
import { dashboardRouter } from './dashboard';
import { dictsRouter } from './dicts';
import { authRouter } from './auth';
import { externalRouter } from './externalYijiejieban';
import { legacyRouter } from './legacy';
import { dispatchRouter } from './dispatch';
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

  root.use(requireAuth);
  root.use(complaintsRouter);
  root.use(complaintActionsRouter);
  root.use(enterprisesRouter);
  root.use(dashboardRouter);
  root.use(dictsRouter);
  root.use(dispatchRouter);
  root.use(legacyRouter);

  return root;
}
