// M8 G5 回传后流程：纠偏待办 -> 分析库 -> 待查报告。
//
// 落地计划 G5 的硬规则：**未纠偏不得进入分析库**。
// 因此三张表串成一条链：correction_item（逐字段待确认）-> 全部确认后生成 analysis_record -> 生成 report_todo。
// "本系统办结" 的列 G1 已在 complaint 上建好（closed_in_system/closed_at/closed_by/closed_by_name/closed_basis），
// 本迁移不重复建，只补一条"办结必须留依据"的约束说明。
//
// 口径沿用既有 schema：小写枚举、varchar(64) 业务键、datetime 存上海墙钟。

exports.up = async (knex) => {
  // ---------- 纠偏待办：逐字段一行 ----------
  await knex.raw(
    'create table if not exists correction_item (' +
      '  id bigint primary key auto_increment,' +
      '  correction_id varchar(64) not null unique,' +
      '  complaint_id varchar(64) not null,' +
      '  assignment_id varchar(64) null comment "来源交办，便于回查是哪个任务触发的纠偏",' +
      '  field_name varchar(64) not null comment "enterprise_name/district_name/address/category/lng/lat/summary/disposal_result",' +
      '  field_label varchar(64) null comment "中文名，供页面直接展示",' +
      '  old_value text null,' +
      '  new_value text null,' +
      '  basis varchar(500) null comment "纠偏依据（人工填写）",' +
      '  status varchar(16) not null default "pending" comment "pending/confirmed/rejected",' +
      '  confirmer_id varchar(64) null,' +
      '  confirmer_name varchar(64) null,' +
      '  confirmed_at datetime null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  key idx_ci_complaint (complaint_id, status),' +
      '  key idx_ci_status (status, created_at),' +
      '  key idx_ci_assignment (assignment_id)' +
      ') engine=InnoDB default charset=utf8mb4 comment="纠偏待办（逐字段一行）"'
  );

  // ---------- 分析库：只有纠偏确认后才写入 ----------
  await knex.raw(
    'create table if not exists analysis_record (' +
      '  id bigint primary key auto_increment,' +
      '  analysis_id varchar(64) not null unique,' +
      '  complaint_id varchar(64) not null,' +
      '  assignment_id varchar(64) null,' +
      '  business_type varchar(32) null,' +
      '  complaint_type varchar(32) null,' +
      '  district_code varchar(64) null,' +
      '  district_name varchar(128) null,' +
      '  enterprise_code varchar(64) null,' +
      '  enterprise_name varchar(255) null,' +
      '  summary varchar(1000) null comment "诉求摘要，纠偏后的口径",' +
      '  disposal_result text null comment "企业处置结果原文，来自回传事件",' +
      '  confirmed_at datetime not null comment "纠偏全部确认的时间，分析记录的成立时点",' +
      '  payload json null comment "生成时的快照，便于回查",' +
      '  created_at datetime not null default current_timestamp,' +
      '  unique key uk_ar_complaint (complaint_id) comment "一个诉求只入分析库一次",' +
      '  key idx_ar_created (created_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="分析库（由已确认纠偏生成）"'
  );

  // ---------- 待查报告待办 ----------
  await knex.raw(
    'create table if not exists report_todo (' +
      '  id bigint primary key auto_increment,' +
      '  todo_id varchar(64) not null unique,' +
      '  analysis_id varchar(64) not null,' +
      '  complaint_id varchar(64) not null,' +
      '  report_id varchar(64) null comment "正式报告编号，报告规则待业务确认，先留空",' +
      '  status varchar(16) not null default "pending" comment "pending/in_progress/done",' +
      '  note varchar(500) null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  updated_at datetime not null default current_timestamp on update current_timestamp,' +
      '  unique key uk_rt_analysis (analysis_id) comment "一条分析记录只生成一个待查入口",' +
      '  key idx_rt_status (status, created_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="待查报告待办"'
  );

  console.log('[M8] correction_item / analysis_record / report_todo 就位');
};

exports.down = async (knex) => {
  await knex.raw('drop table if exists report_todo');
  await knex.raw('drop table if exists analysis_record');
  await knex.raw('drop table if exists correction_item');
};
