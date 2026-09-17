import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import { assignEnterprise } from '../services/assignmentService';
import { disposeComplaint } from '../services/dispositionService';
import type { OperatorContext } from '../services/dispatchService';

// G2 总账上的处置动作：
//   POST /complaints/:idOrNo/assignment   匹配 / 调整责任单位
//   POST /complaints/:idOrNo/disposition  归库：no_dispatch_needed / false_positive
// 二者都是 POST，与 complaintsRouter 的 GET 路由不冲突。
export const complaintActionsRouter = Router();

function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

complaintActionsRouter.post('/complaints/:idOrNo/assignment', async (req, res, next) => {
  try {
    ok(res, await assignEnterprise(String(req.params.idOrNo), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

complaintActionsRouter.post('/complaints/:idOrNo/disposition', async (req, res, next) => {
  try {
    ok(res, await disposeComplaint(String(req.params.idOrNo), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
