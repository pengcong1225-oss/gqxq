import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import { listPushLogs, pushDispatch } from '../services/dispatchPushService';
import type { OperatorContext } from '../services/dispatchService';

// G3 出站：把敏感交办推送为 public-utility 的填报任务。
// 认证由 routes/index.ts 的 requireAuth 统一前置。
//
// push 与 repush 都调用同一个服务函数：重推的规定语义就是
// "同 requestId、同 body、新 nonce、新时间戳"，而那正是 pushDispatch 每次都在做的事
// （body 由交办单当前内容构造，requestId 取自 dispatch_order.request_id 且永不改变）。
// 让两个端点共用一条实现，比各写一份更能保证语义一致。
export const dispatchPushRouter = Router();

/** 操作者上下文：用户来自 requireAuth 注入的 req.user，IP 来自 requestContext */
function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

dispatchPushRouter.post('/dispatch/orders/:assignmentId/push', async (req, res, next) => {
  try {
    ok(res, await pushDispatch(String(req.params.assignmentId), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dispatchPushRouter.post('/dispatch/orders/:assignmentId/repush', async (req, res, next) => {
  try {
    ok(res, await pushDispatch(String(req.params.assignmentId), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dispatchPushRouter.get('/dispatch/orders/:assignmentId/push-logs', async (req, res, next) => {
  try {
    ok(res, await listPushLogs(String(req.params.assignmentId)));
  } catch (err) {
    next(err);
  }
});
