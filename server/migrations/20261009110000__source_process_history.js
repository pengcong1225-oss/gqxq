// Additive source observations only; no refresh/backfill of existing complaints.
exports.up=async db=>{
 if(!await db.schema.hasTable('source_process_stream'))await db.raw(`create table source_process_stream (
  complaint_id varchar(64) not null primary key,source_system varchar(64) collate utf8mb4_bin not null,
  source_id varchar(128) collate utf8mb4_bin not null,version bigint unsigned not null,
  completed_cutoff_at datetime(3) null,state varchar(16) not null,error_code varchar(64) null,attempted_at datetime(3) not null
 ) engine=InnoDB default charset=utf8mb4`);
 if(!await db.schema.hasTable('source_process_revision'))await db.raw(`create table source_process_revision (
  id bigint unsigned auto_increment primary key,complaint_id varchar(64) not null,
  source_system varchar(64) collate utf8mb4_bin not null,source_id varchar(128) collate utf8mb4_bin not null,
  node_id varchar(128) collate utf8mb4_bin not null,revision bigint unsigned not null,
  source_sequence bigint unsigned null,source_version varchar(128) collate utf8mb4_bin null,occurred_at datetime(3) null,
  stage varchar(128) not null,department varchar(256) null,contact_name varchar(128) null,opinion mediumtext null,observed_at datetime(3) not null,
  unique key uk_source_process_revision(complaint_id,source_system,source_id,node_id,revision),
  index idx_source_process_history(complaint_id,id)
 ) engine=InnoDB default charset=utf8mb4`);
};
exports.down=async()=>{throw Error('Source process history rollback requires evidence-preserving restoration');};
