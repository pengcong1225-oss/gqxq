// 诉求人姓名/电话：从宜接就办导出第 8/9 列入库。
// 与诉求主表隔离，AES-256-GCM 加密存储；仅详情接口按权限解密返回。
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('complaint_citizen'))) {
    await knex.schema.createTable('complaint_citizen', (t) => {
      t.string('complaint_id', 64).primary();
      t.text('name_enc').nullable();
      t.text('phone_enc').nullable();
      t.string('name_masked', 64).nullable();
      t.string('phone_masked', 32).nullable();
      t.string('source_system', 32).nullable();
      t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());
      t.index(['updated_at'], 'idx_complaint_citizen_updated');
    });
  }
};
exports.down = async () => {
  throw Error('Preserve complaint_citizen evidence; rollback requires explicit data decision');
};
