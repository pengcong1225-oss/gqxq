import { householdRate } from './statisticsService';
import type { StatisticsQuery, HouseholdEvidence } from '../types/statistics';
import type { AccessContext } from '../auth/accessScope';
import type { SqlExecutor } from '../repositories/userRepo';
import { rowsIn } from '../repositories/serviceGridRepo';
/**
 * 企业「大屏显示名」读取（只读）：标书 1.1.8 的「是否大屏显示 / 大屏显示企业名」由后台企业管理维护，
 * 大屏企业万户柱必须消费它，而不是在前端硬编码企业名。
 *   display_on_screen=1 → screen_name（空则回退 enterprise_name）
 *   其余（0/null）→ null，调用方显示编码，不编造名称
 */
async function screenDisplayNames(db: SqlExecutor, codes: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!codes.length) return names;
  const rows = await rowsIn(db, 'select enterprise_code, enterprise_name, screen_name, display_on_screen from enterprise where enterprise_code in (' + codes.map(() => '?').join(',') + ')', codes);
  for (const row of rows) {
    if (Number(row.display_on_screen) !== 1) continue;
    const name = String(row.screen_name ?? '').trim() || String(row.enterprise_name ?? '').trim();
    if (name) names.set(String(row.enterprise_code), name);
  }
  return names;
}
export async function screenHouseholdEvidence(db: SqlExecutor, q: StatisticsQuery, access: AccessContext, permissions: readonly string[], enterprises: { enterpriseCode: string; count: number }[], partial: boolean, localSpatialFilter: boolean): Promise<HouseholdEvidence[]> {
  const results: HouseholdEvidence[] = [];
  const displayNames = await screenDisplayNames(db, enterprises.map((x) => x.enterpriseCode));
  for (const item of enterprises) {
    if (localSpatialFilter) { results.push({ enterpriseCode: item.enterpriseCode, at: q.to, households: null, validFrom: null, validTo: null, version: null, value: null, reason: '当前空间筛选仅覆盖局部人口，不能使用整企业户数', label: '候选期末户数', displayName: displayNames.get(item.enterpriseCode) ?? null }); continue; }
    results.push({ ...(await householdRate(db, q, item.enterpriseCode, item.count, access, permissions, partial, [])), displayName: displayNames.get(item.enterpriseCode) ?? null });
  }
  return results;
}