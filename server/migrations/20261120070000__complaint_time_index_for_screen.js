/**
 * 统计查询性能优化：给 source_reported_at 加索引
 *
 * 背景（实测 2026-11-20）：
 *   complaint 表 53,339 行 / 数据显示 1128.9 MB，大屏 bootstrap 单次 5.2 秒，
 *   首屏要发 6 个 bootstrap → 约 30 秒才能全部就绪。
 *
 * 根因：统计查询的时间条件写成 `coalesce(c.source_reported_at, c.received_at) between ? and ?`，
 *   函数包裹列导致 MySQL 无法使用任何索引（EXPLAIN type=ALL，全表扫描 26575 行），
 *   每次都要在 1.1GB 数据上扫一遍。
 *
 * 实测数据分布（关键）：
 *   source_reported_at 非空 53339 / 53339 = 100%，为空 0 条
 *   → coalesce 的兜底分支实际上从未生效，语义上等价于直接查 source_reported_at
 *
 * 优化：
 *   ① 给 source_reported_at 建索引（配合 received_at 的兜底分支）
 *   ② 查询改写为可走索引的形式：
 *      (c.source_reported_at between ? and ?)
 *      or (c.source_reported_at is null and c.received_at between ? and ?)
 *      —— 保留 null 兜底语义，但主路径能走范围索引
 *
 * 预期：命中索引后从 ~2850ms 降到 ~50ms 量级（取决于返回行数）。
 */

exports.up = async (db) => {
  const [idx] = await db.raw(
    "select index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));

  // 主索引：source_reported_at 单列（统计查询的主时间轴）
  if (!names.has('idx_complaint_reported_at')) {
    await db.raw('alter table complaint add index idx_complaint_reported_at (source_reported_at)');
  }

  // 复合索引：时间 + 常用分组列，覆盖「按时间过滤 + 按区县/类型聚合」的常见组合
  if (!names.has('idx_complaint_reported_district')) {
    await db.raw(
      'alter table complaint add index idx_complaint_reported_district (source_reported_at, district_code)'
    );
  }
};

exports.down = async (db) => {
  const [idx] = await db.raw(
    "select index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));
  if (names.has('idx_complaint_reported_district')) await db.raw('alter table complaint drop index idx_complaint_reported_district');
  if (names.has('idx_complaint_reported_at')) await db.raw('alter table complaint drop index idx_complaint_reported_at');
};