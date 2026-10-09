// Explicit legacy grants, once only. New accounts always default to no data scope.
exports.up = async knex => {
 const fresh=!(await knex.schema.hasColumn('app_user','scope_rules'));
 if(fresh)await knex.raw('alter table app_user add column scope_rules json null, add column scope_version bigint unsigned not null default 1, add column scope_provenance varchar(64) not null default ?',['new-account-deny']);
 if(fresh)await knex.transaction(async tx=>{
  await tx.raw('select version from platform_authorization_state where id = 1 for update');
  await tx('app_user').where('status',1).update({scope_rules:JSON.stringify([{kind:'all'}]),scope_provenance:'legacy-all-bootstrap-20261009'});
  await tx('platform_authorization_state').where('id',1).increment('version',1);
 });
};
exports.down=async()=>{throw new Error('Scope rollback requires evidence-preserving restoration');};
