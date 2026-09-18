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
  findTrend,
} from '../repositories/dashboardRepo';

const LATEST_LIMIT = 5;
const REGION_LIMIT = 10;

/** 业务时间口径标识（与 repositories/complaintRepo.ts 的 BUSINESS_TIME 表达式一致） */
export const BUSINESS_TIME_BASIS = 'source_reported_at_or_received_at';

export async function getOverview(days: number): Promise<DashboardOverview> {
  const [aggregates, trend, businessTypeDistribution, complaintTypeDistribution, regionRank, latest] =
    await Promise.all([
      findAggregates(),
      findTrend(days),
      findBusinessTypeDistribution(),
      findComplaintTypeDistribution(),
      findRegionRank(REGION_LIMIT),
      findLatest(LATEST_LIMIT),
    ]);

  // 来源办结率 = 来源已办结 / **已接入来源状态**的件数。
  // 分母不含 unknown：把"来源还没接通"当"未办结"是拿未知当已知。
  // 分母为 0（一件来源状态都没有）时返回 null 并列 unavailable，而不是返回 0。
  // ⚠️ 口径需业务确认：这是"来源办结率"；若要看"本系统办结率"应另立指标（见 metrics.closedInSystem）。
  const closedRate =
    aggregates.sourceKnown === 0
      ? null
      : Math.round((aggregates.sourceClosed / aggregates.sourceKnown) * 1000) / 10;

  return {
    generatedAt: new Date().toISOString(),
    // 明确声明数据来源，页面可据此区分真实数据与占位
    source: 'database',
    period: {
      today: shanghaiDate(),
      timezone: 'Asia/Shanghai',
      // 业务口径时间列：受理时间为准（来源受理时间优先，缺失回落接收时间）。
      // **必须显式声明**：历史回灌后 received_at 与 source_reported_at 会显著分离，
      // 不写清口径，"今日受理"到底指哪个"今日"就是歧义的。
      timeBasis: BUSINESS_TIME_BASIS,
      timeBasisLabel: '受理时间（来源受理时间优先，缺失回落接收时间）',
    },
    metrics: {
      total: aggregates.total,
      todayReceived: aggregates.todayReceived,
      waterReceived: aggregates.waterReceived,
      gasReceived: aggregates.gasReceived,
      sensitiveTotal: aggregates.sensitiveTotal,
      closedInSystem: aggregates.closedInSystem,
      // 仍不可计算的指标显式 null，绝不伪造 0
      overtimeActive: null,
      closedRate,
    },
    unavailable: [
      { key: 'overtimeActive', reason: '依赖 dispatch_order 与截止时间，批次 G2 才能计算' },
    ],
    trend,
    businessTypeDistribution,
    complaintTypeDistribution,
    regionRank,
    latestComplaints: latest.map(rowToListItem),
  };
}
