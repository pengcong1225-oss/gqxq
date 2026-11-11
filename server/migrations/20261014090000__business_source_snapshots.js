// Versioned external facts. No synthetic business rows or source credentials are seeded.
exports.up=async db=>{
 await db.raw(`create table if not exists source_business_head (
 event_id char(64) primary key, source_id varchar(64) not null, kind varchar(16) not null,
 source_object_id varchar(128) not null, source_version bigint unsigned not null,
 enterprise_code varchar(64), district_code varchar(64), payload_hash char(64) not null,
 content json not null, received_at datetime(3) not null,
 unique key uq_source_object(source_id,kind,source_object_id), key ix_event_scope(kind,enterprise_code,district_code)
 ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin`);
 await db.raw(`create table if not exists source_business_revision (
 event_id char(64) not null, source_version bigint unsigned not null, payload_hash char(64) not null,
 content json not null, received_at datetime(3) not null, primary key(event_id,source_version)
 ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin`);
};
exports.down=async()=>{throw Error('External source history must be retained; restore from an audited backup');};
