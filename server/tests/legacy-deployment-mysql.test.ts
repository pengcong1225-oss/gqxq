import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import knexFactory from 'knex';
const require=createRequire(import.meta.url);
const database='gqxq_legacy_deploy_test';
test('verified M13 legacy deployment compatibility', {skip:process.env.GQXQ_LEGACY_DEPLOY_DB!==database}, async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,database);
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database}});
 try {
  assert.equal((await db.raw('select database() as name'))[0][0].name,database);
  for(const table of ['report_artifact','report_job','report_scope_proof','statistics_snapshot','report_record','grid_enterprise','service_grid','enterprise'])await db.schema.dropTableIfExists(table);
  await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,district_code varchar(64) null) engine=InnoDB');
  await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_grid_enterprise(grid_code,enterprise_code)) engine=InnoDB');
  await db.raw('create table enterprise(id bigint auto_increment primary key,enterprise_code varchar(64) not null unique,business_type varchar(32) not null) engine=InnoDB');
  await db.raw("create table report_record(id bigint auto_increment primary key,report_id varchar(64) not null unique,report_type varchar(32) not null,report_title varchar(255) not null,preview_content longtext,date_from date,date_to date,template_version varchar(32) default 'V1') engine=InnoDB");
  await db('service_grid').insert({grid_code:'OLD-GRID',grid_name:'原网格'});
  await db('enterprise').insert({enterprise_code:'OLD-ENTERPRISE',business_type:'water'});
  await db('report_record').insert({report_id:'OLD-REPORT',report_type:'legacy',report_title:'原报告',preview_content:'原正文'});
  const legacyReport=await db('report_record').first();const enterprise=await db('enterprise').first();
  const bridge=require('../migrations/20261009085000__verified_legacy_baseline_compatibility.js');
  await t.test('unknown legacy relationships deny before any DDL',async()=>{
   await db('grid_enterprise').insert({grid_code:'OLD-GRID',enterprise_code:'OLD-ENTERPRISE'});
   await assert.rejects(()=>bridge.up(db),/explicit relationship reconciliation/);
   assert.equal(await db.schema.hasColumn('service_grid','business_type'),false);
   assert.equal((await db.raw('show columns from enterprise'))[0].find((c:any)=>c.Field==='business_type').Type,'varchar(32)');
   await db('grid_enterprise').delete();
  });
  await t.test('capacity upgrade preserves rows, identities and unknown grid type; rerun is idempotent',async()=>{
   await bridge.up(db);await bridge.up(db);
   assert.deepEqual(await db('enterprise').first(),enterprise);
   assert.deepEqual(await db('report_record').first(),legacyReport);
   assert.equal((await db('service_grid').first()).business_type,null);
   assert.equal((await db('grid_enterprise')).length,0);
  });
  await t.test('new report jobs supply required legacy identity without changing old reports',async()=>{
   const migration=require('../migrations/20261009170000__report_artifacts.js');
   await migration.ensureReportTables(db);await migration.ensureReportTables(db);
   const {insertReportJob}=await import('../src/repositories/reportRepo');
   const executor={query:async(sql:string,params:unknown[])=>db.raw(sql,params as any)};
   await insertReportJob(executor,'RPT-NEW','SNP-NEW','user','f'.repeat(64),{input:{query:{from:'2026-10-01',to:'2026-10-12'},requestId:'REQ-NEW',format:'docx'}} as any);
   const row=await db('report_record').where({d3_report_id:'RPT-NEW'}).first();
   assert.equal(row.report_id,'RPT-NEW');assert.equal(row.report_type,'statistics');
   assert.deepEqual(await db('report_record').where({id:legacyReport.id}).first(),{...legacyReport,d3_report_id:null});
   assert.equal((await db('report_job')).length,1);
  });
  await t.test('the new forward bridge also upgrades previously applied minimal D3 schemas',async()=>{
   await db.raw('alter table report_record drop index report_id, drop column report_id, drop column report_type');
   await bridge.up(db);await bridge.up(db);
   assert.equal(await db.schema.hasColumn('report_record','report_id'),true);
   assert.equal(await db.schema.hasColumn('report_record','report_type'),true);
   assert.equal((await db('report_record').where({id:legacyReport.id}).first()).preview_content,'原正文');
  });
 }finally{await db.destroy();}
});
