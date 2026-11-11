import { householdRate } from './statisticsService';
import type { StatisticsQuery, HouseholdEvidence } from '../types/statistics';
import type { AccessContext } from '../auth/accessScope';
import type { SqlExecutor } from '../repositories/userRepo';
export async function screenHouseholdEvidence(db: SqlExecutor, q: StatisticsQuery, access: AccessContext, permissions: readonly string[], enterprises: { enterpriseCode: string; count: number }[], partial: boolean, localSpatialFilter: boolean): Promise<HouseholdEvidence[]> {
  const results: HouseholdEvidence[] = [];
  for (const item of enterprises) {
    if (localSpatialFilter) { results.push({ enterpriseCode: item.enterpriseCode, at: q.to, households: null, validFrom: null, validTo: null, version: null, value: null, reason: '当前空间筛选仅覆盖局部人口，不能使用整企业户数', label: '候选期末户数' }); continue; }
    results.push(await householdRate(db, q, item.enterpriseCode, item.count, access, permissions, partial, []));
  }
  return results;
}
