// 重复来电/关联首件：投诉量不合并，但需要能算「重复投诉率」。
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=30');
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint', name))) await knex.schema.alterTable('complaint', define);
  };
  await add('repeat_flag', (t) => t.boolean('repeat_flag').notNullable().defaultTo(false));
  await add('repeat_of', (t) => t.string('repeat_of', 64).nullable());
  await add('repeat_reason', (t) => t.string('repeat_reason', 255).nullable());
  const idx = async (name, sql) => {
    const [rows] = await knex.raw(
      "select 1 from information_schema.statistics where table_schema=database() and table_name='complaint' and index_name=? limit 1", [name]
    );
    if (!rows.length) await knex.raw(sql);
  };
  await idx('ix_complaint_repeat', 'alter table complaint add index ix_complaint_repeat (repeat_flag)');
  // 电话查询（重复来电判定用）
  await knex.raw("alter table complaint_citizen add index ix_cc_phone (phone_raw(32))").catch(() => undefined);
};
exports.down = async () => {
  throw Error('Repeat marking kept for reporting');
};
