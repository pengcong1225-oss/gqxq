// M11 —— complaint 增「超期时效」派生标记列 overtime_flag。
//
// 依据：D20 裁定（解决 D7 的已知取舍）。宜接就办导出快照的「督办状态」把**状态**与**时效**
//   两件事压在同一个字段里：
//     正常在办 -> processing（时效未知）
//     正常结案 -> completed + 未超期
//     超期结案 -> completed + 超期        ← 只存 source_event_status 时「超期」这一维在列上丢失
//   原文仍逐字保留在 snapshot.rawStatus 与 sync_log.response_body（事实不丢），
//   本列只是把其中「时效」这一维**派生**出来，便于筛选与统计。
//
// 三态语义（注释与列定义保持一致，NULL 不是 0）：
//   NULL = 来源未给出时效信息（未同步 / 正常在办 / 来源状态认不出 / 历史存量未回填）
//   0    = 来源明确给出「未超期」
//   1    = 来源明确给出「超期」
//   把「不知道」压成 0 会把未回填的历史数据谎报成「未超期」，所以本列**必须可空且默认 NULL**。
//
// 单写者不变量：本列**只由 src/repositories/sourceSyncRepo.ts 的同步路径写**
//   （与 source_event_status 同一条 UPDATE、同一把静态扫描钉住，见 scripts/verify-source-adapter.mjs
//   G6-3 与 scripts/verify-file-source-adapter.ts F5）。接收/填报/办结等路径一律不写，
//   因此新增行走 COMPLAINT_INSERT_COLUMNS 时**刻意不含本列**——入站报文没有时效口径，落 NULL 才是诚实。
//
// 只做增量：add column（可空、无默认值），不删列、不改类型、不改名、不回填业务数据行。
//   回填是下一个独立批次（D20/D7 裁定的批次②），本迁移只改 schema。
// 幂等：先查 information_schema 再决定加不加，重复执行安全。
// 回滚：down() 删除本列（DDL 隐式提交，knexfile 已 disableTransactions）。

exports.up = async (knex) => {
  const [cols] = await knex.raw(
    "select 1 from information_schema.columns where table_schema = database() and table_name = 'complaint' and column_name = 'overtime_flag' limit 1"
  );
  if (cols.length === 0) {
    await knex.raw(
      "alter table complaint add column overtime_flag tinyint unsigned null " +
        "comment '超期时效派生标记（三态）：NULL=来源未给出时效信息 / 0=未超期 / 1=超期；只由来源同步路径写' " +
        "after source_event_status"
    );
    console.log('[M11] 已新增 complaint.overtime_flag（tinyint unsigned null，三态）');
  } else {
    console.log('[M11] 列已存在，跳过');
  }
};

exports.down = async (knex) => {
  await knex.raw('alter table complaint drop column overtime_flag'); // gate-g1-allow：down() 回滚删列
};
