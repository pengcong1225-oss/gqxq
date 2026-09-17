// M1 新增 G1 所需表。
// 全部 create table if not exists，可在全新环境重放。
// 约定沿用现有 schema：varchar(64) 业务键 + 数值自增主键、datetime（UTC）、utf8mb4。

exports.up = async (knex) => {
  await knex.raw(
    "create table if not exists complaint_source_log (" +
    "  id            bigint primary key auto_increment," +
    "  log_id        varchar(64)  not null unique," +
    "  source_system varchar(64)  not null," +
    "  source_id     varchar(128) not null," +
    "  complaint_id  varchar(64)      null comment '落库成功时回填'," +
    "  payload_hash  char(64)     not null," +
    "  payload       json         not null," +
    "  result        varchar(24)  not null comment 'created/duplicate_same/updated/rejected'," +
    "  message       varchar(500)     null," +
    "  remote_ip     varchar(64)      null," +
    "  request_id    varchar(64)      null," +
    "  received_at   datetime     not null default current_timestamp," +
    "  key idx_csl_source   (source_system, source_id, received_at)," +
    "  key idx_csl_received (received_at)" +
    ") engine=InnoDB default charset=utf8mb4 comment='外部投递日志（追加写）'"
  );

  await knex.raw(
    "create table if not exists complaint_field_version (" +
    "  id            bigint primary key auto_increment," +
    "  version_id    varchar(64) not null unique," +
    "  complaint_id  varchar(64) not null," +
    "  field_name    varchar(64) not null," +
    "  old_value     text," +
    "  new_value     text," +
    "  change_source varchar(24) not null comment 'external_redelivery/manual_edit/rule_engine/data_repair'," +
    "  reason        varchar(500)," +
    "  operator_id   varchar(64)," +
    "  operator_name varchar(64)," +
    "  changed_at    datetime not null default current_timestamp," +
    "  key idx_cfv_complaint (complaint_id, changed_at)" +
    ") engine=InnoDB default charset=utf8mb4 comment='诉求字段变更版本（追加写）'"
  );

  await knex.raw(
    "create table if not exists number_sequence (" +
    "  seq_key       varchar(32) not null," +
    "  biz_date      date        not null," +
    "  current_value bigint      not null default 0," +
    "  updated_at    datetime    not null default current_timestamp on update current_timestamp," +
    "  primary key (seq_key, biz_date)" +
    ") engine=InnoDB default charset=utf8mb4 comment='按日发号器'"
  );

  await knex.raw(
    "create table if not exists app_user (" +
    "  id            bigint primary key auto_increment," +
    "  user_id       varchar(64)  not null unique," +
    "  username      varchar(64)  not null unique," +
    "  password_hash varchar(100) not null comment 'bcrypt'," +
    "  real_name     varchar(64)  not null," +
    "  roles         json         not null," +
    "  permissions   json         not null," +
    "  status        tinyint      not null default 1," +
    "  last_login_at datetime," +
    "  created_at    datetime     not null default current_timestamp," +
    "  updated_at    datetime     not null default current_timestamp on update current_timestamp" +
    ") engine=InnoDB default charset=utf8mb4 comment='系统用户（独立运行）'"
  );
};

exports.down = async (knex) => {
  await knex.raw('drop table if exists app_user');
  await knex.raw('drop table if exists number_sequence');
  await knex.raw('drop table if exists complaint_field_version');
  await knex.raw('drop table if exists complaint_source_log');
};
