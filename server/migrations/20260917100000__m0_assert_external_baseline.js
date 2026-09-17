// M0 接管基线断言。
// 背景：gqxq_service 的 19 张表由 zhuxin-platform 的 Flyway V1+V3+V8 建立（2026-06-29）。
// 本仓库自本次起接管该库的 DDL（增量），因此第一条迁移必须先证明"外部基线确实存在"，
// 避免连错库时后续迁移在一个空库上"假装成功"。
const EXPECTED_TABLES = [
  'complaint', 'complaint_rule_result', 'address_correction', 'dispatch_order', 'dispatch_archive',
  'enterprise', 'enterprise_certificate', 'service_grid', 'grid_enterprise', 'shutdown_application',
  'pipeline_project', 'report_record', 'dict_type', 'dict_item', 'attachment', 'process_log',
  'sync_log', 'operation_audit_log', 'legacy_migration_map',
];

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    'select table_name as t from information_schema.tables where table_schema = database()'
  );
  const have = new Set(rows.map((r) => String(r.t).toLowerCase()));
  const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new Error(
      '[M0] 外部基线不完整：缺少 ' + missing.length + ' 张表 [' + missing.join(', ') +
      ']。已中止迁移。请确认 GQXQ_DB_NAME 指向的是已应用 zhuxin-platform V1+V3+V8 的 gqxq_service 库。'
    );
  }
  const [cnt] = await knex.raw('select count(*) as c from complaint');
  const [idx] = await knex.raw(
    "select index_name as i from information_schema.statistics " +
    "where table_schema = database() and table_name = 'complaint' and index_name = 'uk_source'"
  );
  if (idx.length === 0) {
    throw new Error('[M0] 未找到 complaint.uk_source 唯一键，去重依赖缺失，已中止迁移。');
  }
  console.log('[M0] 外部基线校验通过：19/19 张表齐全，uk_source 存在，complaint 现有 ' + cnt[0].c + ' 行。');
};

exports.down = async () => {
  // 基线断言没有需要回滚的结构变更
};
