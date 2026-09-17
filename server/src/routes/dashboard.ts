import { Router } from 'express';
import { ok } from '../http/respond';
import { getOverview } from '../services/dashboardService';

// GET /dashboard/overview（G1.4）：全部指标来自 SQL 聚合，零兜底常量；
// 无法计算的指标返回 null 并列入 unavailable[]（见 services/dashboardService.ts）。
export const dashboardRouter = Router();

dashboardRouter.get('/dashboard/overview', async (_req, res, next) => {
  try {
    ok(res, await getOverview());
  } catch (err) {
    next(err);
  }
});
