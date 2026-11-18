// 平台统一身份绑定：把住新工作服务平台签发的身份（issuer + subject）绑定到本地 app_user。
// 只做显式绑定，绝不按用户名/姓名自动合并账号。
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('platform_identity');
  if (!hasTable) {
    await knex.raw(
      'create table platform_identity (' +
      ' id bigint unsigned not null auto_increment primary key,' +
      ' issuer varchar(191) not null,' +
      ' subject varchar(191) not null,' +
      ' user_id varchar(64) not null,' +
      ' created_at datetime not null default current_timestamp,' +
      ' unique key uk_platform_identity (issuer, subject),' +
      ' key idx_platform_identity_user (user_id)' +
      ') engine=InnoDB default charset=utf8mb4 comment=\'平台统一身份绑定\''
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('drop table if exists platform_identity');
};
