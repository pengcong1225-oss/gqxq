// Declared component contract, NOT canonical external DDL. Preserve report_record
// id PK and all legacy rows. New opaque ID maps 1:1 to that same existing row.
const tables={
 statistics_snapshot:{columns:{snapshot_id:'varchar(64)',snapshot_bytes:'longblob',snapshot_hash:'char(64)',required_permissions:'json',proof_count:'int',created_at:'datetime'},keys:[['snapshot_id']],ddl:'snapshot_id varchar(64) primary key,snapshot_bytes longblob not null,snapshot_hash char(64) not null,required_permissions json not null,proof_count int not null,created_at datetime not null'},
 report_scope_proof:{columns:{snapshot_id:'varchar(64)',ordinal:'int',kind:'varchar(24)',object_key:'varchar(64)',enterprise_code:'varchar(64)',district_code:'varchar(64)',enterprise_any:'tinyint',district_any:'tinyint'},keys:[['snapshot_id','ordinal']],ddl:'snapshot_id varchar(64) not null,ordinal int not null,kind varchar(24) not null,object_key varchar(64) not null,enterprise_code varchar(64) null,district_code varchar(64) null,enterprise_any tinyint not null,district_any tinyint not null,primary key(snapshot_id,ordinal),key idx_rp_object(kind,object_key)'},
 report_job:{columns:{report_id:'varchar(64)',snapshot_id:'varchar(64)',creator_id:'varchar(64)',request_id:'varchar(64)',request_hash:'char(64)',execution_actor:'varchar(64)',format:'varchar(8)',state:'varchar(16)',fence:'bigint',owner_token:'varchar(64)',lease_until:'datetime',failure_reason:'varchar(64)',created_at:'datetime'},keys:[['report_id'],['creator_id','request_id'],['snapshot_id']],ddl:'report_id varchar(64) primary key,snapshot_id varchar(64) not null unique,creator_id varchar(64) not null,request_id varchar(64) not null,request_hash char(64) not null,execution_actor varchar(64) not null,format varchar(8) not null,state varchar(16) not null,fence bigint not null default 0,owner_token varchar(64) null,lease_until datetime(3) null,failure_reason varchar(64) null,created_at datetime(3) not null,unique key uk_report_request(creator_id,request_id),key idx_report_work(state,lease_until)'},
 report_artifact:{columns:{report_id:'varchar(64)',format:'varchar(8)',content_bytes:'longblob',content_hash:'char(64)',content_type:'varchar(128)',byte_length:'int'},keys:[['report_id']],ddl:'report_id varchar(64) primary key,format varchar(8) not null,content_bytes longblob not null,content_hash char(64) not null,content_type varchar(128) not null,byte_length int not null'}
};
async function columns(k,t){const [r]=await k.raw('show full columns from ??',[t]);return r;}
async function fullUnique(k,t,cols){const [rows]=await k.raw('show index from ??',[t]);const names=[...new Set(rows.filter(r=>Number(r.Non_unique)===0).map(r=>r.Key_name))];return names.some(n=>{const key=rows.filter(r=>r.Key_name===n).sort((a,b)=>a.Seq_in_index-b.Seq_in_index);return key.length===cols.length&&key.every((r,i)=>r.Column_name===cols[i]&&r.Sub_part==null);});}
async function insertUniqueContract(k,t,keys,supplied,cols){
 const [rows]=await k.raw('show index from ??',[t]);for(const name of new Set(rows.filter(r=>Number(r.Non_unique)===0).map(r=>r.Key_name))){
  const key=rows.filter(r=>r.Key_name===name);
  // A complete already-unique identity inside a composite unique is harmless.
  if(keys.some(expected=>expected.every(field=>key.some(r=>r.Column_name===field&&r.Sub_part==null))))continue;
  if(key.some(r=>{const c=cols.find(c=>c.Field===r.Column_name);return c&&!supplied.includes(c.Field)&&(String(c.Extra).includes('auto_increment')||c.Null==='YES'&&c.Default==null&&!String(c.Extra).includes('GENERATED'));}))continue;
  throw Error('D3 unsupported insert unique constraint '+t+'.'+name);
 }
}
function typeMatches(type,want){return String(type).toLowerCase().replace(/\(\d+\)(?= unsigned|$)/,'').replace(/ unsigned$/,'')===want||String(type).toLowerCase().startsWith(want+'(')||String(type).toLowerCase()===want;}
exports.up=async k=>{
 // Existing shared insert dependencies must also be supportable BEFORE DDL.
 const shared={platform_permission:{permission_code:'varchar(64)',name:'varchar(128)'},platform_role_permission:{role_code:'varchar(64)',permission_code:'varchar(64)'},operation_audit_log:{audit_id:'varchar(64)',user_id:'varchar(64)',app_code:'varchar(64)',resource_code:'varchar(128)',action:'varchar(64)',biz_type:'varchar(64)',biz_id:'varchar(128)',result:'varchar(32)',client_ip:'varchar(64)',detail:'json',created_at:'datetime'}};
 for(const [name,supplied] of Object.entries(shared)){
  if(!await k.schema.hasTable(name))throw Error('D3 required shared insert table '+name);const rows=await columns(k,name);
  for(const [field,type] of Object.entries(supplied)){const c=rows.find(r=>r.Field===field);if(!c||!typeMatches(c.Type,type)||String(c.Extra).includes('GENERATED'))throw Error('D3 unsupported shared insert '+name+'.'+field);}
  for(const c of rows)if(!Object.hasOwn(supplied,c.Field)&&c.Null==='NO'&&c.Default==null&&!String(c.Extra).includes('auto_increment')&&!String(c.Extra).includes('GENERATED'))throw Error('D3 extra mandatory shared column '+name+'.'+c.Field);
  const keys=name==='platform_permission'?[['permission_code']]:name==='platform_role_permission'?[['role_code','permission_code']]:[['audit_id']];await insertUniqueContract(k,name,keys,Object.keys(supplied),rows);
  if(name==='operation_audit_log'&&rows.find(c=>c.Field==='client_ip').Null!=='YES')throw Error('D3 audit client_ip must support explicit null');
 }
 if(!await fullUnique(k,'platform_permission',['permission_code'])||!await fullUnique(k,'platform_role_permission',['role_code','permission_code']))throw Error('D3 shared authorization identity missing');
 if(!await k.schema.hasTable('platform_authorization_state')||!await k.schema.hasTable('platform_role'))throw Error('D3 authorization baseline required');
 const state=await columns(k,'platform_authorization_state'),role=await columns(k,'platform_role');
 for(const [rows,fields] of [[state,{id:'int',version:'bigint'}],[role,{role_code:'varchar(64)',built_in:'tinyint'}]])for(const [field,type] of Object.entries(fields)){const c=rows.find(r=>r.Field===field);if(!c||!typeMatches(c.Type,type))throw Error('D3 authorization read dependency '+field);}
 if(!(await k('platform_authorization_state').where('id',1)).length||(await k('platform_permission').whereIn('permission_code',['report.read','report.download'])).length!==2)throw Error('D3 authorization seed prerequisite missing');
 if(!await k.schema.hasTable('report_record'))throw Error('D3 report_record required; canonical baseline is not supplied');
 const old=await columns(k,'report_record');
 for(const [name,type] of Object.entries({id:'bigint',report_title:'varchar(255)',preview_content:'longtext',date_from:'date',date_to:'date',template_version:'varchar(64)'})){
  const c=old.find(c=>c.Field===name);if(!c||!typeMatches(c.Type,type))throw Error('D3 unsupported legacy report_record column '+name);
 }
 if(!old.find(c=>c.Field==='id'&&c.Key==='PRI'&&String(c.Extra).includes('auto_increment'))||!await fullUnique(k,'report_record',['id']))throw Error('D3 requires full existing auto id primary key');
 const supplied=['report_title','preview_content','date_from','date_to','template_version','d3_report_id'];
 await insertUniqueContract(k,'report_record',[['id'],['d3_report_id']],supplied,old);
 for(const c of old)if(c.Null==='NO'&&c.Default==null&&!String(c.Extra).includes('auto_increment')&&!String(c.Extra).includes('GENERATED')&&!supplied.includes(c.Field))throw Error('D3 cannot supply extra mandatory legacy column '+c.Field);
 const ext=old.find(c=>c.Field==='d3_report_id');if(ext&&(!typeMatches(ext.Type,'varchar(64)')||ext.Null!=='YES'||!await fullUnique(k,'report_record',['d3_report_id'])))throw Error('D3 incompatible existing report identity');
 if(!await k.schema.hasTable('report_todo')||!(await columns(k,'report_todo')).some(c=>c.Field==='report_id'&&typeMatches(c.Type,'varchar(64)')))throw Error('D3 report_todo linkage contract missing');
 // ALL owned-table compatibility checks precede the first DDL.
 for(const [name,spec] of Object.entries(tables))if(await k.schema.hasTable(name)){
  const nullable=name==='report_scope_proof'?['enterprise_code','district_code']:name==='report_job'?['owner_token','lease_until','failure_reason']:[];
  const rows=await columns(k,name);for(const [field,type] of Object.entries(spec.columns)){const c=rows.find(r=>r.Field===field);if(!c||!typeMatches(c.Type,type))throw Error('D3 incompatible '+name+'.'+field);if(c.Null!==(nullable.includes(field)?'YES':'NO'))throw Error('D3 incompatible nullability '+name+'.'+field);if(String(c.Extra).includes('GENERATED')||String(c.Extra).includes('auto_increment'))throw Error('D3 incompatible generated column '+name+'.'+field);}
  if(name==='report_job'&&String(rows.find(r=>r.Field==='fence').Default)!=='0')throw Error('D3 incompatible fence default');
  for(const key of spec.keys)if(!await fullUnique(k,name,key))throw Error('D3 requires full unique '+name+'.'+key.join(','));
  await insertUniqueContract(k,name,spec.keys,Object.keys(spec.columns),rows);
  for(const c of rows)if(!Object.hasOwn(spec.columns,c.Field)&&c.Null==='NO'&&c.Default==null&&!String(c.Extra).includes('auto_increment'))throw Error('D3 extra mandatory column '+name+'.'+c.Field);
 }
 if(!ext)await k.raw('alter table report_record add column d3_report_id varchar(64) null, add unique key uk_d3_report_id(d3_report_id)');
 for(const [name,spec] of Object.entries(tables))if(!await k.schema.hasTable(name))await k.raw('create table ?? ('+spec.ddl+') engine=InnoDB default charset=utf8mb4',[name]);
 await k.transaction(async tx=>{
  await tx.raw('select version from platform_authorization_state where id=1 for update');
  const [existing]=await tx.raw("select permission_code from platform_permission where permission_code='report.retry'");
  if(existing.length)return; // Once-only seed: revoked existing grants are not restored.
  await tx.raw("insert into platform_permission(permission_code,name) values('report.retry','报告重试')");
  await tx.raw("insert ignore into platform_role_permission(role_code,permission_code) select r.role_code,'report.download' from platform_role r join platform_role_permission p on p.role_code=r.role_code and p.permission_code='report.read' where r.built_in=1");
  await tx.raw("insert ignore into platform_role_permission(role_code,permission_code) select role_code,'report.retry' from platform_role where role_code='admin' and built_in=1");
  await tx.raw('update platform_authorization_state set version=version+1 where id=1');
 });
};
exports.down=async()=>{throw Error('D3 rollback requires explicit data-preserving operator plan');};
