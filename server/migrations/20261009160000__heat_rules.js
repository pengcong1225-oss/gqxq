// D2 global configuration. No confirmed policy or production rule is seeded.
const tables=[
 ['heat_rule_head','category_key varchar(129) not null primary key',{category_key:['varchar',129,'NO']},[['category_key']]],
 ['heat_rule_draft','rule_id varchar(64) not null primary key,category_key varchar(129) not null,edit_version bigint unsigned not null,content json not null,unique key uq_heat_draft_category(category_key)',{rule_id:['varchar',64,'NO'],category_key:['varchar',129,'NO'],edit_version:['bigint',null,'NO'],content:['json',null,'NO']},[['rule_id'],['category_key']]],
 ['heat_policy_version','policy_id varchar(64) not null,policy_version bigint unsigned not null,fingerprint char(64) not null,content json not null,primary key(policy_id,policy_version)',{policy_id:['varchar',64,'NO'],policy_version:['bigint',null,'NO'],fingerprint:['char',64,'NO'],content:['json',null,'NO']},[['policy_id','policy_version']]],
 ['heat_policy_confirmation','policy_id varchar(64) not null,policy_version bigint unsigned not null,fingerprint char(64) not null,truth_table json not null,evidence_ref varchar(500) not null,confirmed_by varchar(64) not null,confirmed_at datetime not null,primary key(policy_id,policy_version)',{policy_id:['varchar',64,'NO'],policy_version:['bigint',null,'NO'],fingerprint:['char',64,'NO'],truth_table:['json',null,'NO'],evidence_ref:['varchar',500,'NO'],confirmed_by:['varchar',64,'NO'],confirmed_at:['datetime',null,'NO']},[['policy_id','policy_version']]],
 ['heat_rule_published','version_id varchar(64) not null primary key,category_key varchar(129) not null,effective_from date not null,content json not null,published_by varchar(64) not null,published_at datetime not null,unique key uq_heat_start(category_key,effective_from)',{version_id:['varchar',64,'NO'],category_key:['varchar',129,'NO'],effective_from:['date',null,'NO'],content:['json',null,'NO'],published_by:['varchar',64,'NO'],published_at:['datetime',null,'NO']},[['version_id'],['category_key','effective_from']]]
];
exports.up=async db=>{
 for(const table of ['platform_permission','platform_role','platform_role_permission','platform_authorization_state']){const [r]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);if(r[0]?.ENGINE!=='InnoDB')throw Error('D2 requires existing InnoDB '+table);}
 const state=await db('platform_authorization_state').where('id',1).first();if(!state)throw Error('D2 requires A5 singleton');
 for(const [name,,columns,keys] of tables){
  const [engine]=await db.raw('select ENGINE,TABLE_COLLATION from information_schema.tables where table_schema=database() and table_name=?',[name]);if(!engine.length)continue;
  if(engine[0].ENGINE!=='InnoDB'||engine[0].TABLE_COLLATION!=='utf8mb4_unicode_ci')throw Error('D2 incompatible table '+name);
  const [actual]=await db.raw('select COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE from information_schema.columns where table_schema=database() and table_name=?',[name]);
  if(actual.length!==Object.keys(columns).length)throw Error('D2 incompatible owned columns '+name);
  for(const c of actual){const expected=columns[c.COLUMN_NAME];if(!expected||c.DATA_TYPE!==expected[0]||expected[1]!==null&&Number(c.CHARACTER_MAXIMUM_LENGTH)!==expected[1]||c.IS_NULLABLE!==expected[2]||c.DATA_TYPE==='bigint'&&!c.COLUMN_TYPE.includes('unsigned'))throw Error('D2 incompatible '+name+'.'+c.COLUMN_NAME);}
  const [idx]=await db.raw('show index from ??',[name]);const groups=new Map();for(const i of idx){if(Number(i.Non_unique)===0){const g=groups.get(i.Key_name)||[];g.push(i);groups.set(i.Key_name,g);}}
  for(const key of keys)if(![...groups.values()].some(g=>g.length===key.length&&g.sort((a,b)=>a.Seq_in_index-b.Seq_in_index).every((i,n)=>i.Column_name===key[n]&&i.Sub_part===null)))throw Error('D2 requires full unique '+name+'.'+key.join(','));
 }
 const [marker]=await db.raw("select DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT from information_schema.columns where table_schema=database() and table_name='platform_authorization_state' and column_name='heat_d2_seeded'");
 if(marker.length&&(marker[0].DATA_TYPE!=='tinyint'||marker[0].IS_NULLABLE!=='NO'||String(marker[0].COLUMN_DEFAULT)!=='0'))throw Error('D2 incompatible heat_d2_seeded');
 for(const [name,ddl] of tables)if(!await db.schema.hasTable(name))await db.raw('create table ?? ('+ddl+') engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci',[name]);
 if(!marker.length)await db.raw('alter table platform_authorization_state add column heat_d2_seeded tinyint not null default 0');
 await db.transaction(async tx=>{
  const locked=await tx('platform_authorization_state').where('id',1).forUpdate().first();
  await tx('platform_permission').insert({permission_code:'heatmap.manage',name:'热力草稿与规则发布（另需政策确认）'}).onConflict('permission_code').ignore();
  if(Number(locked.heat_d2_seeded)!==0)return;
  const admin=await tx('platform_role').where({role_code:'admin',built_in:1}).first();if(admin){await tx('platform_role_permission').insert({role_code:'admin',permission_code:'heatmap.manage'}).onConflict(['role_code','permission_code']).ignore();await tx('platform_role').where('role_code','admin').increment('version',1);}
  await tx('platform_authorization_state').where('id',1).update({heat_d2_seeded:1,version:Number(locked.version)+1});
 });
};
exports.down=async()=>{throw Error('D2 published history/confirmation requires evidence-preserving restoration');};
