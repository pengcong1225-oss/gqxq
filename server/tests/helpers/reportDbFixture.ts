import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Knex} from 'knex';
const require=createRequire(import.meta.url);
/** Explicit relevant legacy fixture + REAL migrations, not canonical/M0 DDL. */
export async function prepareReportFixture(db:Knex){
 const [rows]=await db.raw('select database() as db');assert.equal(rows[0].db,'gqxq_d3_contract_test');
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_d3_contract_test');assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 for(const name of ['report_artifact','report_scope_proof','report_job','statistics_snapshot','report_record','heat_rule_published','heat_rule_draft','heat_rule_head','heat_policy_version','heat_policy_confirmation','service_grid_community','service_grid_admin','service_grid_revision','community','admin_grid','grid_enterprise','service_grid','enterprise_department_mapping','enterprise_household_version','enterprise_revision','enterprise','complaint_location_clue','complaint_address_candidate','sensitive_hit','report_todo','analysis_record','correction_item','dispatch_order','business_event','complaint_category_revision','dictionary_version','dictionary_code_registry','dict_type','dict_item','complaint_field_version','complaint_source_log','number_sequence','platform_role_permission','platform_permission','platform_role','platform_authorization_state','app_user','operation_audit_log','complaint'])await db.schema.dropTableIfExists(name);
  // Explicit synthetic pre-M2 base. Existing actual migrations own all added columns.
  await db.raw(`create table complaint(id bigint unsigned auto_increment primary key,complaint_id varchar(64) not null unique,complaint_no varchar(64),source_system varchar(64),source_id varchar(128),title varchar(256),content text,business_type varchar(64),complaint_type varchar(64),urgency_level varchar(64),status varchar(64),is_sensitive tinyint,sensitive_keywords varchar(500),district_code varchar(64),district_name varchar(128),address varchar(500),corrected_address varchar(500),location_lng decimal(12,6),location_lat decimal(12,6),correction_status varchar(64),enterprise_code varchar(64),enterprise_name varchar(128),grid_code varchar(64),sync_status varchar(64),received_at datetime,closed_at datetime,created_at datetime,updated_at datetime,deleted tinyint default 0) engine=InnoDB default charset=utf8mb4`);
  await db.raw('create table dict_type(id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dict_item(id bigint auto_increment primary key,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dispatch_order(id bigint auto_increment primary key,assignment_id varchar(64) unique,complaint_id varchar(64),active_complaint_id varchar(64) unique,status varchar(64),reporting_task_id varchar(64),created_at datetime) engine=InnoDB');
  await db.raw('create table business_event(event_id varchar(64),source_business_id varchar(64),task_id varchar(64),event_type varchar(64),payload json,id bigint auto_increment primary key) engine=InnoDB');
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  await db.raw('create table app_user(id bigint auto_increment primary key,user_id varchar(64) unique,username varchar(64) unique,password_hash varchar(100),real_name varchar(64),roles json,permissions json,status tinyint default 1) engine=InnoDB');
  await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,business_type varchar(64),district_code varchar(64)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_pair(grid_code,enterprise_code)) engine=InnoDB');
  await db.raw('create table enterprise(id bigint auto_increment primary key,enterprise_code varchar(64) unique,enterprise_name varchar(128),business_type varchar(64),status varchar(16)) engine=InnoDB');
  for(const file of ['20260917100100__m1_g1_new_tables.js','20260917100200__m2_complaint_g1_columns.js','20260917100400__m4_correction_confidence.js','20260917100800__m8_g5_correction_analysis_report.js','20260917101100__m11_complaint_overtime_flag.js','20260917101200__m12_address_candidate.js','20260924100000__m13_location_clues.js','20261009010000__effective_field_protection.js','20261009030000__account_role_permissions.js','20261009040000__user_object_scopes.js','20261009070000__dictionary_governance_categories.js','20261009080000__enterprise_management.js','20261009090000__service_grid_coverage.js','20261009100001__service_grid_registration.js','20261009120000__location_correction_group.js','20261009130000__account_identity_type.js'])await require('../../migrations/'+file).up(db);
  const migration=require('../../migrations/20261009150000__statistics_snapshots.js');await migration.up(db);

 for(const table of ['manual_followup_request','manual_followup_revision','manual_followup'])await db.schema.dropTableIfExists(table);
 await require('../../migrations/20261009130001__manual_complaint_followups.js').ensureFollowupTables(db);
 await require('../../migrations/20261009160000__heat_rules.js').up(db);
 // Minimal supported legacy report contract: existing auto numeric PK and
 // historically documented title/preview/date/template fields. No report_id
 // is guessed. Metadata preflight refuses other mandatory/no-default columns.
 await db.raw('create table report_record(id bigint auto_increment primary key,report_title varchar(255) not null,preview_content longtext null,date_from date null,date_to date null,template_version varchar(64) null) engine=InnoDB default charset=utf8mb4');
 await db('report_record').insert({report_title:'DECLARED LEGACY FIXTURE',preview_content:'Preserve me'});
}
