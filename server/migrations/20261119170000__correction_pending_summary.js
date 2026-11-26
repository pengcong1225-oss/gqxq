// 待纠偏队列汇总表：把「按诉求聚合的待处理项」物化，避免每次分页都扫描 26 万条纠偏项。
exports.up = async (knex) => {
  const has = await knex.schema.hasTable('correction_pending_summary');
  if (!has) {
    await knex.schema.createTable('correction_pending_summary', (t) => {
      t.string('complaint_id', 64).primary();
      t.integer('pending_count').notNullable();
      t.boolean('needs_manual_location').notNullable().defaultTo(false);
      t.dateTime('first_pending_at').notNullable();
      t.string('manual_location_reason', 255).nullable();
      t.dateTime('refreshed_at').notNullable();
      t.index(['needs_manual_location', 'first_pending_at'], 'ix_cps_manual_first');
      t.index(['first_pending_at'], 'ix_cps_first');
    });
  }
  // 覆盖索引：状态+诉求+入队时间，聚合可走流式分组（无回表）
  const [rows] = await knex.raw(
    "select 1 from information_schema.statistics where table_schema=database() and table_name='correction_item' and index_name='ix_ci_status_complaint_created' limit 1"
  );
  if (!rows.length) {
    await knex.raw('alter table correction_item add index ix_ci_status_complaint_created (status, complaint_id, created_at)');
  }
};
exports.down = async () => {
  throw Error('Pending summary is required for queue performance');
};
