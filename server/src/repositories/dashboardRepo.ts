// dashboard 聚合查询：所有指标直接来自 SQL，**不允许任何常量兜底**。
// 无法计算的指标由 service 显式返回 null 并列入 unavailable[]，而不是伪造 0。
//
// 时区口径（2026-09-17 主线实测修正，2026-09-17T04:55 亲自复核）：
//   gqxq_service 的 DATETIME 存的是 **Asia/Shanghai 墙钟时间**，不是 UTC。
//   实证：TIMEDIFF(NOW(), UTC_TIMESTAMP()) = 08:00:00；raw 值 cast 出来是 '2026-06-29 13:40:36'。
//   因此"今天"与"最近 N 天"都必须**直接按墙钟日**判断：
//     * 正确：c.received_at >= curdate() and c.received_at < date_add(curdate(), interval 1 day)
//     * 正确：date_format(c.received_at, '%Y-%m-%d')
//     * 错误：date(convert_tz(c.received_at,'+00:00','+08:00')) —— 这是把墙钟当 UTC 再加 8 小时。
//       实测判别：'2026-06-29 20:00:00' 的本地日应是 06-29，该表达式却给出 06-30，日界整体后移 8 小时。
//     * 绝不用 UTC_TIMESTAMP()：它返回 UTC，会被按 +08:00 解释，读成早 8 小时。
//   CONVERT_TZ 只在"确实要把 UTC 换成墙钟"时才用，且必须数字偏移；
//   命名时区一律禁用（本机 MySQL 时区表未加载，会静默返回 NULL）。
import { pool, type Row } from '../db/pool';
import type { DistributionItem, RegionRankItem } from '../types/api';
import { labelOf } from '../domain/enums';
import { shanghaiDate } from '../db/sequence';
import { toNum, type ComplaintRow } from './complaintMapper';
import {
  ACTIVE_DISPATCH_COLUMNS,
  ACTIVE_DISPATCH_JOIN,
  BUSINESS_TIME,
  COMPLAINT_SELECT_COLUMNS,
} from './complaintRepo';

const NOT_DELETED = 'coalesce(c.deleted, 0) = 0';

const DAY_MS = 86400000;

/** 构造本地日界用的偏移后缀：new Date('YYYY-MM-DDT00:00:00' + SHANGHAI)。
 *  驱动按 +08:00 把它格式化成墙钟字符串，正好与库里存的墙钟列同口径比较。 */
const SHANGHAI = '+08:00';

export interface DashboardAggregates {
  total: number;
  todayReceived: number;
  waterReceived: number;
  gasReceived: number;
  sensitiveTotal: number;
  closedInSystem: number;
  /** 来源状态为已办结（completed/closed）的件数 */
  sourceClosed: number;
  /** 已接入来源状态（source_event_status <> 'unknown'）的件数，作为办结率的分母 */
  sourceKnown: number;
}

export async function findAggregates(): Promise<DashboardAggregates> {
  const sql =
    'select' +
    ' count(*) as total,' +
    // 「今日受理」按**业务时间**统计（受理时间为准），不是"今天收到报文"
    ' sum(case when ' + BUSINESS_TIME + ' >= curdate()' +
    ' and ' + BUSINESS_TIME + " < date_add(curdate(), interval 1 day) then 1 else 0 end) as todayReceived," +
    " sum(case when c.business_type = 'water' then 1 else 0 end) as waterReceived," +
    " sum(case when c.business_type = 'gas' then 1 else 0 end) as gasReceived," +
    ' sum(case when c.is_sensitive = 1 then 1 else 0 end) as sensitiveTotal,' +
    ' sum(case when c.closed_in_system = 1 then 1 else 0 end) as closedInSystem,' +
    // 来源办结率的两端：分子=来源已办结，分母=**已接入来源状态**的件数。
    // 分母刻意不含 unknown：否则"来源还没接通"会被误算成"办结率低"，那是拿未知当已知。
    " sum(case when c.source_event_status in ('completed', 'closed') then 1 else 0 end) as sourceClosed," +
    " sum(case when c.source_event_status <> 'unknown' then 1 else 0 end) as sourceKnown" +
    ' from complaint c where ' +
    NOT_DELETED;

  const [rows] = await pool.query<Row[]>(sql);
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    todayReceived: toNum(r.todayReceived) ?? 0,
    waterReceived: toNum(r.waterReceived) ?? 0,
    gasReceived: toNum(r.gasReceived) ?? 0,
    sensitiveTotal: toNum(r.sensitiveTotal) ?? 0,
    closedInSystem: toNum(r.closedInSystem) ?? 0,
    sourceClosed: toNum(r.sourceClosed) ?? 0,
    sourceKnown: toNum(r.sourceKnown) ?? 0,
  };
}

