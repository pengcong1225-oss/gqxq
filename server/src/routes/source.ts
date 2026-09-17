import { Router } from 'express';
import { ok } from '../http/respond';
import { getSourceAdapterState, syncComplaintSource } from '../services/sourceStatusService';

// G6 来源对接：
//   GET  /source-status                      适配器状态（UI 据此如实显示「未接入」）
//   POST /complaints/:idOrNo/source-sync     从来源适配器同步一次只读状态
export const sourceRouter = Router();

sourceRouter.get('/source-status', async (_req, res, next) => {
  try {
    ok(res, await getSourceAdapterState());
  } catch (err) {
    next(err);
  }
});

sourceRouter.post('/complaints/:idOrNo/source-sync', async (req, res, next) => {
  try {
    ok(
      res,
      await syncComplaintSource(String(req.params.idOrNo), {
        userId: req.user?.id ?? null,
        userName: req.user?.username ?? null,
      })
    );
  } catch (err) {
    next(err);
  }
});
