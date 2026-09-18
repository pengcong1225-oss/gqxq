import request from './request';
import type { DashboardOverview } from '../types/api';

/**
 * 仪表盘总览。零兜底：所有指标直接来自服务端 SQL 聚合，0 就是 0。
 *
 * 不可计算的指标返回 null 并出现在 unavailable[] 中（含归属批次原因），
 * 调用方必须渲染 "—" + 提示，不得回填任何假数字。
 *
 * 口径：所有"业务时间"相关指标（今日受理、趋势）按**受理时间**统计
 * （来源受理时间优先，缺失回落接收时间），响应体 period.timeBasis 会声明这一点。
 *
 * GET /dashboard/overview?days=N   days 为趋势窗口天数（1..365，默认 7）
 */
export async function getDashboardOverview(days?: number): Promise<DashboardOverview> {
  const query = days === undefined ? '' : '?days=' + String(days);
  return request.get<never, DashboardOverview>('/dashboard/overview' + query);
}
