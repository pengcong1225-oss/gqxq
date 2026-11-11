-- DDL-only synthetic baseline extracted from zhuxin-platform Flyway V1 + V8.
-- No V3 reference seeds, demo accounts, credentials, or business rows.


create table if not exists complaint (
  id bigint primary key auto_increment,
  complaint_id varchar(64) not null unique,
  complaint_no varchar(64) not null unique,
  source_system varchar(64),
  source_id varchar(128),
  title varchar(255) not null,
  content text,
  business_type varchar(32) not null,
  complaint_type varchar(32) not null,
  urgency_level varchar(32) not null,
  status varchar(32) not null default 'pending',
  is_sensitive tinyint not null default 0,
  sensitive_keywords varchar(500),
  district_code varchar(64),
  district_name varchar(128),
  address varchar(500),
  corrected_address varchar(500),
  location_lng decimal(12,8),
  location_lat decimal(12,8),
  correction_status varchar(32) default 'none',
  enterprise_code varchar(64),
  enterprise_name varchar(255),
  grid_code varchar(64),
  sync_status varchar(32) default 'not_synced',
  received_at datetime,
  closed_at datetime,
  created_at datetime default current_timestamp,
  updated_at datetime default current_timestamp on update current_timestamp,
  deleted tinyint default 0,
  unique key uk_source (source_system, source_id),
  key idx_status (status),
  key idx_sensitive (is_sensitive)
) engine=InnoDB default charset=utf8mb4 comment='诉求主表';

create table if not exists complaint_rule_result (
  id bigint primary key auto_increment,
  complaint_id varchar(64) not null,
  matched_rules json,
  extracted_entities json,
  confidence decimal(5,2),
  created_at datetime default current_timestamp,
  key idx_complaint (complaint_id)
) engine=InnoDB default charset=utf8mb4 comment='规则预处理结果';

create table if not exists address_correction (
  id bigint primary key auto_increment,
  correction_id varchar(64) not null unique,
  complaint_id varchar(64) not null,
  raw_address varchar(500),
  corrected_address varchar(500),
  corrected_lng decimal(12,8),
  corrected_lat decimal(12,8),
  confidence decimal(5,2),
  status varchar(32) not null,
  operator_id varchar(64),
  corrected_at datetime,
  created_at datetime default current_timestamp,
  key idx_correction_complaint (complaint_id),
  key idx_correction_status (status)
) engine=InnoDB default charset=utf8mb4 comment='地址纠偏';

create table if not exists dispatch_order (
  id bigint primary key auto_increment,
  assignment_id varchar(64) not null unique,
  order_no varchar(64) not null unique,
  complaint_id varchar(64) not null,
  complaint_title varchar(255),
  dispatch_type varchar(32),
  trigger_type varchar(64),
  sensitive_words varchar(500),
  target_enterprise_code varchar(64),
  target_enterprise_name varchar(255),
  status varchar(32) not null default 'pending',
  sync_status varchar(32) default 'not_synced',
  external_status varchar(32) default 'pending',
  deadline datetime,
  pushed_at datetime,
  completed_at datetime,
  archived_at datetime,
  result_content text,
  created_at datetime default current_timestamp,
  updated_at datetime default current_timestamp on update current_timestamp,
  key idx_dispatch_complaint (complaint_id),
  key idx_dispatch_status (status)
) engine=InnoDB default charset=utf8mb4 comment='交办单';

create table if not exists dispatch_archive (
  id bigint primary key auto_increment,
  archive_id varchar(64) not null unique,
  assignment_id varchar(64) not null,
  complaint_id varchar(64),
  result_content text,
  archived_by varchar(64),
  archived_at datetime default current_timestamp
) engine=InnoDB default charset=utf8mb4 comment='交办归档';

create table if not exists enterprise (
  id bigint primary key auto_increment,
  enterprise_code varchar(64) not null unique,
  enterprise_name varchar(255) not null,
  business_type varchar(32) not null,
  uscc varchar(64),
  legal_person varchar(64),
  contact_person varchar(64),
  contact_phone varchar(64),
  service_area varchar(1000),
  annual_score decimal(5,2),
  status varchar(32) default 'enabled'
) engine=InnoDB default charset=utf8mb4 comment='企业';

create table if not exists enterprise_certificate (
  id bigint primary key auto_increment,
  certificate_id varchar(64) not null unique,
  enterprise_code varchar(64) not null,
  cert_name varchar(255) not null,
  cert_no varchar(128),
  issue_date date,
  expiry_date date,
  file_url varchar(500),
  status varchar(32) default 'valid'
) engine=InnoDB default charset=utf8mb4 comment='企业资质';

create table if not exists service_grid (
  id bigint primary key auto_increment,
  grid_code varchar(64) not null unique,
  grid_name varchar(128) not null,
  gov_grid_code varchar(64),
  district_code varchar(64),
  district_name varchar(128),
  manager_id varchar(64),
  manager_name varchar(64),
  overlap_rate decimal(5,2),
  status varchar(32) default 'enabled'
) engine=InnoDB default charset=utf8mb4 comment='服务网格';

