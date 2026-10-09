// B4 staging/preview/result only; master mutations retain B1-B3 version tables.
exports.up=async db=>{
 for(const [table,columns] of Object.entries({platform_role_permission:['role_code','permission_code'],platform_authorization_state:['id','version'],app_user:['user_id','scope_version','scope_rules']}))for(const column of columns)if(!await db.schema.hasColumn(table,column))throw Error('B4 requires '+table+'.'+column);
 const columns=['batch_id','owner_id','kind','file_hash','file_bytes','preview','details','scope_proofs','request_id','result','access_version','expires_at','created_at'];
 if(await db.schema.hasTable('master_data_import_batch'))for(const column of columns)if(!await db.schema.hasColumn('master_data_import_batch',column))throw Error('B4 incompatible staging table: '+column);
 if(await db.schema.hasTable('master_data_import_batch')){
  const [tables]=await db.raw('select engine from information_schema.tables where table_schema=database() and table_name=?',['master_data_import_batch']);if(tables[0]?.ENGINE!=='InnoDB')throw Error('B4 incompatible staging engine');
  const [actual]=await db.raw('select column_name,data_type,character_maximum_length,is_nullable from information_schema.columns where table_schema=database() and table_name=?',['master_data_import_batch']);
  const spec={batch_id:['varchar',64,false],owner_id:['varchar',64,false],kind:['varchar',32,false],file_hash:['char',64,false],file_bytes:['mediumblob',null,true],preview:['json',null,false],details:['json',null,false],scope_proofs:['json',null,false],request_id:['varchar',128,true],result:['json',null,true],access_version:['bigint',null,false],expires_at:['datetime',null,false],created_at:['datetime',null,false]};
  for(const [name,[type,length,nullable]] of Object.entries(spec)){const row=actual.find(r=>r.COLUMN_NAME===name);if(!row||row.DATA_TYPE!==type||length&&Number(row.CHARACTER_MAXIMUM_LENGTH)<length||row.IS_NULLABLE!==(nullable?'YES':'NO'))throw Error('B4 incompatible staging column: '+name);}
  const [indexes]=await db.raw('show index from master_data_import_batch');if(!indexes.some(r=>r.Key_name==='PRIMARY'&&r.Column_name==='batch_id'&&Number(r.Seq_in_index)===1))throw Error('B4 incompatible batch key');
 }

 if(!await db.schema.hasTable('master_data_import_batch'))await db.raw('create table master_data_import_batch(batch_id varchar(64) primary key,owner_id varchar(64) not null,kind varchar(32) not null,file_hash char(64) not null,file_bytes mediumblob null,preview json not null,details json not null,scope_proofs json not null,request_id varchar(128) null,result json null,access_version bigint unsigned not null,expires_at datetime not null,created_at datetime not null,index idx_b4_owner(owner_id,created_at),index idx_b4_expiry(expires_at)) engine=InnoDB default charset=utf8mb4');
};
exports.down=async()=>{throw Error('B4 batch/audit retention requires evidence-preserving restoration');};
