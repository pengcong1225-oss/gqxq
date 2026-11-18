// 市民姓名/电话原文列：用户明确要求原样入库；加密列保留用于备份/兼容。
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=20');
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint_citizen', name))) await knex.schema.alterTable('complaint_citizen', define);
  };
  await add('name_raw', (t) => t.string('name_raw', 64).nullable());
  await add('phone_raw', (t) => t.string('phone_raw', 32).nullable());
};
exports.down = async () => {
  throw Error('Preserve citizen raw evidence; rollback requires explicit data decision');
};
