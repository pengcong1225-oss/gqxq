import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import type { OperatorContext } from '../services/dispatchService';
import {
  confirmCorrection,
  generateCorrections,
  listComplaintCorrections,
  listPendingCorrections,
  rejectCorrection,
} from '../services/correctionService';
import { closeComplaint } from '../services/closureService';

// G5 纠偏与办结。
//
// 关键设计：
//   * 纠偏清单由「最终审批通过」触发（G4 回调自动调用，也留了手工入口），不是无条件生成；
//   * 确认 / 判定无需纠偏都会检查"是否可入分析库"，那个判断唯一收敛在 correctionService.maybeEnterAnalysis；
//   * 办结是**人的显式决定**，机器只在条件不满足时拦下（basis 必填）。
export const correctionsRouter = Router();

/** 操作者上下文：用户来自 requireAuth 注入的 req.user，IP 来自 requestContext */
function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

/** 待纠偏队列（全局），支持按诉求过滤 */
correctionsRouter.get('/corrections/pending', async (req, res, next) => {
  try {
    ok(res, await listPendingCorrections(req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

/** 某诉求的全部纠偏项（含已确认 / 已判定无需纠偏，供详情页展示完整清单） */
correctionsRouter.get('/complaints/:idOrNo/corrections', async (req, res, next) => {
  try {
    ok(res, await listComplaintCorrections(String(req.params.idOrNo)));
  } catch (err) {
    next(err);
  }
});

/** 手工生成纠偏待办（幂等）。回调路径也会自动调用同一服务函数。 */
correctionsRouter.post('/complaints/:idOrNo/corrections/generate', async (req, res, next) => {
  try {
    ok(res, await generateCorrections(String(req.params.idOrNo), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

correctionsRouter.post('/corrections/:correctionId/confirm', async (req, res, next) => {
  try {
    ok(res, await confirmCorrection(String(req.params.correctionId), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

correctionsRouter.post('/corrections/:correctionId/reject', async (req, res, next) => {
  try {
    ok(res, await rejectCorrection(String(req.params.correctionId), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

/** 本系统办结：最终审批通过 + 纠偏全部确认后，由人工显式执行 */
correctionsRouter.post('/complaints/:idOrNo/close', async (req, res, next) => {
  try {
    ok(res, await closeComplaint(String(req.params.idOrNo), req.body, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
