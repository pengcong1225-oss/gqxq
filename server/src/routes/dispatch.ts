import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import {
  cancelDispatch,
  createDispatch,
  getDispatchOrder,
  listDispatchOrders,
  type OperatorContext,
} from '../services/dispatchService';

// G2 敏感交办：列表 / 详情 / 创建（幂等）/ 受控撤销。
// 认证由 routes/index.ts 的 requireAuth 统一前置。
// 推送 / 重推 / 同步 / 归档仍属 G3/G4/G5，继续留在 routes/legacy.ts 的 501。
export const dispatchRouter = Router();

/** 操作者上下文：用户来自 requireAuth 注入的 req.user，IP 来自 requestContext */
function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

dispatchRouter.get('/dispatch/orders', async (req, res, next) => {
  try {
    ok(res, await listDispatchOrders(req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.get('/dispatch/orders/:assignmentId', async (req, res, next) => {
  // 'archived' 是 legacy 里 G5 归档列表的占位路径，正好会被本通配段吃掉。
  // 放行给后续路由（legacy.ts 的 501），避免 G5 的"未实现"语义被 404 覆盖。
  if (req.params.assignmentId === 'archived') {
    next();
    return;
  }
  try {
    ok(res, await getDispatchOrder(String(req.params.assignmentId)));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.post('/dispatch/orders', async (req, res, next) => {
  try {
    ok(res, await createDispatch(req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.post('/dispatch/orders/:assignmentId/cancel', async (req, res, next) => {
  try {
    ok(res, await cancelDispatch(String(req.params.assignmentId), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
