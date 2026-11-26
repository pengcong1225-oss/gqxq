/**
 * 修正上一版覆盖索引：把 `deleted` 纳入索引。
 *
 * ===== 实测（2026-11-20）=====
 * 上一版建了 (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code)，
 * 单独测这条 SQL 只要 106ms（Using index，纯 index-only scan）。
 *
 * 但真实查询还要带 `deleted = 0`（`buildComplaintScopeSql` 的软删除过滤），
 * 而 deleted **不在索引里** → MySQL 必须回表 → 106ms 直接变 2,932ms（27 倍）。
 *
 * 同理 `source_system`（集成测试排除 `excludeIntegrationTestsSql`）也不在索引里。
 *
 * 本迁移把这两个过滤列补进覆盖索引，让「时间+行业+分类+软删除+来源系统」
 * 这一整串条件都能在索引内完成判断，彻底避免回表。
 *
 * 顺序考量：等值/范围列放在前面，低基数列（deleted / source_system）放在末尾 ——
 * MySQL 对复合索引的最后一列用于回表前判断同样有效，
 * 且把 deleted 放末尾不影响前面列的选择性。
 */

const {
  COVER_COLUMNS, DISTRICT_COLUMNS, FILTER_COLUMNS, updateComplaintStatsIndexes,
} = require('./lib/complaint-stats-indexes');

const coverWithFilters = [...COVER_COLUMNS, ...FILTER_COLUMNS];
const districtWithFilters = [...DISTRICT_COLUMNS, ...FILTER_COLUMNS];

// 历史批次中的索引定义不变。将原先分开的删除和创建合并为一次原子替换。
exports.up = (db) => updateComplaintStatsIndexes(db, [
  {
    name: 'idx_complaint_stats_cover',
    before: COVER_COLUMNS,
    after: coverWithFilters,
    replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code, deleted, source_system)',
  },
  {
    name: 'idx_complaint_stats_district',
    before: DISTRICT_COLUMNS,
    after: districtWithFilters,
    replacement: 'alter table complaint drop index idx_complaint_stats_district, add index idx_complaint_stats_district (source_reported_at, business_type, district_code, deleted, source_system)',
  },
]);

// 回滚恢复 20261120090000 的两个索引。
exports.down = (db) => updateComplaintStatsIndexes(db, [
  {
    name: 'idx_complaint_stats_cover',
    before: coverWithFilters,
    after: COVER_COLUMNS,
    replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code)',
  },
  {
    name: 'idx_complaint_stats_district',
    before: districtWithFilters,
    after: DISTRICT_COLUMNS,
    replacement: 'alter table complaint drop index idx_complaint_stats_district, add index idx_complaint_stats_district (source_reported_at, business_type, district_code)',
  },
]);
