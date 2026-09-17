import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AppError } from '../http/errors';

// G1 起删除 server/src/index.js 的内存 Mock 后，这些旧接口失去数据来源。
// 一律显式 501，并标明归属批次——绝不返回随机假数据（交付纪律第 1 条）。
function stub(batch: string, what: string): RequestHandler {
  return (_req, _res, next) => next(AppError.notImplemented(what + ' 尚未实现', batch));
}

export const legacyRouter = Router();

// /dispatch/orders 的 GET/POST 已由 routes/dispatch.ts 实现（G2）
legacyRouter.post('/dispatch/orders/:id/push', stub('G3', '推送交办'));
legacyRouter.post('/dispatch/orders/:id/repush', stub('G3', '重推交办'));
legacyRouter.get('/dispatch/orders/:id/sync', stub('G4', '拉取填报反馈'));
legacyRouter.post('/dispatch/orders/:id/archive', stub('G5', '交办归档'));
legacyRouter.post('/external/tianbao/status-callback', stub('G4', '填报系统状态回调'));
legacyRouter.get('/analysis/overview', stub('G5', '分析总览'));
legacyRouter.get('/address-correction/pending', stub('G5', '待纠偏队列'));
legacyRouter.post('/address-correction/batch', stub('G5', '批量纠偏'));
legacyRouter.get('/complaints/:id/sync', stub('G6', '宜接就办状态同步'));

// 以下页面的真实数据在 gqxq_service 里已有表，但不在 G1 范围内，同样显式 501
legacyRouter.get('/companies', stub('G2 之后', '企业管理'));
legacyRouter.get('/companies/:id', stub('G2 之后', '企业详情'));
legacyRouter.get('/grids', stub('G2 之后', '网格管理'));
legacyRouter.get('/shutdowns', stub('另立批次', '停供管理'));
legacyRouter.get('/pipeline-projects', stub('另立批次', '管道施工'));
legacyRouter.get('/reports', stub('G5', '报告管理'));
legacyRouter.get('/users', stub('G1.6 之后', '用户管理'));
legacyRouter.get('/heatmap/data', stub('G6 之后', '热力图'));
legacyRouter.get('/address-correction/pending', stub('G5', '待纠偏队列'));
