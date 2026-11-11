const contracts={complaint:['complaint_id','complaint_no','enterprise_code','district_code','deleted','source_payload'],app_user:['user_id','account_type','status','scope_rules','scope_version'],operation_audit_log:['audit_id','action','biz_type','biz_id','detail'],platform_role:['role_code','built_in','version'],platform_permission:['permission_code','name'],platform_role_permission:['role_code','permission_code'],platform_authorization_state:['id','version']};
const specs={
 manual_followup:{id:['bigint',null,false],followup_id:['varchar',64,false],complaint_id:['varchar',64,false],owner_id:['varchar',64,false],current_version:['bigint',null,false],created_at:['datetime',null,false]},
 manual_followup_revision:{followup_id:['varchar',64,false],version:['bigint',null,false],contacted:['tinyint',null,false],occurred_at:['datetime',null,false],evaluation_code:['varchar',32,true],dissatisfaction_reason:['varchar',500,true],notes:['varchar',2000,true],conclusion:['varchar',1000,true],concluded_by:['varchar',64,true],concluded_at:['datetime',null,true],action:['varchar',16,false],operator_id:['varchar',64,false],operator_name:['varchar',64,false],reason:['varchar',500,true],revised_at:['datetime',null,false]},
 manual_followup_request:{owner_id:['varchar',64,false],complaint_id:['varchar',64,false],operation:['varchar',16,false],request_id:['varchar',128,false],payload_hash:['char',64,false],followup_id:['varchar',64,false],result_version:['bigint',null,false]}
};
const keys={manual_followup:[['id'],['followup_id']],manual_followup_revision:[['followup_id','version']],manual_followup_request:[['owner_id','complaint_id','operation','request_id']]};
exports.ensureFollowupTables=async db=>{
 for(const [table,spec] of Object.entries(specs))if(await db.schema.hasTable(table)){
  const [tables]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);if(tables[0]?.ENGINE!=='InnoDB')throw Error('C3 incompatible engine '+table);
  const [cols]=await db.raw('select COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE,COLLATION_NAME,EXTRA,DATETIME_PRECISION from information_schema.columns where table_schema=database() and table_name=?',[table]);
  for(const [name,[type,length,nullable]] of Object.entries(spec)){const c=cols.find(c=>c.COLUMN_NAME===name);if(!c||c.DATA_TYPE!==type||length&&Number(c.CHARACTER_MAXIMUM_LENGTH)<length||c.IS_NULLABLE!==(nullable?'YES':'NO')||type==='datetime'&&Number(c.DATETIME_PRECISION)<3||['followup_id','complaint_id','owner_id','request_id','operation'].includes(name)&&!String(c.COLLATION_NAME).endsWith('_bin')||table==='manual_followup'&&name==='id'&&!String(c.EXTRA).includes('auto_increment'))throw Error('C3 incompatible column '+table+'.'+name);}
  const [indexes]=await db.raw('show index from ??',[table]);const unique=new Map();for(const row of indexes)if(Number(row.Non_unique)===0){const parts=unique.get(row.Key_name)||[];parts[Number(row.Seq_in_index)-1]=row.Sub_part===null?row.Column_name:null;unique.set(row.Key_name,parts);}
  for(const key of keys[table])if(![...unique.values()].some(parts=>JSON.stringify(parts)===JSON.stringify(key)))throw Error('C3 incompatible key '+table);
 }
 if(!await db.schema.hasTable('manual_followup'))await db.raw('create table manual_followup(id bigint unsigned auto_increment primary key,followup_id varchar(64) not null unique,complaint_id varchar(64) not null,owner_id varchar(64) not null,current_version bigint unsigned not null,created_at datetime(3) not null,index idx_followup_complaint(complaint_id,id)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin');
 if(!await db.schema.hasTable('manual_followup_revision'))await db.raw('create table manual_followup_revision(followup_id varchar(64) not null,version bigint unsigned not null,contacted tinyint not null,occurred_at datetime(3) not null,evaluation_code varchar(32) null,dissatisfaction_reason varchar(500) null,notes varchar(2000) null,conclusion varchar(1000) null,concluded_by varchar(64) null,concluded_at datetime(3) null,action varchar(16) not null,operator_id varchar(64) not null,operator_name varchar(64) not null,reason varchar(500) null,revised_at datetime(3) not null,primary key(followup_id,version)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin');
 if(!await db.schema.hasTable('manual_followup_request'))await db.raw('create table manual_followup_request(owner_id varchar(64) not null,complaint_id varchar(64) not null,operation varchar(16) not null,request_id varchar(128) not null,payload_hash char(64) not null,followup_id varchar(64) not null,result_version bigint unsigned not null,primary key(owner_id,complaint_id,operation,request_id)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin');
};
exports.seedFollowupCapabilities=async db=>{
 for(const table of ['platform_role','platform_permission','platform_role_permission','platform_authorization_state']){ const [rows]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);if(rows[0]?.ENGINE!=='InnoDB')throw Error('C3 requires InnoDB '+table);for(const name of contracts[table])if(!await db.schema.hasColumn(table,name))throw Error('C3 requires '+table+'.'+name);}
 await db.transaction(async tx=>{
  await tx.raw('select version from platform_authorization_state where id=1 for update');const changed=new Set();
  for(const [code,name,roles] of [['followup.create','人工回访登记及本人更正',['admin','handler']],['followup.conclude','主管独立回访结论',['admin']]]){
   // Permission registration and initial grants are one atomic once-only seed.
   if(await tx('platform_permission').where('permission_code',code).first())continue;
   await tx('platform_permission').insert({permission_code:code,name});
   for(const role of roles)if(await tx('platform_role').where({role_code:role,built_in:1}).first()){await tx('platform_role_permission').insert({role_code:role,permission_code:code});changed.add(role);}
  }
  for(const role of changed)await tx('platform_role').where('role_code',role).increment('version',1);
  if(changed.size)await tx('platform_authorization_state').where('id',1).increment('version',1);
 });
};
exports.up=async db=>{
 // Full preflight before first DDL/seed, including already-created extension tables.
 for(const [table,names] of Object.entries(contracts)){
  const [tables]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);if(tables[0]?.ENGINE!=='InnoDB')throw Error('C3 requires InnoDB '+table);
  for(const name of names)if(!await db.schema.hasColumn(table,name))throw Error('C3 requires '+table+'.'+name);
 }
 await exports.ensureFollowupTables(db);
 await exports.seedFollowupCapabilities(db);
};
exports.down=async()=>{throw Error('C3 followup rollback must preserve audit/history/idempotency');};
