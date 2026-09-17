import { Router } from 'express';
import { pool } from '../db/pool';
import { ok } from '../http/respond';
import { listTracesByAssignment } from '../repositories/approvalTraceRepo';

// GET /api/v1/dispatch/orders/:assignmentId/approval-trace
// 交办详情页的审批轨迹（来源 approval_trace，追加写）。
// 该路由挂在 requireAuth 之后（见 routes/index.ts），属受保护接口。
// 与 dispatchRouter 的 GET /dispatch/orders/:assignmentId 不冲突：段数不同。
export const approvalTraceRouter = Router();

approvalTraceRouter.get('/dispatch/orders/:assignmentId/approval-trace', async (req, res, next) => {
  try {
    // 只读查询，直接用连接池（Queryable = Pool | PoolConnection）
    const content = await listTracesByAssignment(pool, String(req.params.assignmentId));
    ok(res, { content, total: content.length });
  } catch (err) {
    next(err);
  }
});
