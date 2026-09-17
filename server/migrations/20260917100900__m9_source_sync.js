// M9 G6 来源对接：记录「最近一次来源状态同步时间」。
//
// 适配器契约（落地计划 G6）要求包含"最近同步时间"。不新增表——
// 同步日志复用既有的 sync_log（它本就有 app_code/target_system/biz_type/biz_id/result/created_at），
// 这里只在 complaint 上加一列，便于列表页直接展示而不必聚合 sync_log。
//
// 注意：**不改 source_event_status 的语义**——它仍然是"宜接就办只读快照"，
// 适配器未启用时必须保持 unknown，绝不填任何模拟进度。

exports.up = async (knex) => {
  const [cols] = await knex.raw(
    "select 1 from information_schema.columns where table_schema = database() and table_name = 'complaint' and column_name = 'source_synced_at' limit 1"
  );
  if (cols.length === 0) {
    await knex.raw(
      "alter table complaint add column source_synced_at datetime null " +
        "comment '最近一次从来源适配器同步状态的时间；未接入时为 NULL' after source_updated_at"
    );
    console.log('[M9] 已新增 complaint.source_synced_at');
  } else {
    console.log('[M9] 列已存在，跳过');
  }
};

exports.down = async (knex) => {
  await knex.raw('alter table complaint drop column source_synced_at');
};
