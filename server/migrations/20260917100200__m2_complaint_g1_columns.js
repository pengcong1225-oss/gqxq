// M2 complaint 增列与索引。
// 硬约束：只做增量（add column / add key），不删除、不改类型、不改名——
// 因为 zhuxin-platform 的 JdbcGqxqRepository 有 98 处 SQL 仍在读写这张表。
// 实现带"缺什么补什么"的守卫，重复执行安全。

const COLUMNS = [
  ['source_channel',         "varchar(64) null comment '来源渠道（source_system 现混装系统与渠道，历史值不动）'"],
  ['rule_confidence',        'decimal(5,2) null'],
  ['rule_version',           'varchar(32) null'],
  ['source_payload',         "json null comment '原始报文快照'"],
  ['source_payload_hash',    "char(64) null comment '规范化 JSON 的 sha256；历史行为 NULL，不伪造'"],
  ['source_reported_at',     'datetime null comment "来源声明的诉求时间"'],
  ['source_updated_at',      'datetime null comment "最近一次重传覆盖快照时间"'],
  ['source_event_status',    "varchar(24) not null default 'unknown' comment '来源事件状态（只读快照）'"],
  ['supervision_status',     "varchar(24) not null default 'none' comment '督办交办状态'"],
  ['reporting_status',       "varchar(24) not null default 'not_started' comment '填报审批状态'"],
  ['closed_in_system',       'tinyint not null default 0'],
  ['closed_by',              'varchar(64) null'],
  ['closed_by_name',         'varchar(64) null'],
  ['closed_basis',           'varchar(500) null'],
  ['analysis_included',      'tinyint not null default 0'],
  ['analysis_record_id',     'varchar(64) null'],
  ['responsible_matched_at', 'datetime null'],
  ['responsible_match_reason', 'varchar(500) null'],
];

const KEYS = [
  ['idx_complaint_supervision', 'supervision_status'],
  ['idx_complaint_reporting',   'reporting_status'],
  ['idx_complaint_received',    'received_at'],
];

exports.up = async (knex) => {
  const [cols] = await knex.raw(
    "select column_name as c from information_schema.columns where table_schema = database() and table_name = 'complaint'"
  );
  const haveCols = new Set(cols.map((r) => String(r.c).toLowerCase()));
  const missingCols = COLUMNS.filter((row) => !haveCols.has(row[0]));
  if (missingCols.length > 0) {
    const ddl = missingCols.map((row) => 'add column ' + row[0] + ' ' + row[1]).join(', ');
    await knex.raw('alter table complaint ' + ddl);
    console.log('[M2] 新增列 ' + missingCols.length + ' 个：' + missingCols.map((r) => r[0]).join(', '));
  } else {
    console.log('[M2] 列已齐，跳过');
  }

  const [idx] = await knex.raw(
    "select index_name as i from information_schema.statistics where table_schema = database() and table_name = 'complaint'"
  );
  const haveIdx = new Set(idx.map((r) => String(r.i).toLowerCase()));
  const missingKeys = KEYS.filter((row) => !haveIdx.has(row[0]));
  if (missingKeys.length > 0) {
    const ddl = missingKeys.map((row) => 'add key ' + row[0] + ' (' + row[1] + ')').join(', ');
    await knex.raw('alter table complaint ' + ddl);
    console.log('[M2] 新增索引 ' + missingKeys.length + ' 个：' + missingKeys.map((r) => r[0]).join(', '));
  } else {
    console.log('[M2] 索引已齐，跳过');
  }
};

exports.down = async (knex) => {
  // 仅回滚本迁移新增的索引与列（不触碰既有 29 列）
  for (const row of KEYS) {
    await knex.raw('alter table complaint drop key ' + row[0]);
  }
  for (const row of COLUMNS.slice().reverse()) {
    await knex.raw('alter table complaint drop column ' + row[0]);
  }
};
