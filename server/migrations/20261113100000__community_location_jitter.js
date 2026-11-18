// 小区定位与坐标抖动（展示层）持久化。
// 设计边界：location_* 是主数据定位结果；jitter_* 只能用于地图展示，绝不覆盖 location_*。
// 抖动由住新数据服务中心 /api/v1/jitter/jobs 异步完成；失败保留 error，不伪造坐标。
exports.up = async (knex) => {
  const add = async (table, columns) => {
    for (const [name, define] of columns) {
      if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, (t) => define(t));
    }
  };
  await add('community', [
    ['district_code', (t) => t.string('district_code', 64).nullable()],
    ['location_lng', (t) => t.decimal('location_lng', 12, 8).nullable()],
    ['location_lat', (t) => t.decimal('location_lat', 12, 8).nullable()],
    ['location_coordinate_system', (t) => t.string('location_coordinate_system', 16).nullable()],
    ['location_source', (t) => t.string('location_source', 500).nullable()],
    ['location_state', (t) => t.string('location_state', 24).nullable()],
    ['location_at', (t) => t.dateTime('location_at').nullable()],
    ['jitter_lng', (t) => t.decimal('jitter_lng', 12, 8).nullable()],
    ['jitter_lat', (t) => t.decimal('jitter_lat', 12, 8).nullable()],
    ['jitter_state', (t) => t.string('jitter_state', 24).nullable()],
    ['jitter_job_id', (t) => t.string('jitter_job_id', 64).nullable()],
    ['jitter_at', (t) => t.dateTime('jitter_at').nullable()],
    ['jitter_message', (t) => t.string('jitter_message', 500).nullable()],
  ]);
  const [indexes] = await knex.raw('show index from community');
  const names = new Set(indexes.map((i) => i.Key_name));
  if (!names.has('idx_community_location_state')) await knex.raw('alter table community add index idx_community_location_state (location_state)');
  if (!names.has('idx_community_jitter_state')) await knex.raw('alter table community add index idx_community_jitter_state (jitter_state)');
};
exports.down = async () => {
  throw Error('Preserve community location/jitter evidence; rollback requires explicit restoration');
};
