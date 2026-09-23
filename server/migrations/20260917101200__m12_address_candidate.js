exports.up = async (knex) => {
  await knex.raw(
    'create table complaint_address_candidate (' +
      'id bigint unsigned not null auto_increment primary key,' +
      'complaint_id varchar(64) not null,' +
      'candidate_text varchar(500) not null,' +
      'evidence_text varchar(500) not null,' +
      'source_field varchar(16) not null,' +
      'extractor_version varchar(32) not null,' +
      'input_hash char(64) not null,' +
      'created_at timestamp not null default current_timestamp,' +
      'updated_at timestamp not null default current_timestamp on update current_timestamp,' +
      'unique key uq_complaint_address_candidate_complaint (complaint_id)' +
    ') engine=InnoDB default charset=utf8mb4'
  );
};

exports.down = async (knex) => {
  await knex.raw('drop table complaint_address_candidate');
};
