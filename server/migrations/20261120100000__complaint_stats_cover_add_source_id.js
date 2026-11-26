/**
 * 覆盖索引再修正：加入 source_id。
 *
 * 实测链条（2026-11-20，每一步都验证过执行计划）：
 *   ① 索引 (source_reported_at, business_type, minor, major, admin_grid)
 *      纯 SQL → 106ms，Using index ✅
 *   ② + `deleted = 0`  → 2,932ms ❌ 回表（deleted 不在索引里）
 *   ③ 索引补 deleted、source_system → 139ms ✅
 *   ④ 但真实查询还带 `excludeIntegrationTestsSql()`：
 *        not (coalesce(source_system,'')='INTEGRATION...' and coalesce(source_id,'') like 'IT-%')
 *      → **source_id 不在索引里** → 又回表 → 2,723ms ❌
 *
 * 本迁移把 source_id 补进去，让整条 where 子句完全在索引内判定。
 */

const { COVER_COLUMNS, FILTER_COLUMNS, updateComplaintStatsIndexes } = require('./lib/complaint-stats-indexes');

const coverWithFilters = [...COVER_COLUMNS, ...FILTER_COLUMNS];
const coverWithSource = [...coverWithFilters, 'source_id'];

// 历史批次中的索引定义不变，使用单条 DDL 原子替换，失败时保留原索引。
exports.up = (db) => updateComplaintStatsIndexes(db, [
  {
    name: 'idx_complaint_stats_cover',
    before: coverWithFilters,
    after: coverWithSource,
    replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code, deleted, source_system, source_id)',
  },
]);

// 回滚恢复 20261120095000 的覆盖索引。
exports.down = (db) => updateComplaintStatsIndexes(db, [
  {
    name: 'idx_complaint_stats_cover',
    before: coverWithSource,
    after: coverWithFilters,
    replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code, deleted, source_system)',
  },
]);
