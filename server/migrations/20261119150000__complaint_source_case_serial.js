// 来源业务键：案件号（案件公文号 / 案件编码）与流水号，用于入库去重与旧新系统对齐。
exports.up = async (knex) => {
  await knex.raw('set session lock_wait_timeout=30');
  const add = async (name, define) => {
    if (!(await knex.schema.hasColumn('complaint', name))) await knex.schema.alterTable('complaint', define);
  };
  await add('source_case_no', (t) => t.string('source_case_no', 64).nullable());
  await add('source_serial_no', (t) => t.string('source_serial_no', 64).nullable());
  const idx = async (name, sql) => {
    const [rows] = await knex.raw(
      "select 1 from information_schema.statistics where table_schema=database() and table_name='complaint' and index_name=? limit 1", [name]
    );
    if (!rows.length) await knex.raw(sql);
  };
  await idx('ix_complaint_case_no', 'alter table complaint add index ix_complaint_case_no (source_case_no)');
  await idx('ix_complaint_serial_no', 'alter table complaint add index ix_complaint_serial_no (source_serial_no)');
};
exports.down = async () => {
  throw Error('Business keys are required for intake de-duplication');
};
