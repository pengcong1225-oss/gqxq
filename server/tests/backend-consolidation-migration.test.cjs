const test=require('node:test');
const assert=require('node:assert/strict');
const knex=require('knex');
const schema=require('../migrations/20261111090000__backend_schema_consolidation');
const grants=require('../migrations/20261111090100__followup_admin_permission_repair');
const delivery=require('../migrations/20261111090200__source_delivery_fields');
const snapshot=require('../migrations/20261111090300__dispatch_snapshot_key_compatibility');
const fs=require('node:fs');
const path=require('node:path');
const enabled=process.env.GQXQ_ISOLATED_MIGRATION_TEST==='1';
// Deliberately no dotenv or application connection defaults. This suite can only
// connect to the explicitly provisioned disposable loopback instance.
test('manual SQL consolidation on isolated MySQL 8', {skip:!enabled}, async()=>{
 const connection={host:'127.0.0.1',port:13317,user:'root',password:''};
 const admin=knex({client:'mysql2',connection,pool:{min:0,max:1}});
 let db;
 try{
  const [[server]]=await admin.raw('select @@port as port,@@datadir as datadir');
  assert.equal(Number(server.port),13317);
  assert.match(String(server.datadir).replaceAll('\\','/'),/gqxq-merge-mysql-20261111\/data\/$/);
  const database='gqxq_merge_migrations_'+process.pid+'_test';
  await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);
  db=knex({client:'mysql2',connection:{...connection,database},pool:{min:0,max:1}});
  await db.raw('create table enterprise(enterprise_code varchar(64) not null primary key) engine=InnoDB');
  await db.raw('create table service_grid(grid_code varchar(64) not null primary key) engine=InnoDB');
  for(const table of ['complaint','source_process_stream','source_process_revision','source_business_head','source_business_revision'])await db.raw('create table ??(id int primary key) engine=InnoDB',[table]);
  // Adopt exact historical manual scripts, including PREPARE/EXECUTE, before
  // migration; these scripts are local tracked schema, never production data.
  const manual=knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1}});
  try{for(const file of ['tender-support-schema.sql','backend-masterdata-schema.sql','pu-enterprise-schema.sql'])await manual.raw(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));}finally{await manual.destroy();}
  await schema.up(db);await delivery.up(db);
  await db('enterprise').insert({enterprise_code:'SYNTHETIC',display_on_screen:null,screen_name:null});
  const payload=JSON.stringify({synthetic:true});
  await db('gqxq_tender_support_store').insert({store_key:'synthetic',revision:7,content:payload,updated_by:'test',updated_at:'2026-11-11 00:00:00'});
  await schema.up(db);await delivery.up(db);
  assert.equal((await db('gqxq_tender_support_store').first()).revision,7);
  // Manual SQL-created shape is the same checked shape: repeat must preserve it.
  await db.raw('alter table enterprise modify screen_name varchar(127) null');
  await assert.rejects(schema.up(db),/enterprise.screen_name/);
  await db.raw('alter table enterprise modify screen_name varchar(128) null');
  await db.raw('alter table pu_enterprise_binding drop index uq_pu_enterprise_binding_enterprise, add index uq_pu_enterprise_binding_enterprise(enterprise_code)');
  await assert.rejects(schema.up(db),/incompatible index/);
  await db.raw('alter table pu_enterprise_binding drop index uq_pu_enterprise_binding_enterprise, add unique index uq_pu_enterprise_binding_enterprise(enterprise_code)');
  await db.raw('alter table gqxq_tender_support_history modify store_key varchar(40) character set utf8mb4 collate utf8mb4_bin not null');
  await assert.rejects(schema.up(db),/store_key/);
  await db.raw('alter table gqxq_tender_support_history modify store_key varchar(40) character set utf8mb4 collate utf8mb4_0900_ai_ci not null');
  await db.raw('alter table source_process_stream modify ingress_version bigint null');
  await assert.rejects(delivery.up(db),/ingress_version/);
  await db.raw('alter table source_process_stream modify ingress_version bigint unsigned null');
  await db.raw('create table platform_role(role_code varchar(64) primary key,built_in tinyint not null,version bigint not null) engine=InnoDB');
  await db.raw('create table platform_permission(permission_code varchar(64) primary key) engine=InnoDB');
  await db.raw('create table platform_role_permission(role_code varchar(64),permission_code varchar(64),primary key(role_code,permission_code)) engine=InnoDB');
  await db.raw('create table platform_authorization_state(id int primary key,version bigint not null) engine=InnoDB');
  await db('platform_role').insert([{role_code:'admin',built_in:1,version:3},{role_code:'handler',built_in:1,version:8},{role_code:'custom',built_in:0,version:4}]);
  await db('platform_authorization_state').insert({id:1,version:11});
  await db('platform_permission').insert([{permission_code:'followup.create'},{permission_code:'followup.conclude'}]);
  await db('platform_role_permission').insert([{role_code:'handler',permission_code:'followup.create'},{role_code:'custom',permission_code:'followup.conclude'}]);
  await grants.up(db);
  const permissions=await db('platform_role_permission').orderBy(['role_code','permission_code']);
  assert.equal(permissions.length,4);assert.equal((await db('platform_authorization_state').first()).version,12);
  assert.equal((await db('platform_role').where('role_code','admin').first()).version,4);
  await grants.up(db);
  assert.deepEqual(await db('platform_role_permission').orderBy(['role_code','permission_code']),permissions);
  assert.equal((await db('platform_authorization_state').first()).version,12);
  await db('platform_role_permission').where('role_code','admin').del();
  await db('platform_role').where('role_code','admin').update({built_in:0});
  await grants.up(db);assert.equal((await db('platform_authorization_state').first()).version,12);
  assert.equal((await db('platform_role_permission').where('role_code','admin')).length,0);
  await db.raw('create table dispatch_order(assignment_id varchar(64),request_id varchar(128)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_0900_ai_ci');
  await db.raw('create table dispatch_push_snapshot(assignment_id varchar(64),request_id varchar(128)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin');
  await snapshot.up(db);await snapshot.up(db);
  const [keys]=await db.raw('show full columns from dispatch_push_snapshot');
  assert.ok(keys.every(k=>k.Collation==='utf8mb4_0900_ai_ci'));
  await db.raw('alter table dispatch_push_snapshot modify request_id varchar(64)');
  await assert.rejects(snapshot.up(db),/request_id/);
  // Exercise initially absent tables too, after the adopted data assertions.
  for(const table of ['pu_enterprise_binding','gqxq_tender_support_history','gqxq_tender_support_store'])await db.schema.dropTable(table);
  await schema.up(db);await schema.up(db);
  console.log('Verified disposable schema:',database);
 }finally{if(db)await db.destroy();await admin.destroy();}
});
test('column normalization preserves unsigned and rejects generated fields',()=>{
 assert.equal(schema._test.normalizedType('bigint(20) unsigned'),'bigint unsigned');
 assert.throws(()=>schema._test.checkColumn('x','y',{type:'json',nullable:true},{COLUMN_TYPE:'json',IS_NULLABLE:'YES',COLUMN_DEFAULT:null,EXTRA:'VIRTUAL GENERATED'},null),/x.y/);
});
