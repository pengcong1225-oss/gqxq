// Controlled adoption of the four formerly manual backend SQL upgrades.
// All existing structures are checked before any DDL. MySQL DDL is not transactional.
const fail = message => { throw Error('Backend consolidation: ' + message); };
const text = (length, nullable=false, collation=null) => ({type:`varchar(${length})`,nullable,collation});
const col = (type, nullable=false) => ({type,nullable});
const tender = {store_key:text(40),revision:col('bigint'),content:col('json'),updated_by:text(64),updated_at:col('datetime')};
const binding = {
 source_system:text(32),source_kind:text(16),source_id:text(64),business_type:text(16),enterprise_code:text(64),
 source_enterprise_id:text(128),source_subject_id:text(64,true),source_app_code:text(64,true),
 source_organization_code:text(128,true),gqxq_subject_code:text(64),source_revision:text(128),
 account_readiness:col('json'),source_payload:col('json'),updated_at:col('datetime(6)')
};
for(const spec of Object.values(binding))if(spec.type.startsWith('varchar'))spec.collation='utf8mb4_0900_ai_ci';
const additions = {
 enterprise:{display_on_screen:col('tinyint',true),screen_name:text(128,true)},
 service_grid:{manager_name:text(64,true),manager_phone:text(64,true)}
};
const definitions = {
 gqxq_tender_support_store:{columns:tender,keys:{PRIMARY:['store_key']}},
 gqxq_tender_support_history:{columns:tender,keys:{PRIMARY:['store_key','revision']}},
 pu_enterprise_binding:{columns:binding,keys:{PRIMARY:['source_system','source_kind','source_id','business_type'],uq_pu_enterprise_binding_enterprise:['enterprise_code']}}
};
const normalizedType = type => String(type).toLowerCase().replace(/^bigint\(20\)/,'bigint').replace(/^tinyint\(1\)/,'tinyint');
async function metadata(db,table){
 const [tables]=await db.raw('select ENGINE,TABLE_COLLATION from information_schema.tables where table_schema=database() and table_name=?',[table]);
 if(!tables.length)return null;
 if(tables[0].ENGINE!=='InnoDB')fail(table+' requires InnoDB');
 const [columns]=await db.raw('select COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME,CHARACTER_SET_NAME,COLUMN_DEFAULT,EXTRA from information_schema.columns where table_schema=database() and table_name=?',[table]);
 return {columns,collation:tables[0].TABLE_COLLATION};
}
function checkColumn(table,name,spec,actual,defaultCollation){
 const expectedCollation=spec.collation||defaultCollation;
 if(!actual||normalizedType(actual.COLUMN_TYPE)!==spec.type||actual.IS_NULLABLE!==(spec.nullable?'YES':'NO')||actual.COLUMN_DEFAULT!=null||actual.EXTRA||
   spec.type.startsWith('varchar')&&(actual.CHARACTER_SET_NAME!=='utf8mb4'||actual.COLLATION_NAME!==expectedCollation))
  fail(`incompatible column ${table}.${name}; expected ${JSON.stringify({...spec,collation:spec.type.startsWith('varchar')?expectedCollation:null})}; actual ${JSON.stringify(actual)}`);
}
async function checkKeys(db,table,expected){
 const [rows]=await db.raw('show index from ??',[table]);
 const indexes=new Map();
 for(const row of rows){const parts=indexes.get(row.Key_name)||[];parts.push(row);indexes.set(row.Key_name,parts);}
 for(const [name,columns] of Object.entries(expected)){
  const parts=(indexes.get(name)||[]).sort((a,b)=>a.Seq_in_index-b.Seq_in_index);
  if(parts.length!==columns.length||parts.some((r,i)=>r.Column_name!==columns[i]||Number(r.Non_unique)!==0||r.Sub_part!=null||r.Index_type!=='BTREE'))fail(`incompatible index ${table}.${name}`);
 }
 // Additional unique constraints can silently reject valid store/source keys.
 for(const [name,parts] of indexes)if(!expected[name]&&parts.some(r=>Number(r.Non_unique)===0))fail(`unexpected unique index ${table}.${name}`);
}
function sqlColumn(name,spec){return '`'+name+'` '+spec.type+(spec.collation?' character set utf8mb4 collate '+spec.collation:'')+(spec.nullable?' null default null':' not null');}
exports.up=async db=>{
 const plans=[];
 for(const [table,columns] of Object.entries(additions)){
  const meta=await metadata(db,table);if(!meta)fail('missing baseline table '+table);
  if(!/^utf8mb4_/.test(meta.collation))fail(table+' requires utf8mb4');
  for(const [name,spec] of Object.entries(columns)){
   const actual=meta.columns.find(c=>c.COLUMN_NAME===name);
   if(actual)checkColumn(table,name,spec,actual,meta.collation);
   else plans.push('alter table `'+table+'` add column '+sqlColumn(name,spec));
  }
 }
 const enterprise=await metadata(db,'enterprise');
 const enterpriseCode=enterprise.columns.find(c=>c.COLUMN_NAME==='enterprise_code');
 if(!enterpriseCode||normalizedType(enterpriseCode.COLUMN_TYPE)!=='varchar(64)'||enterpriseCode.CHARACTER_SET_NAME!=='utf8mb4'||enterpriseCode.COLLATION_NAME!=='utf8mb4_0900_ai_ci')fail('enterprise.enterprise_code requires varchar(64) utf8mb4_0900_ai_ci; reconcile explicitly before migration');
 for(const [table,definition] of Object.entries(definitions)){
  const meta=await metadata(db,table);
  if(meta){
   if(!/^utf8mb4_/.test(meta.collation)||table==='pu_enterprise_binding'&&meta.collation!=='utf8mb4_0900_ai_ci')fail('incompatible table collation '+table);
   if(meta.columns.length!==Object.keys(definition.columns).length)fail('unexpected column count '+table);
   for(const [name,spec] of Object.entries(definition.columns))checkColumn(table,name,spec,meta.columns.find(c=>c.COLUMN_NAME===name),meta.collation);
   await checkKeys(db,table,definition.keys);
   if(table==='pu_enterprise_binding'){
    const [refs]=await db.raw('select COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME from information_schema.key_column_usage where table_schema=database() and table_name=? and referenced_table_name is not null',[table]);
    if(refs.length!==1||refs[0].COLUMN_NAME!=='enterprise_code'||refs[0].REFERENCED_TABLE_NAME!=='enterprise'||refs[0].REFERENCED_COLUMN_NAME!=='enterprise_code')fail('incompatible foreign key pu_enterprise_binding.enterprise_code');
    const [rules]=await db.raw('select UPDATE_RULE,DELETE_RULE from information_schema.referential_constraints where constraint_schema=database() and table_name=?',[table]);
    if(rules.length!==1||![rules[0].UPDATE_RULE,rules[0].DELETE_RULE].every(rule=>['RESTRICT','NO ACTION'].includes(rule)))fail('incompatible foreign key actions pu_enterprise_binding.enterprise_code');
   }
  }else{
   const parts=Object.entries(definition.columns).map(([name,spec])=>sqlColumn(name,spec));
   for(const [name,columns] of Object.entries(definition.keys))parts.push((name==='PRIMARY'?'primary key':'unique key `'+name+'`')+' ('+columns.map(c=>'`'+c+'`').join(',')+')');
   if(table==='pu_enterprise_binding')parts.push('constraint fk_pu_enterprise_binding_enterprise foreign key(enterprise_code) references enterprise(enterprise_code)');
   plans.push('create table `'+table+'` ('+parts.join(',')+') engine=InnoDB default charset=utf8mb4'+(table==='pu_enterprise_binding'?' collate=utf8mb4_0900_ai_ci':''));
  }
 }
 for(const sql of plans)await db.raw(sql);
};
exports.down=async()=>{fail('restore only from reviewed backup; store/history/bindings and metadata must be retained');};
exports._test={checkColumn,checkKeys,normalizedType};
