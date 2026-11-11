const tables=['complaint','number_sequence','complaint_source_log','complaint_field_version','operation_audit_log','sensitive_hit','complaint_address_candidate','complaint_location_clue','app_user','platform_authorization_state','platform_role','platform_role_permission'];
exports.up=async knex=>{
 for(const table of tables){const [rows]=await knex.raw('select engine from information_schema.tables where table_schema=database() and table_name=?',[table]);if(rows.length!==1||String(rows[0].ENGINE??rows[0].engine).toLowerCase()!=='innodb')throw Error('Complaint import requires InnoDB: '+table);}
 // An exact source pair unique key is required for safe repeat/concurrent imports.
 const [sourceColumns]=await knex.raw("select column_name,collation_name from information_schema.columns where table_schema=database() and table_name='complaint' and column_name in ('source_system','source_id')");
 if(sourceColumns.length!==2||sourceColumns.some(c=>!/_ci$/i.test(String(c.COLLATION_NAME??c.collation_name))))throw Error('Complaint import requires case-insensitive source keys; no automatic collation change');
 const [keys]=await knex.raw('show index from complaint');
 const groups=new Map();for(const k of keys){const a=groups.get(k.Key_name)||[];a.push(k);groups.set(k.Key_name,a);}
 if(![...groups.values()].some(a=>a.length===2&&a.every(k=>Number(k.Non_unique)===0&&k.Sub_part===null)&&a.sort((x,y)=>x.Seq_in_index-y.Seq_in_index).map(k=>k.Column_name).join(',')==='source_system,source_id'))throw Error('Exact unique complaint source key required');
 if(!await knex.schema.hasTable('complaint_import_batch'))await knex.schema.createTable('complaint_import_batch',t=>{
  t.engine('InnoDB');t.string('batch_id',64).primary();t.string('owner_id',64).notNullable();t.string('file_name',200).notNullable();t.string('file_hash',64).notNullable();t.json('preview').notNullable();t.json('details').nullable();t.json('plan_rows').nullable();t.string('request_id',64).nullable();t.json('result').nullable();t.dateTime('created_at').notNullable();t.dateTime('expires_at').notNullable();t.index(['owner_id','created_at']);t.index(['expires_at']);
 });
 const columns=await knex('information_schema.columns').whereRaw('table_schema=database()').where('table_name','complaint_import_batch');
 for(const name of ['batch_id','owner_id','file_name','file_hash','preview','details','plan_rows','request_id','result','created_at','expires_at'])if(!columns.some(c=>c.COLUMN_NAME===name))throw Error('Incompatible complaint import table: '+name);
 const [batchEngine]=await knex.raw('select engine from information_schema.tables where table_schema=database() and table_name=?',['complaint_import_batch']);if(String(batchEngine[0].ENGINE??batchEngine[0].engine).toLowerCase()!=='innodb')throw Error('Complaint import batch must be transactional');
 await knex.transaction(async tx=>{
  await tx('platform_authorization_state').where('id',1).forUpdate().first();
  await tx('platform_permission').insert({permission_code:'complaint.import',name:'诉求 Excel 导入（另需诉求查询及全域范围）'}).onConflict('permission_code').ignore();
  const admin=await tx('platform_role').where({role_code:'admin',built_in:1}).first();
  if(admin&&!await tx('platform_role_permission').where({role_code:'admin',permission_code:'complaint.import'}).first()){
   await tx('platform_role_permission').insert({role_code:'admin',permission_code:'complaint.import'});await tx('platform_role').where('role_code','admin').increment('version',1);await tx('platform_authorization_state').where('id',1).increment('version',1);
  }
 });
};
exports.down=async()=>{throw Error('Preserve complaint import evidence; rollback requires explicit restoration');};
