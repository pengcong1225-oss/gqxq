async function tableExists(knex, tableName) {
  const [rows] = await knex.raw(
    'select 1 from information_schema.tables where table_schema = database() and table_name = ? limit 1',
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(knex, tableName, columnName) {
  const [rows] = await knex.raw(
    'select 1 from information_schema.columns where table_schema = database() and table_name = ? and column_name = ? limit 1',
    [tableName, columnName]
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await tableExists(knex, 'complaint_location_clue'))) {
    await knex.raw(
      'create table complaint_location_clue (' +
        'id bigint unsigned not null auto_increment primary key,' +
        'complaint_id varchar(64) not null,' +
        "clue_kind varchar(16) not null comment 'township or settlement'," +
        'clue_value varchar(500) not null,' +
        'evidence_text varchar(500) not null,' +
        "source_field varchar(16) not null comment 'title or content'," +
        'source_start int unsigned not null,' +
        'source_end int unsigned not null,' +
        'township_code char(9) null,' +
        'district_code char(6) null,' +
        'parent_match varchar(32) not null,' +
        'extractor_version varchar(32) not null,' +
        'snapshot_id varchar(64) not null,' +
        'input_hash char(64) not null,' +
        'created_at timestamp not null default current_timestamp,' +
        'key ix_complaint_location_clue_complaint (complaint_id,id)' +
      ') engine=InnoDB default charset=utf8mb4'
    );
  }

  if (!(await columnExists(knex, 'complaint_address_candidate', 'district_code'))) {
    await knex.raw('alter table complaint_address_candidate add column district_code char(6) null');
  }
  if (!(await columnExists(knex, 'complaint_address_candidate', 'parent_match'))) {
    await knex.raw('alter table complaint_address_candidate add column parent_match varchar(32) null');
  }
  if (!(await columnExists(knex, 'complaint_address_candidate', 'snapshot_id'))) {
    await knex.raw('alter table complaint_address_candidate add column snapshot_id varchar(64) null');
  }
};

exports.down = async (knex) => {
  if (await tableExists(knex, 'complaint_location_clue')) {
    await knex.raw('drop table complaint_location_clue');
  }
  if (await columnExists(knex, 'complaint_address_candidate', 'snapshot_id')) {
    await knex.raw('alter table complaint_address_candidate drop column snapshot_id');
  }
  if (await columnExists(knex, 'complaint_address_candidate', 'parent_match')) {
    await knex.raw('alter table complaint_address_candidate drop column parent_match');
  }
  if (await columnExists(knex, 'complaint_address_candidate', 'district_code')) {
    await knex.raw('alter table complaint_address_candidate drop column district_code');
  }
};
