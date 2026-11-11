// Additive A6 indexes. The external audit table is preserved, never rebuilt.
const required=['id','audit_id','user_id','app_code','resource_code','action','biz_type','biz_id','result','client_ip','detail','created_at'];
const indexes=[
 ['idx_audit_query_time',['created_at','id']],
 ['idx_audit_query_actor',['user_id','created_at','id']],
 ['idx_audit_query_business',['biz_type','biz_id','created_at','id']],
 ['idx_audit_query_action',['action','created_at','id']],
];
exports.up=async knex=>{
 const [columns]=await knex.raw('select column_name, data_type, is_nullable from information_schema.columns where table_schema = database() and table_name = ?',['operation_audit_log']);
 for(const name of required)if(!columns.some(c=>c.COLUMN_NAME===name))throw new Error('A6 audit schema incompatible: missing operation_audit_log.'+name+'; inventory external baseline before migration');
 const id=columns.find(c=>c.COLUMN_NAME==='id');
 if(!['tinyint','smallint','mediumint','int','bigint'].includes(id.DATA_TYPE)||id.IS_NULLABLE!=='NO')throw new Error('A6 audit schema incompatible: id must be a non-null integer stable key');
 const [keys]=await knex.raw('select index_name from information_schema.statistics where table_schema = database() and table_name = ? and non_unique = 0 group by index_name having count(*) = 1 and max(column_name) = ?',['operation_audit_log','id']);
 if(!keys.length)throw new Error('A6 audit schema incompatible: id must have a single-column unique key; preserve and inventory historical primary keys');
 const created=columns.find(c=>c.COLUMN_NAME==='created_at');
 if(!['datetime','timestamp'].includes(created.DATA_TYPE))throw new Error('A6 audit schema incompatible: created_at must be DATETIME/TIMESTAMP');
 const [existing]=await knex.raw('show index from operation_audit_log');
 for(const [name,fields] of indexes){
  const found=existing.filter(r=>r.Key_name===name).sort((a,b)=>a.Seq_in_index-b.Seq_in_index);
  if(found.length){if(found.map(r=>r.Column_name).join(',')!==fields.join(','))throw new Error('A6 audit index incompatible: '+name);continue;}
  await knex.schema.alterTable('operation_audit_log',t=>t.index(fields,name));
 }
 // A5 already seeds system.audit.read. Never restore a deliberately revoked grant.
};
exports.down=async()=>{throw new Error('A6 audit evidence/index rollback requires explicit review; no automatic log mutation');};
