// 满意度/评价独立列：从来源 metadata 回填，便于筛选和统计，不再每次解析 JSON。
exports.up = async (knex) => {
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint', name))) await knex.schema.alterTable('complaint', define);
  };
  await add('satisfaction_text', (t) => t.string('satisfaction_text', 64).nullable());
  await add('satisfaction_code', (t) => t.string('satisfaction_code', 32).nullable());
  await add('citizen_feedback_resolution', (t) => t.string('citizen_feedback_resolution', 64).nullable());
  await add('third_party_evaluation', (t) => t.string('third_party_evaluation', 64).nullable());
  await add('third_party_resolution', (t) => t.string('third_party_resolution', 64).nullable());
  const [indexes] = await knex.raw('show index from complaint');
  const names = new Set(indexes.map((i) => i.Key_name));
  if (!names.has('idx_complaint_satisfaction_code')) await knex.raw('alter table complaint add index idx_complaint_satisfaction_code (satisfaction_code)');
};
exports.down = async () => {
  throw Error('Preserve satisfaction evidence; rollback requires explicit data decision');
};
