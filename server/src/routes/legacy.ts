import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AppError } from '../http/errors';

// 尚未实现、且已有明确归属批次的旧接口。
// 一律显式 501 并标明批次 —— 绝不返回随机假数据（交付纪律第 1 条）。
// 已实现的接口不要留在这里：见 routes/ 下各自的 router。
function stub(batch: string, what: string): RequestHandler {
  return (_req, _res, next) => next(AppError.notImplemented(what + ' 尚未实现', batch));
}

export const legacyRouter = Router();

legacyRouter.post('/external/tianbao/status-callback', stub('G4', '填报系统状态回调（旧的轮询式回调）'));

// 下面这些路径已被更规范的新路径取代，不再保留 501（避免出现"两个都能调、一个假一个真"）：
//   企业主数据   /companies            -> GET /enterprises                （G2）
//   待纠偏队列   /address-correction/pending -> GET /corrections/pending  （G5）
//   批量纠偏     /address-correction/batch   -> POST /corrections/:id/confirm|reject（G5）
//   交办归档     /dispatch/orders/:id/archive -> POST /dispatch/orders/:assignmentId/archive（G5）
//   分析总览     /analysis/overview     -> GET /analysis/records           （G5）
//   拉取填报反馈 /dispatch/orders/:id/sync    -> 由 G4 的主动回传取代，不需要轮询

// 宜接就办状态同步：现为 POST /complaints/:idOrNo/source-sync（G6，适配器默认关闭）

// 以下页面的真实数据在 gqxq_service 里已有表，但不在已交付批次范围内，显式 501 而不是给假数据
legacyRouter.get('/grids', stub('G2 之后', '网格管理'));
legacyRouter.get('/shutdowns', stub('另立批次', '停供管理'));
legacyRouter.get('/pipeline-projects', stub('另立批次', '管道施工'));
legacyRouter.get('/reports', stub('G5 之后', '正式分析报告（本批次只做了待查报告待办 /report-todos）'));
legacyRouter.get('/users', stub('G1.6 之后', '用户管理'));
legacyRouter.get('/heatmap/data', stub('G6 之后', '热力图'));
