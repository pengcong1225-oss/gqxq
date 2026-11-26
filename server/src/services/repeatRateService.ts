import { pool } from '../db/pool';
import { buildComplaintScopeSql, currentAccessContext } from '../auth/accessScope';

/**
 * 重复投诉率统计。
 *
 * 口径：
 *   重复投诉率 = repeat_flag=1 的诉求数 / 同期受理诉求总数 × 100%
 *   业务时间 = coalesce(source_reported_at, received_at)（与统计模块一致）
 *   分母含重复来电（不合并、不剔除），保证诉求总量口径不变。
 */
export interface RepeatRateQuery {
  from: string;
  to: string;
  businessType: 'water' | 'gas' | null;
  groupBy: 'month' | 'enterprise' | 'district';
}

export interface RepeatRateBucket {
  key: string;
  label: string;
  total: number;
  repeat: number;
  rate: number | null;
}

export interface RepeatRateResult {
  query: RepeatRateQuery;
  overall: { total: number; repeat: number; rate: number | null };
  series: RepeatRateBucket[];
  generatedAt: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseQuery(raw: Record<string, unknown>): RepeatRateQuery {
  const from = String(raw.from ?? '').trim();
  const to = String(raw.to ?? '').trim();
  if (!DATE.test(from) || !DATE.test(to)) throw new Error('from/to 需为 YYYY-MM-DD');
  if (from > to) throw new Error('from 不能晚于 to');
  const businessType = raw.businessType === 'water' || raw.businessType === 'gas' ? (raw.businessType as 'water' | 'gas') : null;
  const groupByRaw = String(raw.groupBy ?? 'month');
  const groupBy = (['month', 'enterprise', 'district'] as const).includes(groupByRaw as 'month') ? (groupByRaw as 'month' | 'enterprise' | 'district') : 'month';
  return { from, to, businessType, groupBy };
}

const RATE = (repeat: number, total: number): number | null => (total === 0 ? null : Math.round((repeat / total) * 10000) / 100);

export async function getRepeatRate(raw: Record<string, unknown>): Promise<RepeatRateResult> {
  const query = parseQuery(raw);
  const scope = buildComplaintScopeSql(currentAccessContext(), 'c');
  const where: string[] = [scope.sql, "date(coalesce(c.source_reported_at, c.received_at)) between ? and ?"];
  const params: unknown[] = [...scope.params, query.from, query.to];
  if (query.businessType) {
    where.push('c.business_type = ?');
    params.push(query.businessType);
  }
  const base = ' from complaint c where ' + where.join(' and ');

  const [overallRows] = await pool.query(
    'select count(*) as total, coalesce(sum(c.repeat_flag = 1), 0) as repeats' + base,
    params
  );
  const overallRaw = (overallRows as Array<{ total: number | string; repeats: number | string }>)[0] ?? { total: 0, repeats: 0 };
  const total = Number(overallRaw.total ?? 0);
  const repeat = Number(overallRaw.repeats ?? 0);

  const keyExpr =
    query.groupBy === 'month'
      ? "date_format(coalesce(c.source_reported_at, c.received_at), '%Y-%m')"
      : query.groupBy === 'enterprise'
        ? "coalesce(nullif(c.enterprise_name, ''), nullif(c.enterprise_code, ''), '未匹配企业')"
        : "coalesce(nullif(c.district_name, ''), nullif(c.district_code, ''), '未匹配区县')";

  const [rows] = await pool.query(
    'select ' + keyExpr + ' as bucketKey, count(*) as total, coalesce(sum(c.repeat_flag = 1), 0) as repeats' + base + ' group by bucketKey order by bucketKey',
    params
  );
  const series: RepeatRateBucket[] = (rows as Array<{ bucketKey: string; total: number | string; repeats: number | string }>).map((r) => {
    const t = Number(r.total ?? 0);
    const p = Number(r.repeats ?? 0);
    return { key: String(r.bucketKey ?? ''), label: String(r.bucketKey ?? ''), total: t, repeat: p, rate: RATE(p, t) };
  });

  return {
    query,
    overall: { total, repeat, rate: RATE(repeat, total) },
    series,
    generatedAt: new Date().toISOString(),
  };
}
