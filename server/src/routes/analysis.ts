import { Router } from 'express';
import { ok } from '../http/respond';
import {
  getAnalysisDrilldown,
  listAnalysisRecords,
  listReportTodos,
} from '../services/analysisService';

// G5 分析库与待查报告待办。
//
// 本批次只做**待办入口**：报告正文、审批与发布规则待业务确认，
// 因此这里没有"生成报告"之类的接口，也不提供任何报告模板。
export const analysisRouter = Router();

analysisRouter.get('/analysis/records', async (req, res, next) => {
  try {
    ok(res, await listAnalysisRecords(req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

/** 单条分析记录 + 可下钻关联（诉求 / 交办 / 审批轨迹 / 纠偏项 / 待查待办） */
analysisRouter.get('/analysis/records/:analysisId', async (req, res, next) => {
  try {
    ok(res, await getAnalysisDrilldown(String(req.params.analysisId)));
  } catch (err) {
    next(err);
  }
});

analysisRouter.get('/report-todos', async (req, res, next) => {
  try {
    ok(res, await listReportTodos(req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});
