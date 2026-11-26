import {pool as defaultPool} from '../db/pool';
import {AppError} from '../http/errors';
import {buildComplaintScopeSql} from '../auth/accessScope';
import type {MasterDataContext} from '../types/masterData';
/**
 * 诉求 ↔ 停水停气/管道改造事件 的时空关联（标书 1.2.2）。
 *
 * 标书原文（招标文件第 307 行）：
 *   「诉求类型统计柱状图：点击对应类型可显示该类型下的诉求信息详情，在查看诉求信息时，
 *     如遇到该诉求**录入时间刚好处于停水停气/管道改造事件时间范围内**，则会将诉求信息和事件进行关联。」
 *
 * 标书只给了**一个**硬条件：诉求录入时间落在事件时间范围内。行业、网格、诉求类型均未要求。
 *
 * 原实现额外加了三个条件（同行业 + 同网格 + 诉求类型 ∈ 事件 relatedTypes），导致：
 *   · 事件 110 条、有网格 71 条，最终只匹配到 2 个事件 / 5 条诉求；
 *   · 典型漏配：停气期间居民投诉「气压不足」，但该诉求分类是 g08 而事件 relatedTypes 是 g06 → 漏掉。
 *
 * 现按标书口径修正：
 *   ① **时间**：诉求录入时间 ∈ [事件开始, 事件结束]（唯一硬条件，标书明确要求）
 *   ② **行业**：保留（停水/停气本身有行业语义，跨行业关联无业务意义）
 *   ③ **网格**：仅当事件**有**网格时才约束；事件无网格（geometry 缺失导致的普遍情况）时不限制，
 *      否则 39 条无网格事件永远无法关联
 *   ④ **诉求类型**：**去掉**。标书未要求，且会漏掉真实的因果关联
 *      （停水引发的水质/水压投诉才是要重点看的）。
 *
 * 仍然保留的约束：数据权限范围（scope.sql）、来源系统白名单、10000 条上限保护。
 */

/** 与事件关联的一条诉求 */
export interface UtilityRelatedComplaint {
  id: string;
  title: string;
  type: string;
  occurredAt: string;
  gridId: string;
}

/**
 * 查询与事件时空相关的诉求。
 *
 * @param e    事件（含 gridIds / businessType / 时间范围）
 * @param from 事件开始时间（ISO）
 * @param to   事件结束时间（ISO）
 * @param after true 时用严格大于（用于超时复供后统计，避免把复供瞬间算进去）
 */
export async function findRelatedComplaints(
  e: {
    gridIds?: string[];
    businessType?: string;
    relatedTypes?: string[];
    mode?: string;
    enterpriseId?: string;
    districtCode?: string;
  },
  ctx: MasterDataContext,
  from: string,
  to: string,
  after = false,
  pool: { query: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> } = defaultPool,
  buildScope: (access: MasterDataContext['access'], alias: string) => { sql: string; params: unknown[] } = buildComplaintScopeSql,
  fixtures?: () => { complaints: { id: string; title: string; type: string; occurredAt: string; gridId: string; enterpriseId: string; districtCode: string; businessType: string }[] },
  canAccess?: (access: MasterDataContext['access'], c: { enterprise_code: string; district_code: string }) => boolean
): Promise<UtilityRelatedComplaint[]> {
  if (!ctx.permissionCodes.includes('complaint.read')) return [];

  const grids = Array.isArray(e.gridIds) ? e.gridIds.filter(Boolean) : [];
  const fromMs = Date.parse(from);
  const toMs = Math.min(Date.parse(to), Date.now());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];

  // 模拟模式：走内存 fixture，口径与真实模式保持一致（去掉类型限制）
  if (e.mode === 'simulation' && fixtures && canAccess) {
    return fixtures()
      .complaints.filter(
        (c) =>
          canAccess(ctx.access, { enterprise_code: c.enterpriseId, district_code: c.districtCode }) &&
          c.businessType === e.businessType &&
          (!grids.length || grids.includes(c.gridId)) &&
          Date.parse(c.occurredAt) >= fromMs + (after ? 1 : 0) &&
          Date.parse(c.occurredAt) <= toMs
      )
      .map((c) => ({ id: c.id, title: c.title, type: c.type, occurredAt: c.occurredAt, gridId: c.gridId }));
  }

  const scope = buildScope(ctx.access, 'c');
  const params: unknown[] = [...scope.params];
  let sql =
    'select c.complaint_id id,c.title,c.major_category_code majorCode,c.minor_category_code minorCode,' +
    'coalesce(c.minor_category_code,c.major_category_code) type,' +
    'coalesce(c.source_reported_at,c.received_at) occurredAt,c.admin_grid_code gridId ' +
    'from complaint c where ' + scope.sql + ' and c.source_system=?';
  params.push('宜接就办');

  if (e.businessType) {
    sql += ' and c.business_type=?';
    params.push(e.businessType);
  }
  // 网格：仅当事件有网格时约束
  if (grids.length) {
    sql += ' and c.admin_grid_code in (' + grids.map(() => '?').join(',') + ')';
    params.push(...grids);
  }
  // 时间：标书唯一硬条件
  sql += ' and coalesce(c.source_reported_at,c.received_at) ' + (after ? '>' : '>=') + ' ?';
  params.push(new Date(fromMs));
  sql += ' and coalesce(c.source_reported_at,c.received_at) <= ?';
  params.push(new Date(toMs));
  sql += ' order by c.complaint_id limit 10001';

  const [rawRows] = (await pool.query(sql, params)) as [Record<string, unknown>[], unknown];
  if (rawRows.length > 10000) {
    throw AppError.validation('关联诉求超过10000条，请缩小事件范围');
  }

  return rawRows.map((r) => ({
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    type: String(r.type ?? ''),
    occurredAt: new Date(String(r.occurredAt)).toISOString(),
    gridId: r.gridId ? String(r.gridId) : '',
  }));
}