create table if not exists grid_enterprise (
  id bigint primary key auto_increment,
  grid_code varchar(64) not null,
  enterprise_code varchar(64) not null,
  unique key uk_grid_enterprise (grid_code, enterprise_code)
) engine=InnoDB default charset=utf8mb4 comment='网格企业绑定';

create table if not exists shutdown_application (
  id bigint primary key auto_increment,
  shutdown_id varchar(64) not null unique,
  app_no varchar(64) not null unique,
  enterprise_code varchar(64),
  enterprise_name varchar(255),
  business_type varchar(32) not null,
  shutdown_type varchar(32) not null,
  affected_area varchar(1000),
  affected_households int,
  planned_start_time datetime,
  planned_end_time datetime,
  status varchar(32) not null default 'draft'
) engine=InnoDB default charset=utf8mb4 comment='停供申请';

create table if not exists pipeline_project (
  id bigint primary key auto_increment,
  project_id varchar(64) not null unique,
  project_no varchar(64) not null unique,
  project_name varchar(255) not null,
  enterprise_code varchar(64),
  enterprise_name varchar(255),
  business_type varchar(32),
  pipeline_length decimal(12,2),
  budget decimal(16,2),
  progress decimal(5,2),
  status varchar(32) default 'pending'
) engine=InnoDB default charset=utf8mb4 comment='管道施工';

create table if not exists report_record (
  id bigint primary key auto_increment,
  report_id varchar(64) not null unique,
  report_title varchar(255) not null,
  report_type varchar(32) not null,
  status varchar(32) default 'generating',
  preview_content longtext,
  word_file_url varchar(500),
  excel_file_url varchar(500),
  pdf_file_url varchar(500),
  created_at datetime default current_timestamp
) engine=InnoDB default charset=utf8mb4 comment='报告';

create table if not exists dict_type (
  id bigint primary key auto_increment,
  dict_type varchar(64) not null unique,
  dict_name varchar(128) not null,
  status varchar(32) default 'enabled'
) engine=InnoDB default charset=utf8mb4 comment='字典类型';

create table if not exists dict_item (
  id bigint primary key auto_increment,
  item_id varchar(64) not null unique,
  dict_type varchar(64) not null,
  item_value varchar(128) not null,
  item_label varchar(128) not null,
  status varchar(32) default 'enabled',
  unique key uk_dict_item (dict_type, item_value)
) engine=InnoDB default charset=utf8mb4 comment='字典项';

create table if not exists attachment (
  id bigint primary key auto_increment,
  attachment_id varchar(64) not null unique,
  biz_type varchar(64) not null,
  biz_id varchar(64) not null,
  file_name varchar(255) not null,
  file_url varchar(500) not null,
  uploaded_at datetime default current_timestamp,
  key idx_attachment_biz (biz_type, biz_id)
) engine=InnoDB default charset=utf8mb4 comment='附件';

create table if not exists process_log (
  id bigint primary key auto_increment,
  process_log_id varchar(64) not null unique,
  biz_type varchar(64) not null,
  biz_id varchar(64) not null,
  complaint_id varchar(64),
  action varchar(64) not null,
  content text,
  created_at datetime default current_timestamp,
  key idx_process_biz (biz_type, biz_id)
) engine=InnoDB default charset=utf8mb4 comment='业务过程日志';

create table if not exists sync_log (
  id bigint primary key auto_increment,
  sync_log_id varchar(64) not null unique,
  app_code varchar(64) not null,
  target_system varchar(64) not null,
  biz_type varchar(64) not null,
  biz_id varchar(64) not null,
  result varchar(32) not null,
  request_body longtext,
  response_body longtext,
  retry_count int default 0,
  error_message varchar(2000),
  created_at datetime default current_timestamp,
  key idx_sync_biz (biz_type, biz_id)
) engine=InnoDB default charset=utf8mb4 comment='同步日志';

create table if not exists operation_audit_log (
  id bigint primary key auto_increment,
  audit_id varchar(64) not null unique,
  user_id varchar(64),
  app_code varchar(64),
  resource_code varchar(128),
  action varchar(64) not null,
  biz_type varchar(64),
  biz_id varchar(128),
  result varchar(32) not null,
  client_ip varchar(64),
  detail text,
  created_at datetime default current_timestamp,
  key idx_audit_biz (biz_type, biz_id),
  key idx_audit_created (created_at)
) engine=InnoDB default charset=utf8mb4 comment='平台审计日志';

create table if not exists legacy_migration_map (
  id bigint primary key auto_increment,
  legacy_system varchar(64) not null,
  legacy_table varchar(128) not null,
  legacy_id varchar(128) not null,
  new_table varchar(128) not null,
  new_id varchar(128) not null,
  migrated_at datetime default current_timestamp,
  unique key uk_legacy_map (legacy_system, legacy_table, legacy_id)
) engine=InnoDB default charset=utf8mb4 comment='老数据迁移映射';

-- V8: Seed missing data (complaints, dispatch orders) + report table enhancements

-- Report table columns (added manually; ensure they exist)
alter table report_record add column date_from date;
alter table report_record add column date_to date;
alter table report_record add column template_version varchar(32) default 'V1';
