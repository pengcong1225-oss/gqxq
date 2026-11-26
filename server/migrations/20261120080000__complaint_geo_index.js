/**
 * 地图点击浮层查询性能：给 community_code / admin_grid_code 加索引。
 *
 * 背景（实测 2026-11-20）：
 *   `/screen/map-pick-demands` 单次 8 秒，主要花在两个没有索引的列上：
 *     · count where admin_grid_code='420502'            → 2855ms（全表扫描）
 *     · count where community_code='C-420507-0044'      → 2086ms（全表扫描）
 *   complaint 表 53,339 行 / 1.1GB，任何无索引列过滤都是全表扫描。
 *
 * 加索引后这两条会走范围索引，预期降到 10ms 量级。
 *
 * 说明：这两个索引同时服务主屏统计（按区县/网格/小区筛选）与 stops 图层的关联查询，
 * 属通用收益，不是为单一接口打的补丁。
 */

exports.up = async (db) => {
  const [idx] = await db.raw(
    "select distinct index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));

  // 小区编码：地图点击点位、按小区下钻都会用到
  if (!names.has('idx_complaint_community')) {
    await db.raw('alter table complaint add index idx_complaint_community (community_code)');
  }

  // 网格编码：按网格筛选、地图点击网格、停水停气/管线图层的网格关联
  if (!names.has('idx_complaint_admin_grid')) {
    await db.raw('alter table complaint add index idx_complaint_admin_grid (admin_grid_code)');
  }

  // 复合：网格 + 上报时间，覆盖「某网格某时间窗内有多少工单」这类最常用组合
  if (!names.has('idx_complaint_grid_reported')) {
    await db.raw(
      'alter table complaint add index idx_complaint_grid_reported (admin_grid_code, source_reported_at)'
    );
  }
};

exports.down = async (db) => {
  const [idx] = await db.raw(
    "select distinct index_name from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const names = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));
  for (const k of ['idx_complaint_grid_reported', 'idx_complaint_admin_grid', 'idx_complaint_community']) {
    if (names.has(k)) await db.raw(`alter table complaint drop index ${k}`);
  }
};