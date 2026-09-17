// M7 G3/G4 跨系统集成的表结构。
//
// G3 出站（gqxq -> public-utility 创建填报任务）：
//   dispatch_request_log —— 每次推送/重试的原始请求、响应、ACK、失败原因与重试次数
// G4 入站（public-utility -> gqxq 回传结果事件）：
//   business_event —— 回传事件原文 + 处理结果，event_id 唯一，是幂等依据
//   approval_trace —— 签收/提交/退回/最终审批轨迹（追加写）
//
// 口径沿用既有 schema：小写枚举、varchar(64) 业务键、datetime 存 Asia/Shanghai 墙钟。

exports.up = async (knex) => {
  // ---------- G3：推送请求日志（追加写，一次尝试一行） ----------
  await knex.raw(
    'create table if not exists dispatch_request_log (' +
      '  id bigint primary key auto_increment,' +
      '  request_log_id varchar(64) not null unique,' +
      '  assignment_id varchar(64) not null,' +
      '  complaint_id varchar(64) null,' +
      '  request_id varchar(128) not null comment "交办唯一请求号，与 dispatch_order.request_id 对应",' +
      '  direction varchar(16) not null default "push" comment "push/query",' +
      '  endpoint varchar(255) null,' +
      '  nonce varchar(128) null comment "本次尝试用的 nonce（重试必须换新）",' +
      '  signature varchar(128) null,' +
      '  http_status int null,' +
      '  result varchar(24) not null comment "success/replay/conflict/auth_failed/payload_too_large/validation_failed/timeout/network_error",' +
      '  error_code varchar(64) null comment "对方返回的 code，如 INTEGRATION_REPLAY",' +
      '  error_message varchar(2000) null,' +
      '  attempt int not null default 1,' +
      '  task_id varchar(128) null comment "成功时对方的 task.id",' +
      '  request_body longtext null,' +
      '  response_body longtext null,' +
      '  started_at datetime null,' +
      '  finished_at datetime null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  unique key uk_drl_request_attempt (request_id, attempt),' +
      '  key idx_drl_assignment (assignment_id, created_at),' +
      '  key idx_drl_result (result, created_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="跨系统推送请求日志（追加写）"'
  );

  // ---------- G4：回传事件（event_id 唯一 = 幂等键） ----------
  await knex.raw(
    'create table if not exists business_event (' +
      '  id bigint primary key auto_increment,' +
      '  event_id varchar(128) not null unique,' +
      '  event_type varchar(32) not null comment "task_submitted/task_approved/task_rejected/task_returned",' +
      '  source_app_code varchar(64) null,' +
      '  source_business_id varchar(128) null,' +
      '  task_id varchar(128) null,' +
      '  scene_code varchar(64) null,' +
      '  subject_code varchar(128) null,' +
      '  subject_name varchar(200) null,' +
      '  approval_conclusion varchar(16) null comment "agreed/disagreed/returned",' +
      '  template_version int null,' +
      '  submission_version int null,' +
      '  occurred_at datetime null,' +
      '  approved_at datetime null,' +
      '  payload json not null comment "事件原文",' +
      '  signature_key_id varchar(64) null,' +
      '  signature_key_version varchar(32) null,' +
      '  processed_result varchar(24) not null comment "applied/ignored/rejected/duplicate",' +
      '  processed_message varchar(500) null,' +
      '  ack_body varchar(500) null comment "本事件返回的 ACK 响应体，重复投递要返回同一个",' +
      '  received_at datetime not null default current_timestamp,' +
      '  key idx_be_task (task_id, received_at),' +
      '  key idx_be_source (source_business_id, received_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="回传业务事件（event_id 幂等）"'
  );

  // ---------- G4：审批轨迹（追加写） ----------
  await knex.raw(
    'create table if not exists approval_trace (' +
      '  id bigint primary key auto_increment,' +
      '  trace_id varchar(64) not null unique,' +
      '  complaint_id varchar(64) null,' +
      '  assignment_id varchar(64) null,' +
      '  task_id varchar(128) not null,' +
      '  event_id varchar(128) not null,' +
      '  event_type varchar(32) not null,' +
      '  approval_conclusion varchar(16) null,' +
      '  submission_version int null,' +
      '  actor_name varchar(64) null,' +
      '  occurred_at datetime not null,' +
      '  summary varchar(500) null,' +
      '  detail json null,' +
      '  created_at datetime not null default current_timestamp,' +
      '  key idx_at_task (task_id, occurred_at),' +
      '  key idx_at_complaint (complaint_id, occurred_at),' +
      '  key idx_at_assignment (assignment_id, occurred_at)' +
      ') engine=InnoDB default charset=utf8mb4 comment="签收/提交/退回/审批轨迹（追加写）"'
  );

  console.log('[M7] dispatch_request_log / business_event / approval_trace 就位');
};

exports.down = async (knex) => {
  await knex.raw('drop table if exists approval_trace');
  await knex.raw('drop table if exists business_event');
  await knex.raw('drop table if exists dispatch_request_log');
};
