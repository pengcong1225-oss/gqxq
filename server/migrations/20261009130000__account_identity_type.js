// C3 account classification only. Historical accounts are unknown, never inferred.
exports.up=async db=>{
 const [tables]=await db.raw("select ENGINE from information_schema.tables where table_schema=database() and table_name='app_user'");
 if(tables[0]?.ENGINE!=='InnoDB')throw Error('C3 requires existing InnoDB app_user');
 for(const name of ['user_id','status','roles','scope_rules','scope_version'])if(!await db.schema.hasColumn('app_user',name))throw Error('C3 requires app_user.'+name);
 const [columns]=await db.raw("select DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE,COLUMN_DEFAULT from information_schema.columns where table_schema=database() and table_name='app_user' and column_name='account_type'");
 if(columns.length){const c=columns[0];if(c.DATA_TYPE!=='varchar'||Number(c.CHARACTER_MAXIMUM_LENGTH)<16||c.IS_NULLABLE!=='NO'||c.COLUMN_DEFAULT!=='unknown')throw Error('C3 incompatible account_type');
  if(await db('app_user').whereNotIn('account_type',['internal','enterprise','unknown']).first())throw Error('C3 incompatible account_type values');return;
 }
 await db.raw("alter table app_user add column account_type varchar(16) not null default 'unknown'");
};
exports.down=async()=>{throw Error('C3 identity rollback requires evidence-preserving restoration');};