export interface TrendData {
  dates: string[];
  water: number[];
  gas: number[];
  /** 窗口长度（天） */
  days: number;
  /** 窗口起止（Asia/Shanghai 墙钟日，含端点）——前端据此标注区间，避免"看着像近 7 天其实不是" */
  from: string;
  to: string;
}

/**
 * 最近 days 天（含今天，按 +08:00 墙钟日）的供水/燃气诉求量，口径为 BUSINESS_TIME（受理时间）。
 * SQL 只返回有数据的日期，**缺失日期在 JS 补 0**——这是"补齐分桶"，不是兜底常量。
 *
 * days 由调用方给（路由已校验 1..365）。做成参数而不是写死 7 天，原因见 BUSINESS_TIME 注释：
 * 历史回灌后"最近 7 天"很可能整段没有数据，必须让使用者自己把窗口拉长，
 * 而**不能**把窗口偷偷锚到"有数据的那些天"——那会让图表日期与实际不符，是另一种欺骗。
 */
export async function findTrend(days: number): Promise<TrendData> {
  const today = shanghaiDate();
  const todayUtcMidnight = new Date(today + 'T00:00:00Z').getTime();

  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    dates.push(new Date(todayUtcMidnight - i * DAY_MS).toISOString().slice(0, 10));
  }
  const tomorrow = new Date(todayUtcMidnight + DAY_MS).toISOString().slice(0, 10);
  const startUtc = new Date(dates[0] + 'T00:00:00' + SHANGHAI);
  const endUtc = new Date(tomorrow + 'T00:00:00' + SHANGHAI);

  const [rows] = await pool.query<Row[]>(
    'select date_format(' + BUSINESS_TIME + ", '%Y-%m-%d') as d," +
      " sum(case when c.business_type = 'water' then 1 else 0 end) as water," +
      " sum(case when c.business_type = 'gas' then 1 else 0 end) as gas" +
      ' from complaint c where ' +
      NOT_DELETED +
      ' and ' + BUSINESS_TIME + ' >= ? and ' + BUSINESS_TIME + ' < ? group by d',
    [startUtc, endUtc]
  );

  const byDate = new Map<string, { water: number; gas: number }>();
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    byDate.set(String(row.d), { water: toNum(row.water) ?? 0, gas: toNum(row.gas) ?? 0 });
  }

  return {
    dates,
    water: dates.map((d) => byDate.get(d)?.water ?? 0),
    gas: dates.map((d) => byDate.get(d)?.gas ?? 0),
    days,
    from: dates[0] ?? today,
    to: dates[dates.length - 1] ?? today,
  };
}

async function findDistribution(column: string, dict: 'business_type' | 'complaint_type'): Promise<DistributionItem[]> {
  const [rows] = await pool.query<Row[]>(
    'select c.' + column + ' as code, count(*) as value from complaint c where ' +
      NOT_DELETED +
      ' group by c.' + column + ' order by value desc, c.' + column + ' asc'
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const code = String(r.code);
    return { code, name: labelOf(dict, code), value: toNum(r.value) ?? 0 };
  });
}

export function findBusinessTypeDistribution(): Promise<DistributionItem[]> {
  return findDistribution('business_type', 'business_type');
}

export function findComplaintTypeDistribution(): Promise<DistributionItem[]> {
  return findDistribution('complaint_type', 'complaint_type');
}

/** 区域排名。库中 district_code 可能为空，如实返回 null，不编造编码 */
export async function findRegionRank(limit: number): Promise<RegionRankItem[]> {
  const [rows] = await pool.query<Row[]>(
    'select c.district_code as districtCode, c.district_name as districtName, count(*) as value' +
      ' from complaint c where ' +
      NOT_DELETED +
      ' group by c.district_code, c.district_name' +
      ' order by value desc, c.district_name asc limit ?',
    [limit]
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    districtCode: r.districtCode === null || r.districtCode === undefined ? null : String(r.districtCode),
    districtName: r.districtName === null || r.districtName === undefined ? null : String(r.districtName),
    value: toNum(r.value) ?? 0,
  }));
}

/** 最新诉求（列表项字段）。按**接收时间**倒序：这是"最新到达"的运营口径，不是业务受理口径 */
export async function findLatest(limit: number): Promise<ComplaintRow[]> {
  const [rows] = await pool.query<Row[]>(
    'select ' +
      COMPLAINT_SELECT_COLUMNS +
      ACTIVE_DISPATCH_COLUMNS +
      ' from complaint c' +
      ACTIVE_DISPATCH_JOIN +
      ' where ' +
      NOT_DELETED +
      ' order by c.received_at desc, c.id desc limit ?',
    [limit]
  );
  return rows as unknown as ComplaintRow[];
}
