// 老系统（综合查询 26 列）特有的展示字段：街道/社区/网格/坐席满意度/接线员/二级单位/在线办结依据/定位情况。
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=20');
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint', name))) await knex.schema.alterTable('complaint', define);
  };
  await add('street_name', (t) => t.string('street_name', 64).nullable());
  await add('community_name', (t) => t.string('community_name', 128).nullable());
  await add('grid_name', (t) => t.string('grid_name', 128).nullable());
  await add('seat_satisfaction', (t) => t.string('seat_satisfaction', 32).nullable());
  await add('operator_name', (t) => t.string('operator_name', 64).nullable());
  await add('secondary_department', (t) => t.string('secondary_department', 128).nullable());
  await add('online_close_basis', (t) => t.string('online_close_basis', 255).nullable());
  await add('location_flag', (t) => t.string('location_flag', 32).nullable());
};
exports.down = async () => {
  throw Error('Preserve old-template evidence; rollback requires explicit data decision');
};
