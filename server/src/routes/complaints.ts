import { Router } from 'express';
import { ok } from '../http/respond';
import {
  getComplaintDetail,
  getComplaintTimeline,
  listComplaints,
} from '../services/complaintService';

// 诉求总账查询（G1.3）。
// 认证由 routes/index.ts 的 requireAuth 统一前置，此处不重复判定。
// 路由顺序：/complaints/:idOrNo 与 /complaints/:idOrNo/timeline 段数不同，不会互相遮蔽。
export const complaintsRouter = Router();

complaintsRouter.get('/complaints', async (req, res, next) => {
  try {
    ok(res, await listComplaints(req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

complaintsRouter.get('/complaints/:idOrNo', async (req, res, next) => {
  try {
    ok(res, await getComplaintDetail(String(req.params.idOrNo)));
  } catch (err) {
    next(err);
  }
});

complaintsRouter.get('/complaints/:idOrNo/timeline', async (req, res, next) => {
  try {
    ok(res, await getComplaintTimeline(String(req.params.idOrNo)));
  } catch (err) {
    next(err);
  }
});
