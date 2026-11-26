exports.up = async function up(knex) {
  await knex.raw(`create table if not exists managed_platform_identity (
    issuer varchar(191) collate utf8mb4_bin not null,
    subject varchar(191) collate utf8mb4_bin not null,
    user_id varchar(64) collate utf8mb4_0900_ai_ci not null,
    from_legacy tinyint unsigned not null default 0,
    created_at timestamp not null default current_timestamp,
    primary key (issuer, subject),
    unique key uk_managed_platform_identity_user (user_id)
  ) default charset=utf8mb4`);
  await knex.raw(`create table if not exists platform_access_sync (
    app_id varchar(64) collate utf8mb4_bin not null primary key,
    last_sequence bigint unsigned not null
  ) default charset=utf8mb4`);
};

exports.down = async function down(knex) {
  if ((await knex('managed_platform_identity').first('user_id'))) {
    throw new Error('Cannot remove active identity management history');
  }
  await knex.schema.dropTableIfExists('platform_access_sync');
  await knex.schema.dropTableIfExists('managed_platform_identity');
};
