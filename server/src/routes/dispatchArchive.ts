import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import type { OperatorContext } from '../services/dispatchService';
import { archiveDispatchOrder } from '../services/closureService';

// G5 交办归档：写 dispatch_order.status='archived' + archived_at，并写审计。
// 前置：交办处于终态（completed / rejected），且该诉求无待纠偏项。
// 已归档时幂等返回既有记录。
export const dispatchArchiveRouter = Router();

function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

dispatchArchiveRouter.post('/dispatch/orders/:assignmentId/archive', async (req, res, next) => {
  try {
    ok(res, await archiveDispatchOrder(String(req.params.assignmentId), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
