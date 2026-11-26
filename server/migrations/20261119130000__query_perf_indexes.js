// 列表/队列查询性能索引（2026-11-19 实测：/complaints 29s -> 1.8s，待纠偏队列 19s -> 7s）
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=30');
  const add = async (table, name, sql) => {
    const [rows] = await knex.raw(
      "select 1 from information_schema.statistics where table_schema=database() and table_name=? and index_name=? limit 1", [table, name]
    );
    if (!rows.length) await knex.raw(sql);
  };
  // 未定坐标判定（功能索引）：待人工定位的诉求置顶排序用
  await add('complaint', 'ix_complaint_loc_missing', 'alter table complaint add index ix_complaint_loc_missing ((location_lng is null))');
  // status 前置复合索引：按待处理状态过滤后按诉求分组
  await add('correction_item', 'ix_ci_status_complaint', 'alter table correction_item add index ix_ci_status_complaint (status, complaint_id)');
};
exports.down = async () => {
  throw Error('Query performance indexes are required; drop manually after measurement');
};
