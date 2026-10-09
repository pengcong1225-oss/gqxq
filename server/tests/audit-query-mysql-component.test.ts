import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {prepareGridAuditFixture} from './helpers/gridAuditFixture';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_A6_COMPONENT_DB==='gqxq_a6_contract_test';
test('A6 isolated MySQL audit query component, not canonical baseline or restart acceptance',{skip:!enabled},async t=>{
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_a6_contract_test');assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_a6_contract_test',timezone:'+08:00'}});
 let closePool:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_a6_contract_test');
  // Only the explicitly owned synthetic schema is reset. No M0/full-schema claim.
  for(const table of ['correction_item','complaint_field_version','business_event','analysis_record','dispatch_order','complaint','platform_role_permission','platform_permission','platform_role','platform_authorization_state','operation_audit_log','a6_saved_audit','app_user','number_sequence'])await db.schema.dropTableIfExists(table);
  await db.raw("create table app_user (id bigint primary key auto_increment,user_id varchar(64) not null unique,username varchar(64) not null unique,password_hash varchar(100) not null,real_name varchar(64) not null,roles json not null,permissions json not null,status tinyint not null default 1,last_login_at datetime,created_at datetime not null default current_timestamp,updated_at datetime not null default current_timestamp on update current_timestamp) engine=InnoDB default charset=utf8mb4");
  await db.raw('create table operation_audit_log (id bigint auto_increment primary key,audit_id varchar(64) unique,user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  await db.raw('create table number_sequence (seq_key varchar(64),biz_date date,current_value bigint default 0,primary key(seq_key,biz_date)) engine=InnoDB');
  await require('../migrations/20261009030000__account_role_permissions.js').up(db);
  await require('../migrations/20261009040000__user_object_scopes.js').up(db);
  const migration='../migrations/20261009050000__audit_query_indexes.js';if(existsSync(new URL(migration,import.meta.url)))await require(migration).up(db);
  const {COMPLAINT_COLUMNS}=await import('../src/repositories/complaintMapper');
  const columns=[...new Set(COMPLAINT_COLUMNS.split(', ').map(c=>c.slice(2)).concat(['deleted']))];
  const json=new Set(['source_payload','source_fields','effective_field_state']);const nums=new Set(['edit_version','deleted','is_sensitive','closed_in_system','analysis_included','overtime_flag']);
  await db.raw('create table complaint ('+columns.map(c=>c==='id'?'id bigint auto_increment primary key':c==='complaint_id'?'complaint_id varchar(64) unique':json.has(c)?c+' json':nums.has(c)?c+' bigint default '+(c==='edit_version'?1:0):c.endsWith('_at')?c+' datetime':c+' text').join(',')+') engine=InnoDB');
  await db.raw('create table dispatch_order (id bigint auto_increment primary key,assignment_id varchar(64) unique,complaint_id varchar(64),reporting_task_id varchar(128)) engine=InnoDB');
  await db.raw('create table analysis_record (id bigint auto_increment primary key,analysis_id varchar(64) unique,complaint_id varchar(64)) engine=InnoDB');
  await db.raw('create table business_event (id bigint auto_increment primary key,event_id varchar(128) unique,source_business_id varchar(128)) engine=InnoDB');
  await db.raw('create table correction_item (id bigint primary key auto_increment,correction_id varchar(64) unique,complaint_id varchar(64),assignment_id varchar(64),field_name varchar(64),field_label varchar(64),old_value text,new_value text,basis text,status varchar(32),confirmer_id varchar(64),confirmer_name varchar(64),confirmed_at datetime,created_at datetime) engine=InnoDB');
  await db.raw('create table complaint_field_version (id bigint primary key auto_increment,version_id varchar(64),complaint_id varchar(64),field_name varchar(64),old_value text,new_value text,change_source varchar(64),reason text,operator_id varchar(64),operator_name varchar(64),changed_at datetime) engine=InnoDB');
  await prepareGridAuditFixture(db);
  for(const [id,role,rules] of [['admin','admin',[]],['scoped','auditor',[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['G1']}]],['scoped2','auditor',[{kind:'restricted',enterpriseCodes:['E2'],districtCodes:['G2']}]],['all','auditor',[{kind:'all'}]],['denied','handler',[{kind:'all'}]]] as const)
   await db('app_user').insert({user_id:id,username:id,password_hash:await bcrypt.hash('Synthetic-Pass-1',4),real_name:'虚构',roles:JSON.stringify([role]),permissions:'[]',scope_rules:JSON.stringify(rules),session_version:1,must_change_password:0});
  await db('platform_role').insert({role_code:'auditor',name:'虚构审计员',enabled:1,built_in:0,version:1});
  await db('platform_role_permission').insert({role_code:'auditor',permission_code:'system.audit.read'});
  for(const [id,e,g,deleted] of [['C1','E1','G1',0],['C2','E2','G2',0],['DEL','E1','G1',1]])await db('complaint').insert({complaint_id:id,complaint_no:'NO-'+id,title:'RAW_CONTENT_SECRET',content:'RAW_CONTENT_SECRET',enterprise_code:e,district_code:g,deleted,edit_version:1,effective_field_state:'{}',address:'旧地址'});
  await db('dispatch_order').insert({assignment_id:'D2',complaint_id:'C2',reporting_task_id:'T2'});
  await db('analysis_record').insert({analysis_id:'ANA1',complaint_id:'C1'});await db('analysis_record').insert({analysis_id:'ANA2',complaint_id:'C2'});
  await db('business_event').insert([{event_id:'EV1',source_business_id:'C1'},{event_id:'EV2',source_business_id:'C2'}]);
  const stamp=new Date('2026-10-09T00:00:00Z');
  const rows=[
   ['LOGIN1','auth','scoped','LOGIN','success'],['LOGIN2','auth','ghost-user','LOGIN_FAILED','failure'],
   ['USER1','user','target','USER_UPDATE','success'],['ROLE1','role','auditor','ROLE_UPDATE','success'],
   ['DICT1','sensitive_word','word','SENSITIVE_WORD_UPDATE','success'],['RESCAN','sensitive_word','RESCAN_SECRET','SENSITIVE_WORD_RESCAN','success'],
   ['SEC','http','GET /complaints/FOREIGN_SECRET?token=TOKEN_SECRET','ACCESS_DENIED','rejected'],
   ['C1A','complaint','C1','CORRECTION_CONFIRM','success'],['C1B','complaint','C1','SOURCE_DOCUMENT_READ','success'],
   ['C2A','complaint','C2','CORRECTION_CONFIRM','success'],['DELETED','complaint','DEL','CORRECTION_CONFIRM','success'],
   ['D2A','dispatch_order','C2','DISPATCH_PUSH','failed'],['D2B','dispatch_order','C2','DISPATCH_CREATE','success'],
   ['ANA1A','analysis_record','ANA1','ANALYSIS_INCLUDED','success'],['ANA2A','analysis_record','ANA2','ANALYSIS_INCLUDED','success'],
   ['EV1A','business_event','EV1','CALLBACK_REJECTED','rejected'],['EV2A','business_event','EV2','CALLBACK_REJECTED','rejected'],
   ['EV1B','business_event','C1','CALLBACK_DUPLICATE','duplicate'],['UNRESOLVED','business_event','UNKNOWN','CALLBACK_REJECTED','rejected'],
   ['UNKNOWN','mystery','C1','UNKNOWN_ACTION','success'],['REPORT','report','UNKNOWN','REPORT_GENERATE','success'],
  ];
  for(const [id,type,biz,action,result] of rows)await db('operation_audit_log').insert({audit_id:id,user_id:id==='LOGIN2'?null:'scoped',app_code:'gqxq',resource_code:'resource',action,biz_type:type,biz_id:biz,result,created_at:stamp,detail:JSON.stringify({username:biz,reason:'bad_password',requestId:'req-1',path:'/complaints/FOREIGN_SECRET',total:900,updated:400,before:{roles:['handler'],password:'TOKEN_SECRET'},after:{roles:['auditor'],token:'TOKEN_SECRET'},fieldName:'disposal_result',oldValue:'{"result":"旧","signature":"SIGNATURE_SECRET"}',newValue:'{"result":"新","payload":"RAW_CONTENT_SECRET"}',password:'PASSWORD_SECRET',token:'TOKEN_SECRET',sourcePayload:'RAW_CONTENT_SECRET'})});
  const {createApp}=await import('../src/app');const poolModule=await import('../src/db/pool');closePool=poolModule.closePool;
  const app=createApp();const token=(id:string)=>jwt.sign({sub:id,username:id,sessionVersion:1},process.env.GQXQ_JWT_SECRET!);
  const api=(method:string,path:string,user='scoped',body?:unknown)=>{const q=(request(app) as any)[method]('/api/v1'+path).set('Authorization','Bearer '+token(user));return body===undefined?q:q.send(body);};
  await t.test('actual SQL stable equal-time pagination, scope count/detail and unknown fail closed',async()=>{
   const first=await api('get','/audit-logs?size=3&page=1');assert.equal(first.status,200);assert.equal(first.body.data.total,12);
   const ids:string[]=[];for(let page=1;page<=4;page++){const r=await api('get','/audit-logs?size=3&page='+page);assert.equal(r.body.data.total,12);ids.push(...r.body.data.content.map((v:any)=>v.auditId));}
   assert.equal(new Set(ids).size,12);assert.deepEqual(ids,['EV1B','EV1A','ANA1A','C1B','C1A','SEC','RESCAN','DICT1','ROLE1','USER1','LOGIN2','LOGIN1']);
   for(const id of ids){const r=await api('get','/audit-logs/'+id);assert.equal(r.status,200,id);assert.equal(r.body.data.auditId,id);assert.equal(JSON.stringify(r.body).includes('SECRET'),false,id);}
   for(const id of ['C2A','D2A','D2B','ANA2A','EV2A','DELETED','UNKNOWN','UNRESOLVED','REPORT'])assert.equal((await api('get','/audit-logs/'+id)).status,404,id);
   const count=await api('get','/audit-logs?businessNo=NO-C1');assert.equal(count.body.data.total,5);assert.equal((await api('get','/audit-logs?businessNo=NO-C2')).body.data.total,0);
   await db('complaint').where('complaint_id','C1').update({district_code:'G2'});assert.equal((await api('get','/audit-logs/C1A')).status,404);assert.equal((await api('get','/audit-logs')).body.data.total,7);
   await db('complaint').where('complaint_id','C1').update({district_code:'G1'});
  });
  await t.test('system events are available without object scopes; all still redacts secrets',async()=>{
   assert.equal((await api('get','/audit-logs','admin')).body.data.total,7);assert.equal((await api('get','/audit-logs/C1A','admin')).status,404);
   const all=await api('get','/audit-logs','all');assert.equal(all.body.data.total,17);assert.equal(JSON.stringify(all.body).includes('SECRET'),false);
   assert.equal((await api('get','/audit-logs?category=login&result=failed')).body.data.total,1);
   assert.equal((await api('get','/audit-logs?category=login&actor=ghost-user')).body.data.total,1,'failed unknown login remains discoverable by entered username');
   assert.equal((await api('get','/audit-logs?module=corrections&action=CORRECTION_CONFIRM')).body.data.total,1);
   assert.equal((await api('get','/audit-logs?from=2026-10-09T00%3A00%3A00Z&to=2026-10-09T00%3A00%3A00Z')).body.data.total,12);
   for(const q of ['page=0','size=101','from=bad','category=unknown'])assert.equal((await api('get','/audit-logs?'+q)).status,400,q);
   assert.equal((await api('get','/audit-logs?businessNo=FOREIGN_SECRET')).body.data.total,0);
   for(const key of ['target','auditor','word'])assert.equal((await api('get','/audit-logs?businessNo='+key)).body.data.total,1,'public system business key '+key);
   assert.equal((await api('get','/audit-logs?businessNo=RESCAN_SECRET')).body.data.total,0,'rescan key stays withheld');
  });
  const collisionActor='collision-actor';
  const seedCollision=async(rows:string[][])=>{
   for(const [id,type,biz,action] of rows)await db('operation_audit_log').insert({audit_id:id,user_id:collisionActor,app_code:'gqxq',biz_type:type,biz_id:biz,action,result:'rejected',created_at:stamp,detail:JSON.stringify({eventId:'EV1',complaintId:'C1',assignmentId:'C1',marker:'UNCHANGED_COLLISION_SECRET'})});
  };
  const assertCollisionViews=async(rows:string[][],visible:string[][])=>{
   for(const [user,complaint,expected] of [['scoped','C1',visible[0]],['scoped2','C2',visible[1]]] as const){
    for(const business of ['',complaint,'NO-'+complaint]){
     const q=await api('get','/audit-logs?actor='+collisionActor+(business?'&businessNo='+business:''),user);assert.equal(q.status,200);
     assert.equal(q.body.data.total,expected.length,user+' count '+business);assert.deepEqual(q.body.data.content.map((v:any)=>v.auditId).sort(),[...expected].sort(),user+' rows '+business);
     assert.ok(q.body.data.content.every((v:any)=>v.businessNo==='NO-'+complaint));
    }
    const foreign=complaint==='C1'?'C2':'C1';for(const business of [foreign,'NO-'+foreign])assert.equal((await api('get','/audit-logs?actor='+collisionActor+'&businessNo='+business,user)).body.data.total,0,user+' foreign business '+business);
    for(const [id] of rows){const q=await api('get','/audit-logs/'+id,user);assert.equal(q.status,expected.includes(id)?200:404,user+' direct '+id);}
   }
   for(const [id] of rows){const stored=await db('operation_audit_log').where('audit_id',id).first();assert.ok(JSON.stringify(stored.detail).includes('UNCHANGED_COLLISION_SECRET'),'read projection must preserve original audit evidence');}
  };
  await t.test('callback complaint-key actions never rebind to colliding event IDs; rejected uses only event keys',async()=>{
   const rows=[['COL-DUP','business_event','C1','CALLBACK_DUPLICATE'],['COL-IGN','business_event','C1','CALLBACK_IGNORED'],['COL-REJ','business_event','C1','CALLBACK_REJECTED'],['COL-DUP2','business_event','C2','CALLBACK_DUPLICATE'],['COL-REJ1','business_event','EV1','CALLBACK_REJECTED'],['COL-WRONG-DUP','business_event','EV1','CALLBACK_DUPLICATE']];
   await db('business_event').insert({event_id:'C1',source_business_id:'C2'});await seedCollision(rows);
   try{await assertCollisionViews(rows,[['COL-DUP','COL-IGN','COL-REJ1'],['COL-REJ','COL-DUP2']]);}
   finally{await db('operation_audit_log').where('user_id',collisionActor).delete();await db('business_event').where('event_id','C1').delete();}
  });
  await t.test('unparsed callback headers and intake source IDs cannot become complaint keys by collision',async()=>{
   const rows=[['COL-AUTH','business_event','C1','CALLBACK_AUTH_FAILED'],['COL-AUTH-EVENT','business_event','EV1','CALLBACK_AUTH_FAILED'],['COL-CONFIG','business_event','C1','CALLBACK_CONFIG_ERROR'],['COL-REJ-MISSING','business_event','C1','CALLBACK_REJECTED'],['COL-INTAKE','complaint','C1','INTAKE_REJECTED'],['COL-UNKNOWN','complaint','C1','UNKNOWN_ACTION']];
   assert.equal((await db('business_event').where('event_id','C1')).length,0);await seedCollision(rows);
   try{await assertCollisionViews(rows,[[],[]]);for(const [id] of rows)assert.equal((await api('get','/audit-logs/'+id,'all')).status,404,id+' unresolved even for all');}
   finally{await db('operation_audit_log').where('user_id',collisionActor).delete();}
  });
  await t.test('dispatch complaint keys ignore colliding assignment IDs and exclude guessed assignment semantics',async()=>{
   const rows=[['COL-CREATE','dispatch_order','C1','DISPATCH_CREATE'],['COL-PUSH','dispatch_order','C1','DISPATCH_PUSH'],['COL-CALLBACK','dispatch_order','C1','CALLBACK_APPLIED'],['COL-CREATE2','dispatch_order','C2','DISPATCH_CREATE'],['COL-WRONG-DISPATCH','dispatch_order','D2','DISPATCH_PUSH'],['COL-UNKNOWN-DISPATCH','dispatch_order','C1','UNKNOWN_ACTION']];
   await db('dispatch_order').insert({assignment_id:'C1',complaint_id:'C2'});await seedCollision(rows);
   try{await assertCollisionViews(rows,[['COL-CREATE','COL-PUSH','COL-CALLBACK'],['COL-CREATE2']]);}
   finally{await db('operation_audit_log').where('user_id',collisionActor).delete();await db('dispatch_order').where('assignment_id','C1').delete();}
  });
  await t.test('unauthorized direct APIs deny and persisted revocation takes effect on existing token',async()=>{
   for(const path of ['/audit-logs','/audit-logs/USER1'])assert.equal((await api('get',path,'denied')).status,403);
   const old=token('scoped');await db('platform_role_permission').where({role_code:'auditor',permission_code:'system.audit.read'}).delete();
   assert.equal((await request(app).get('/api/v1/audit-logs').set('Authorization','Bearer '+old)).status,403);
   await db('platform_role_permission').insert({role_code:'auditor',permission_code:'system.audit.read'});
   for(const method of ['patch','delete','post'])assert.equal((await api(method,'/audit-logs/USER1','admin',{})).status,403);
   const row=await db('operation_audit_log').where('audit_id','USER1').first();const detail=typeof row.detail==='string'?JSON.parse(row.detail):row.detail;assert.equal(detail.before.roles[0],'handler');
  });
  await t.test('real login failure, account creation and role change, correction persist searchable safe evidence',async()=>{
   const fail=await request(app).post('/api/v1/auth/login').send({username:'scoped',password:'Synthetic-Wrong-2'});assert.equal(fail.status,401);
   assert.equal((await api('get','/audit-logs?actor=scoped&category=login&result=failed')).body.data.total,1);
   const created=await api('post','/users','admin',{username:'virtual-created',realName:'虚构建号',role:'handler',password:'Synthetic-Initial-1'});assert.equal(created.status,200);
   const target=created.body.data.userId;assert.equal((await api('patch','/users/'+target,'admin',{role:'auditor'})).status,200);
   for(const action of ['USER_CREATE','USER_UPDATE']){const q=await api('get','/audit-logs?actor=admin&action='+action);assert.equal(q.body.data.total,1);assert.equal(JSON.stringify(q.body).includes('Synthetic-Initial'),false);}
   await db('platform_role_permission').insert({role_code:'auditor',permission_code:'complaint.correct'});
   await db('correction_item').insert([{correction_id:'COR1',complaint_id:'C1',field_name:'address',old_value:'旧地址',status:'pending',created_at:stamp},{correction_id:'COR2',complaint_id:'C1',field_name:'title',old_value:'RAW_CONTENT_SECRET',status:'pending',created_at:stamp}]);
   const correction=await api('post','/corrections/COR1/confirm','scoped',{expectedVersion:1,newValue:'人工核实地址',basis:'synthetic'});assert.equal(correction.status,200);
   const q=await api('get','/audit-logs?actor=scoped&businessNo=NO-C1&action=CORRECTION_CONFIRM');assert.equal(q.body.data.total,2);assert.equal(q.body.data.content[0].detail.newValue,'人工核实地址');
   assert.equal(JSON.stringify(q.body).includes('SECRET'),false);const row=await db('operation_audit_log').where('audit_id','C1A').first();const detail=typeof row.detail==='string'?JSON.parse(row.detail):row.detail;assert.equal(detail.password,'PASSWORD_SECRET','stored audit remains intact');
  });
  await t.test('incremental query indexes are applied and rerunning never restores revoked permissions',async()=>{
   assert.ok(existsSync(new URL('../migrations/20261009050000__audit_query_indexes.js',import.meta.url)),'A6 needs additive query indexes');
   const migrate=require(migration);await migrate.up(db);await migrate.up(db);
   const [indexes]=await db.raw('show index from operation_audit_log');assert.ok(indexes.some((r:any)=>r.Key_name==='idx_audit_query_time'));
   await db('platform_role_permission').where({role_code:'auditor',permission_code:'system.audit.read'}).delete();await migrate.up(db);
   assert.equal((await db('platform_role_permission').where({role_code:'auditor',permission_code:'system.audit.read'})).length,0);
  });
  await t.test('migration explicitly rejects missing or nonunique historical stable keys without rebuilding evidence',async()=>{
   const migrate=require(migration);const originalCount=Number((await db('operation_audit_log').count('* as total'))[0].total);
   await db.schema.renameTable('operation_audit_log','a6_saved_audit');
   try{
    for(const [id,reason] of [['','missing operation_audit_log.id'],['id bigint not null,','single-column unique key'],['id varchar(64) primary key,','non-null integer stable key']]){
     await db.raw('create table operation_audit_log ('+id+'audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
     await assert.rejects(()=>migrate.up(db),new RegExp(reason));
     const [indexes]=await db.raw('show index from operation_audit_log');assert.equal(indexes.some((r:any)=>r.Key_name==='idx_audit_query_time'),false,'incompatible schema must fail before adding indexes');
     await db.schema.dropTable('operation_audit_log');
    }
   }finally{await db.schema.dropTableIfExists('operation_audit_log');await db.schema.renameTable('a6_saved_audit','operation_audit_log');}
   assert.equal(Number((await db('operation_audit_log').count('* as total'))[0].total),originalCount);
  });
 }finally{await closePool?.();await db.destroy();}
});
