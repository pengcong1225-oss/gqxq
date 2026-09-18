import { Router } from 'express';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { getOverview } from '../services/dashboardService';

// GET /dashboard/overview（G1.4）：全部指标来自 SQL 聚合，零兜底常量；
// 无法计算的指标返回 null 并列入 unavailable[]（见 services/dashboardService.ts）。
export const dashboardRouter = Router();

const DEFAULT_TREND_DAYS = 7;
const MAX_TREND_DAYS = 365;

/**
 * ?days=N —— 趋势窗口长度，默认 7，允许 1..365。
 * 做成参数而不是写死：历史数据回灌后"最近 7 天"可能整段为空，
 * 必须让使用者能把窗口拉长，而不是把窗口偷偷锚到有数据的那几天。
 */
dashboardRouter.get('/dashboard/overview', async (req, res, next) => {
  try {
    const raw = req.query.days;
    let days = DEFAULT_TREND_DAYS;
    if (raw !== undefined && raw !== null && String(raw) !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TREND_DAYS) {
        throw AppError.validation('参数 days 必须是 1..' + MAX_TREND_DAYS + ' 的整数', [
          { field: 'days', message: '实际值：' + String(raw) },
        ]);
      }
      days = n;
    }
    ok(res, await getOverview(days));
  } catch (err) {
    next(err);
  }
});
