// 仪表盘服务：把聚合结果组装成契约 DTO。
// 纪律：可算的指标直接来自 SQL；不可算的指标返回 null 并列入 unavailable[]，
// 既不伪造 0，也不编造趋势。
import type { DashboardOverview } from '../types/api';
import { shanghaiDate } from '../db/sequence';
import { rowToListItem } from '../repositories/complaintMapper';
import {
  findAggregates,
  findBusinessTypeDistribution,
  findComplaintTypeDistribution,
  findLatest,
  findRegionRank,
  findTrend7d,
} from '../repositories/dashboardRepo';

const LATEST_LIMIT = 5;
const REGION_LIMIT = 10;

export async function getOverview(): Promise<DashboardOverview> {
  const [aggregates, trend, businessTypeDistribution, complaintTypeDistribution, regionRank, latest] =
    await Promise.all([
      findAggregates(),
      findTrend7d(),
      findBusinessTypeDistribution(),
      findComplaintTypeDistribution(),
      findRegionRank(REGION_LIMIT),
      findLatest(LATEST_LIMIT),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    // 明确声明数据来源，页面可据此区分真实数据与占位
    source: 'database',
    period: { today: shanghaiDate(), timezone: 'Asia/Shanghai' },
    metrics: {
      total: aggregates.total,
      todayReceived: aggregates.todayReceived,
      waterReceived: aggregates.waterReceived,
      gasReceived: aggregates.gasReceived,
      sensitiveTotal: aggregates.sensitiveTotal,
      closedInSystem: aggregates.closedInSystem,
      // 下面两项本次无法计算，显式 null，绝不伪造 0
      overtimeActive: null,
      closedRate: null,
    },
    unavailable: [
      { key: 'overtimeActive', reason: '依赖 dispatch_order 与截止时间，批次 G2 才能计算' },
      { key: 'closedRate', reason: '依赖来源处置状态（批次 G6）或本系统办结（批次 G5）' },
    ],
    trend,
    businessTypeDistribution,
    complaintTypeDistribution,
    regionRank,
    latestComplaints: latest.map(rowToListItem),
  };
}
