// M6 G2 分配与分流：交办落库的表结构准备。
//
// 对应落地计划 G2：
//   1) 建 complaint_assignment（分配留痕）
//   2) 敏感识别可追溯：命中证据落 sensitive_hit
//   3) dispatch_order 真正落库 —— 补唯一请求号与"一个诉求同一轮只能有一条有效交办"的数据库约束
//   4) 无需交办归库 / 误报归库留痕：complaint_disposition
//
// 口径沿用既有 schema（小写枚举、varchar(64) 业务键），只做增量 DDL。
// 关键约束用**生成列 + 唯一键**实现——MySQL 不支持部分唯一索引：
//   NULL 不参与唯一去重，所以终态(status 不在"进行中"集合)的交办不占用约束名额。
// "进行中"集合必须与 domain/enums.ts 的 ACTIVE_SUPERVISION_STATUSES 逐字一致：
//   pending / pushed / accepted / processing / returned

const DISPATCH_COLUMNS = [
  ['request_id', "varchar(128) null comment '交办唯一请求号（G3 幂等键）'"],
  ['reason', 'varchar(500) null comment "交办原因"'],
  ['requirement', 'varchar(1000) null comment "交办要求"'],
  ['template_code', 'varchar(64) null'],
  ['template_version', 'int null'],
  ['approval_definition_code', 'varchar(64) null'],
  ['approval_definition_version', 'int null'],
  ['reporting_task_id', "varchar(128) null comment 'public-utility task.id，G3 回填'"],
  ['created_by', 'varchar(64) null'],
  ['created_by_name', 'varchar(64) null'],
  ['cancelled_at', 'datetime null'],
  ['cancel_reason', 'varchar(500) null comment "受控撤销原因"'],
];

const ACTIVE_STATUSES = "('pending','pushed','accepted','processing','returned')";

async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    'select 1 from information_schema.columns where table_schema = database() and table_name = ? and column_name = ? limit 1',
    [table, column]
  );
  return rows.length > 0;
}

async function hasIndex(knex, table, indexName) {
  const [rows] = await knex.raw(
    'select 1 from information_schema.statistics where table_schema = database() and table_name = ? and index_name = ? limit 1',
    [table, indexName]
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  // ---------- 1) dispatch_order 增列 ----------
  const missing = [];
  for (const [name, ddl] of DISPATCH_COLUMNS) {
    if (!(await hasColumn(knex, 'dispatch_order', name))) missing.push('add column ' + name + ' ' + ddl);
  }
  if (missing.length > 0) {
    await knex.raw('alter table dispatch_order ' + missing.join(', '));
    console.log('[M6] dispatch_order 新增列 ' + missing.length + ' 个');
  } else {
    console.log('[M6] dispatch_order 列已齐，跳过');
  }

  // 唯一请求号（历史 3 行为 NULL，NULL 不参与唯一去重，可安全添加）
  if (!(await hasIndex(knex, 'dispatch_order', 'uk_dispatch_request'))) {
    await knex.raw('alter table dispatch_order add unique key uk_dispatch_request (request_id)');
    console.log('[M6] 已加 uk_dispatch_request');
  }

  // 唯一有效交办：生成列 + 唯一键
  if (!(await hasColumn(knex, 'dispatch_order', 'active_complaint_id'))) {
    await knex.raw(
      'alter table dispatch_order add column active_complaint_id varchar(64) ' +
        'generated always as (if(status in ' + ACTIVE_STATUSES + ', complaint_id, null)) stored ' +
        "comment '仅进行中的交办有值，用于唯一约束'"
    );
    console.log('[M6] 已加生成列 active_complaint_id');
  }
  if (!(await hasIndex(knex, 'dispatch_order', 'uk_active_dispatch'))) {
    const [dup] = await knex.raw(
      'select complaint_id, count(*) c from dispatch_order ' +
        'where status in ' + ACTIVE_STATUSES + ' group by complaint_id having c > 1'
    );
    if (dup.length > 0) {
      throw new Error(
        '[M6] 既有数据已违反"一个诉求同一轮只能有一条有效交办"，拒绝加唯一键。冲突诉求：' +
          dup.map((d) => d.complaint_id + '(' + d.c + ')').join(', ')
      );
    }
    await knex.raw('alter table dispatch_order add unique key uk_active_dispatch (active_complaint_id)');
    console.log('[M6] 已加 uk_active_dispatch（唯一有效交办）');
  }

  // ---------- 2) complaint_assignment 分配留痕 ----------
  await knex.raw(
    'create table if not exists complaint_assignment (' +
      '  id bigint primary key auto_increment,' +
      '  assignment_log_id varchar(64) not null unique,' +
      '  complaint_id varchar(64) not null,' +
      '  before_enterprise_code varchar(64) null,' +
      '  before_enterprise_name varchar(255) null,' +
      '  after_enterprise_code varchar(64) null,' +
      '  after_enterprise_name varchar(255) null,' +
      '  match_type varchar(24) not null comment "manual/manual_clear",' +
      '  reason varchar(500) null,' +
      '  operator_id varchar(64) null,' +
      '  operator_name varchar(64) null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  key idx_ca_complaint (complaint_id, created_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="诉求责任单位分配留痕（追加写）"'
  );

  // ---------- 3) sensitive_hit 命中证据 ----------
  await knex.raw(
    'create table if not exists sensitive_hit (' +
      '  id bigint primary key auto_increment,' +
      '  complaint_id varchar(64) not null,' +
      '  keyword varchar(128) not null,' +
      '  dict_item_id varchar(64) null comment "命中的 dict_item.item_id，词条真源" ,' +
      '  matched_field varchar(32) null comment "title/content/address",' +
      '  matched_text varchar(500) null,' +
      '  rule_version varchar(32) null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  key idx_sh_complaint (complaint_id, created_at),' +
      '  key idx_sh_keyword (keyword)' +
      ') engine=InnoDB default charset=utf8mb4 comment="敏感词命中证据（追加写）"'
  );

  // ---------- 4) complaint_disposition 归库留痕 ----------
  await knex.raw(
    'create table if not exists complaint_disposition (' +
      '  id bigint primary key auto_increment,' +
      '  disposition_id varchar(64) not null unique,' +
      '  complaint_id varchar(64) not null,' +
      '  disposition varchar(32) not null comment "no_dispatch_needed(无需交办)/false_positive(误报归库)",' +
      '  is_sensitive_before tinyint null comment "处置前是否敏感，便于回查误报判定",' +
      '  reason varchar(500) null,' +
      '  operator_id varchar(64) null,' +
      '  operator_name varchar(64) null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  key idx_cd_complaint (complaint_id, created_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="诉求归库处置留痕（追加写）"'
  );

  console.log('[M6] complaint_assignment / sensitive_hit / complaint_disposition 就位');
};

exports.down = async (knex) => {
  await knex.raw('drop table if exists complaint_disposition');
  await knex.raw('drop table if exists sensitive_hit');
  await knex.raw('drop table if exists complaint_assignment');
  await knex.raw('alter table dispatch_order drop key uk_active_dispatch');
  await knex.raw('alter table dispatch_order drop column active_complaint_id');
  await knex.raw('alter table dispatch_order drop key uk_dispatch_request');
  for (const [name] of DISPATCH_COLUMNS.slice().reverse()) {
    await knex.raw('alter table dispatch_order drop column ' + name);
  }
};
