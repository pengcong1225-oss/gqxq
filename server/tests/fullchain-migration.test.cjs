const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const knex=require('knex');
test('complete migration chain from DDL-only external baseline',{skip:process.env.GQXQ_ISOLATED_MIGRATION_TEST!=='1'},async()=>{
 const connection={host:'127.0.0.1',port:13317,user:'root',password:''};
 const admin=knex({client:'mysql2',connection,pool:{min:0,max:1}});let db;
 try{
  const [[server]]=await admin.raw('select @@port as port,@@datadir as datadir');assert.equal(Number(server.port),13317);assert.match(String(server.datadir).replaceAll('\\','/'),/gqxq-merge-mysql-20261111\/data\/$/);
  const database='gqxq_merge_fullchain_'+process.pid+'_test';await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);
  db=knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1},migrations:{directory:path.join(__dirname,'../migrations'),tableName:'knex_migrations',disableTransactions:true}});
  const fixture=fs.readFileSync(path.join(__dirname,'fixtures/external-baseline-ddl.sql'),'utf8');assert.doesNotMatch(fixture,/\b(?:insert\s+into|use\s+\w|create\s+database)\b/i);await db.raw(fixture);
  const [,completed]=await db.migrate.latest();assert.equal(completed.length,fs.readdirSync(path.join(__dirname,'../migrations')).filter(f=>f.endsWith('.js')).length);
  const before=await db('platform_authorization_state').where('id',1).first();const [,again]=await db.migrate.latest();assert.deepEqual(again,[]);assert.deepEqual(await db('platform_authorization_state').where('id',1).first(),before);
  for(const [table,column] of [['enterprise','display_on_screen'],['enterprise','screen_name'],['service_grid','manager_phone'],['complaint','source_deadline_at'],['source_process_stream','ingress_version'],['source_process_revision','contact_phone'],['source_business_head','followup_binding']])assert.equal(await db.schema.hasColumn(table,column),true,table+'.'+column);
  for(const table of ['gqxq_tender_support_store','gqxq_tender_support_history','pu_enterprise_binding'])assert.equal(await db.schema.hasTable(table),true);
  const permissions=await db('platform_role_permission').where('permission_code','like','followup.%').orderBy(['role_code','permission_code']);assert.deepEqual(permissions.map(r=>[r.role_code,r.permission_code]),[['admin','followup.conclude'],['admin','followup.create'],['handler','followup.create']]);
  assert.equal(Number((await db('complaint').count('* as n').first()).n),0);
  console.log('FULL CHAIN VERIFIED',database,'migrations',completed.length,'second run',again.length);
 }finally{if(db)await db.destroy();await admin.destroy();}
});
