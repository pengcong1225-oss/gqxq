import request from './request';
import type { DashboardOverview } from '../types/api';

/**
 * 仪表盘总览。零兜底：所有指标直接来自服务端 SQL 聚合，0 就是 0。
 *
 * 不可计算的指标返回 null 并出现在 unavailable[] 中（含归属批次原因），
 * 调用方必须渲染 "—" + 提示，不得回填任何假数字。
 *
 * GET /dashboard/overview
 */
export async function getDashboardOverview(): Promise<DashboardOverview> {
  return request.get<never, DashboardOverview>('/dashboard/overview');
}
