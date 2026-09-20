import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import type { OperatorContext } from '../services/dispatchService';
import {
  confirmCorrection,
  generateCorrections,
  generateCorrectionsForAllComplaints,
  listComplaintCorrections,
  listPendingCorrections,
  rejectCorrection,
} from '../services/correctionService';
import { closeComplaint } from '../services/closureService';

// G5 纠偏与办结。
//
// 关键设计（业主 2026-09-20 裁定：纠偏与交办是并行两条轴）：
//   * 纠偏是**数据质量轴**，覆盖**所有**诉求，与是否交办、是否审批通过无关；
//     清单入口有三条——G4 回调（审批通过后补挂/刷新一次）、单条手工、批量补挂（存量与新入站都靠它收敛）；
//   * 确认 / 判定无需纠偏都会检查"是否可入分析库"，那个判断唯一收敛在 correctionService.maybeEnterAnalysis；
//     分析库口径未变（未交办 / 误报归库不纳入），所以"进了纠偏队列但没进分析库"是正常状态；
//   * 责任单位在纠偏里确认：编码走企业主数据校验，code + name 成对写回（见 assignmentService）；
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

/** 手工为单条诉求生成纠偏待办（幂等）。回调路径也会自动调用同一服务函数。 */
correctionsRouter.post('/complaints/:idOrNo/corrections/generate', async (req, res, next) => {
  try {
    ok(res, await generateCorrections(String(req.params.idOrNo), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * 批量补挂：给所有还没有纠偏清单的诉求生成待办（幂等，可反复执行）。
 * 纠偏覆盖全部诉求，存量与新入站都靠这个入口收敛；响应里的 uncoveredComplaints 为 0 才算补挂完成。
 */
correctionsRouter.post('/corrections/generate-batch', async (req, res, next) => {
  try {
    ok(res, await generateCorrectionsForAllComplaints(ctxOf(req)));
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
