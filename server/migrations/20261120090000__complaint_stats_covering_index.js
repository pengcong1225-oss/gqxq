/**
 * 统计/研判查询的覆盖索引。
 *
 * ===== 实测根因（2026-11-20）=====
 * complaint 表数据量 1128.9 MB / 53,339 行，而 innodb_buffer_pool_size 只有 256MB ——
 * 主表数据**无法常驻内存**，任何回表都是磁盘随机读。
 *
 *   只查 source_reported_at（idx_complaint_reported_at 覆盖） →    87 ms
 *   + business_type / minor_category_code（需回表）            → 2,941 ms   ← 34 倍
 *
 * 也就是说：索引扫描没问题，**回表**才是瓶颈。冬夏研判要跨 5 个保障季，
 * 命中 508 行却要 2.9 秒，就是因为这 508 行分散在主表各处，每行都要一次随机 IO。
 *
 * ===== 方案 =====
 * 建一个覆盖索引：把「时间 + 行业 + 分类 + 研判需要的分组维度」全部放进索引，
 * 让 MySQL 走 index-only scan（Using index），完全不回表。
 *
 * 索引列选择依据：
 *   · source_reported_at  —— 所有统计的时间轴（双时间窗的主分支）
 *   · business_type       —— 供气/供水分流
 *   · minor_category_code —— 研判规则的主分类（g08/w04 等）
 *   · major_category_code —— 分研规则的大类兜底
 *   · admin_grid_code     —— Top6 网格排名
 * 这五列足以覆盖「按时间+行业+分类过滤、按网格分组计数」这类最重的查询。
 *
 * 代价：索引增大（预计 15~25MB），写入略慢。相对 30 倍的读提升完全值得。
 */

exports.up = async (db) => {
  const [idx] = await db.raw(
    "select distinct index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));

  // 覆盖索引 1：研判主路径（时间 + 行业 + 分类 + 网格）
  if (!names.has('idx_complaint_stats_cover')) {
    await db.raw(
      'alter table complaint add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code)'
    );
  }

  // 覆盖索引 2：主屏统计路径（时间 + 行业 + 区县，区县是最高频筛选）
  if (!names.has('idx_complaint_stats_district')) {
    await db.raw(
      'alter table complaint add index idx_complaint_stats_district (source_reported_at, business_type, district_code)'
    );
  }
};

exports.down = async (db) => {
  const [idx] = await db.raw(
    "select distinct index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));
  for (const k of ['idx_complaint_stats_district', 'idx_complaint_stats_cover']) {
    if (names.has(k)) await db.raw(`alter table complaint drop index ${k}`);
  }
};