// 来源展示字段独立列：行业主管部门/保密/自办自结/事项分类/小类/主办单位/办理结果/回复市民结果。
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=20');
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint', name))) await knex.schema.alterTable('complaint', define);
  };
  await add('industry_department', (t) => t.string('industry_department', 255).nullable());
  await add('is_confidential', (t) => t.string('is_confidential', 16).nullable());
  await add('self_handled', (t) => t.string('self_handled', 16).nullable());
  await add('item_category', (t) => t.string('item_category', 255).nullable());
  await add('source_sub_category', (t) => t.string('source_sub_category', 255).nullable());
  await add('source_department_name', (t) => t.string('source_department_name', 128).nullable());
  await add('handling_result', (t) => t.text('handling_result').nullable());
  await add('reply_to_citizen', (t) => t.text('reply_to_citizen').nullable());
};
exports.down = async () => {
  throw Error('Preserve source display evidence; rollback requires explicit data decision');
};
