import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import knexFactory from 'knex';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_A2_COMPONENT_DB==='gqxq_a2_contract_test';
test('A2 isolated MySQL object scope component, not canonical M0 acceptance',{skip:!enabled},async t=>{
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_a2_contract_test');assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_a2_contract_test',timezone:'+08:00'}});
 // Owned synthetic schema only. app_user follows M1; remaining tables are explicit
 // query-contract fixtures. Types required for edit_version/JSON/locks are real;
 // no nineteen-table baseline, no M0 validation or complete migration claim.
 const tables=['sensitive_hit','dict_item','complaint_assignment','enterprise','complaint_location_clue','complaint_address_candidate','business_event','dispatch_request_log','approval_trace','report_todo','analysis_record','correction_item','complaint_field_version','complaint_source_log','dispatch_order','complaint','platform_role_permission','platform_permission','platform_role','platform_authorization_state','operation_audit_log','app_user','number_sequence'];
 for(const table of tables)await db.schema.dropTableIfExists(table);
 await db.raw("create table app_user (id bigint primary key auto_increment,user_id varchar(64) not null unique,username varchar(64) not null unique,password_hash varchar(100) not null,real_name varchar(64) not null,roles json not null,permissions json not null,status tinyint not null default 1,last_login_at datetime,created_at datetime not null default current_timestamp,updated_at datetime not null default current_timestamp on update current_timestamp) engine=InnoDB default charset=utf8mb4");
 await db.raw('create table operation_audit_log (id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
 await db.raw('create table number_sequence (seq_key varchar(64),biz_date date,current_value bigint default 0,primary key(seq_key,biz_date)) engine=InnoDB');
 await require('../migrations/20261009030000__account_role_permissions.js').up(db);
 // Existing enabled legacy user receives explicit migration bootstrap exactly once.
 await db('app_user').insert({user_id:'legacy',username:'legacy',password_hash:'unused',real_name:'虚构',roles:'["handler"]',permissions:'[]'});
 await require('../migrations/20261009040000__user_object_scopes.js').up(db);
 const {COMPLAINT_COLUMNS}=await import('../src/repositories/complaintMapper');
 const columns=[...new Set(COMPLAINT_COLUMNS.split(', ').map(c=>c.slice(2)).concat(['source_payload_hash','source_synced_at','deleted']))];
 const json=new Set(['source_payload','source_fields','effective_field_state']);
 const nums=new Set(['edit_version','deleted','is_sensitive','closed_in_system','analysis_included','overtime_flag']);
 await db.raw('create table complaint ('+columns.map(c=>c==='id'?'id bigint auto_increment primary key':c==='complaint_id'?'complaint_id varchar(64) unique':json.has(c)?c+' json':nums.has(c)?c+' bigint default '+(c==='edit_version'?1:0):c.endsWith('_at')?c+' datetime':c+' text').join(',')+') engine=InnoDB');
 const {ORDER_SELECT_COLUMNS}=await import('../src/repositories/dispatchRepo');
 const dispatchColumns=[...new Set([...ORDER_SELECT_COLUMNS.matchAll(/\bd\.(\w+)/g)].map(m=>m[1]).concat(['active_complaint_id']))];
 await db.raw('create table dispatch_order ('+dispatchColumns.map(c=>c==='id'?'id bigint primary key auto_increment':c.endsWith('_at')||c==='deadline'?c+' datetime':c==='template_version'||c==='approval_definition_version'?c+' bigint':c+' varchar(255)').join(',')+') engine=InnoDB');
 await db.raw('create table correction_item (id bigint primary key auto_increment,correction_id varchar(64) unique,complaint_id varchar(64),assignment_id varchar(64),field_name varchar(64),field_label varchar(64),old_value text,new_value text,basis text,status varchar(32),confirmer_id varchar(64),confirmer_name varchar(64),confirmed_at datetime,created_at datetime) engine=InnoDB');
 await db.raw('create table analysis_record (id bigint primary key auto_increment,analysis_id varchar(64),complaint_id varchar(64),assignment_id varchar(64),business_type varchar(32),complaint_type varchar(32),district_code varchar(64),district_name varchar(64),enterprise_code varchar(64),enterprise_name varchar(64),summary text,disposal_result text,confirmed_at datetime,created_at datetime) engine=InnoDB');
 await db.raw('create table report_todo (id bigint primary key auto_increment,todo_id varchar(64),analysis_id varchar(64),complaint_id varchar(64),report_id varchar(64),status varchar(32),note text,created_at datetime,updated_at datetime) engine=InnoDB');
 await db.raw('create table complaint_address_candidate (complaint_id varchar(64),candidate_text text,evidence_text text,source_field varchar(64),extractor_version varchar(64),input_hash varchar(64),district_code varchar(64),parent_match varchar(64),snapshot_id varchar(64)) engine=InnoDB');
 await db.raw('create table complaint_location_clue (id bigint primary key auto_increment,complaint_id varchar(64),clue_kind varchar(64),clue_value text,evidence_text text,source_field varchar(64),source_start bigint,source_end bigint,township_code varchar(64),district_code varchar(64),parent_match varchar(64),extractor_version varchar(64),snapshot_id varchar(64),input_hash varchar(64)) engine=InnoDB');
 await db.raw('create table complaint_field_version (id bigint primary key auto_increment,version_id varchar(64),complaint_id varchar(64),field_name varchar(64),old_value text,new_value text,change_source varchar(64),reason text,operator_id varchar(64),operator_name varchar(64),changed_at datetime) engine=InnoDB');
 await db.raw('create table complaint_source_log (id bigint primary key auto_increment,log_id varchar(64),source_system varchar(64),source_id varchar(64),complaint_id varchar(64),result varchar(64),message text,request_id varchar(64),remote_ip varchar(64),payload_hash varchar(64),received_at datetime) engine=InnoDB');
 await db.raw('create table dict_item (id bigint primary key auto_increment,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(64),status varchar(32)) engine=InnoDB');
 await db.raw('create table sensitive_hit (id bigint primary key auto_increment,dict_item_id varchar(64),complaint_id varchar(64)) engine=InnoDB');
 await db('dict_item').insert({item_id:'WORD',dict_type:'sensitive_word',item_value:'虚构',item_label:'虚构',status:'enabled'});
 await db.raw('create table business_event (id bigint primary key auto_increment,event_id varchar(64),processed_result varchar(32),processed_message text,payload json,task_id varchar(64),source_business_id varchar(64),occurred_at datetime) engine=InnoDB');
 await db.raw('create table approval_trace (id bigint primary key auto_increment,trace_id varchar(64),assignment_id varchar(64),task_id varchar(64),event_id varchar(64),event_type varchar(32),approval_conclusion varchar(32),submission_version bigint,actor_name varchar(64),occurred_at datetime,summary text) engine=InnoDB');
 await db.raw('create table dispatch_request_log (id bigint primary key auto_increment,request_log_id varchar(64),assignment_id varchar(64),request_id varchar(64),attempt bigint,nonce varchar(64),http_status bigint,result varchar(64),error_code varchar(64),error_message text,task_id varchar(64),started_at datetime,finished_at datetime,created_at datetime) engine=InnoDB');
 await db.raw('create table enterprise (id bigint primary key auto_increment,enterprise_code varchar(64),enterprise_name varchar(64),business_type varchar(32),uscc varchar(64),legal_person varchar(64),contact_person varchar(64),contact_phone varchar(64),service_area text,annual_score decimal(10,2),status varchar(32)) engine=InnoDB');
 await db.raw('create table complaint_assignment (assignment_log_id varchar(64),complaint_id varchar(64),before_enterprise_code varchar(64),before_enterprise_name varchar(64),after_enterprise_code varchar(64),after_enterprise_name varchar(64),match_type varchar(32),reason text,operator_id varchar(64),operator_name varchar(64),created_at datetime) engine=InnoDB');
 await db('enterprise').insert([{enterprise_code:'A',enterprise_name:'虚构A',status:'active'},{enterprise_code:'B',enterprise_name:'虚构B',status:'active'}]);
 const {createApp}=await import('../src/app');const {pool,closePool}=await import('../src/db/pool');
 const {runWithAccessContext,resolveAccessContext,assertLockedComplaintAccess}=await import('../src/auth/accessScope');
 const {withTransaction}=await import('../src/db/tx');const users=await import('../src/services/userService');
 const scope=[{kind:'restricted' as const,enterpriseCodes:['A'],districtCodes:['G1']},{kind:'restricted' as const,enterpriseCodes:['B'],districtCodes:['G2']}];
 for(const [id,role,rules] of [['admin','admin',[]],['paired','handler',scope],['other','handler',[{kind:'restricted',enterpriseCodes:['A'],districtCodes:['G2']}]],['empty','handler',[]]])await db('app_user').insert({user_id:id,username:id,password_hash:'unused',real_name:'虚构',roles:JSON.stringify([role]),permissions:'[]',scope_rules:JSON.stringify(rules),session_version:1,must_change_password:0});
 for(const [id,e,d,deleted] of [['C1','A','G1',0],['C2','B','G2',0],['C3','A','G2',0],['C4','B','G1',0],['DELETED','A','G1',1]]){
  await db('complaint').insert({complaint_id:id,complaint_no:'NO-'+id,title:'虚构诉求',enterprise_code:e,district_code:d,deleted,edit_version:1,reporting_status:'pushed',supervision_status:'none',source_event_status:'unknown',business_type:'water',received_at:new Date(),source_payload:JSON.stringify({secret:'DOCUMENT_SECRET',address:'原地址'}),source_fields:JSON.stringify({address:'原地址'}),effective_field_state:'{}'});
  await db('dispatch_order').insert({assignment_id:'D-'+id,complaint_id:id,status:'completed',reporting_task_id:'T-'+id});
  await db('correction_item').insert({correction_id:'COR-'+id,complaint_id:id,field_name:'address',old_value:'旧地址',status:'pending',created_at:new Date()});
  await db('analysis_record').insert({analysis_id:'ANA-'+id,complaint_id:id,business_type:'water'});
  await db('report_todo').insert({todo_id:'TODO-'+id,analysis_id:'ANA-'+id,complaint_id:id,status:'pending'});
 }
 await db('business_event').insert({event_id:'EVENT-C1',processed_result:'applied',task_id:'T-C1',source_business_id:'C1',payload:JSON.stringify({eventType:'TASK_SUBMITTED',submissionVersion:1,eventSequence:2,sourcePayload:{secret:'CALLBACK_SECRET'},enterpriseDisposalResult:{result:'已处置',sourcePayload:{secret:'CALLBACK_SECRET'}},attachments:[]})});
 await db('dispatch_request_log').insert({assignment_id:'D-C1',attempt:1,result:'validation_failed',error_message:JSON.stringify({sourcePayload:{secret:'PUSH_SECRET'}})});
 await db('complaint_field_version').insert({complaint_id:'C1',field_name:'source_payload',old_value:'TIMELINE_SECRET',new_value:'TIMELINE_SECRET',changed_at:new Date()});
 await db('operation_audit_log').insert({biz_id:'C1',action:'CALLBACK_APPLIED',detail:JSON.stringify({payload:{secret:'TIMELINE_SECRET'}}),created_at:new Date()});
 await db('sensitive_hit').insert(['C1','C2','C3','DELETED'].map(complaint_id=>({complaint_id,dict_item_id:'WORD'})));
 const app=createApp();const token=(userId:string)=>jwt.sign({sub:userId,username:userId,sessionVersion:1},process.env.GQXQ_JWT_SECRET!);
 const api=(method:string,path:string,user='paired',body?:unknown)=>{const q=(request(app) as any)[method]('/api/v1'+path).set('Authorization','Bearer '+token(user));return body===undefined?q:q.send(body);};
 const ctx={userId:'admin',userName:'admin',clientIp:'127.0.0.1'};
 try{
  await t.test('list totals and all related queues use Q1 current complaint SQL',async()=>{
   const r=await api('get','/complaints');assert.equal(r.status,200);assert.equal(r.body.data.total,2);assert.equal(r.body.data.stats.total,2);assert.deepEqual(r.body.data.content.map((r:any)=>r.complaintId).sort(),['C1','C2']);
   assert.equal((await api('get','/complaints?enterpriseCode=A&districtCode=G2')).body.data.total,0);
   for(const path of ['/dispatch/orders','/analysis/records','/report-todos','/corrections/pending','/corrections/pending-complaints']){const r=await api('get',path);assert.equal(r.status,200,path);assert.equal(r.body.data.total,2,path);}
   const dash=await api('get','/dashboard/overview');assert.equal(dash.status,200);assert.equal(dash.body.data.metrics.total,2);
  });
  await t.test('guessed number, soft-delete and indirect IDs reject before exposure or writes',async()=>{
   for(const path of ['/complaints/C3','/complaints/NO-C3','/complaints/3','/complaints/DELETED','/complaints/C3/timeline','/complaints/C3/corrections','/analysis/records/ANA-C3','/dispatch/orders/D-C3','/dispatch/orders/D-C3/approval-trace','/dispatch/orders/D-C3/push-logs','/dispatch/orders/D-C3/reporting-result','/dispatch/orders/D-C3/reporting-attachments/123'])assert.equal((await api('get',path)).status,404,path);
   for(const [path,body] of [['/complaints/C3/assignment',{enterpriseCode:'A',enterpriseName:'虚构'}],['/complaints/C3/disposition',{disposition:'false_positive'}],['/complaints/C3/close',{basis:'虚构'}],['/complaints/C3/source-sync',{}],['/complaints/C3/corrections/generate',{}],['/corrections/COR-C3/confirm',{expectedVersion:1,newValue:'地址'}],['/corrections/COR-C3/reject',{expectedVersion:1,basis:'虚构'}],['/dispatch/orders',{complaintId:'C3',targetEnterpriseCode:'A',targetEnterpriseName:'虚构'}],['/dispatch/orders/D-C3/cancel',{basis:'虚构'}],['/dispatch/orders/D-C3/archive',{}],['/dispatch/orders/D-C3/preflight',{}],['/dispatch/orders/D-C3/reconcile',{}],['/dispatch/orders/D-C3/push',{}],['/dispatch/orders/D-C3/repush',{}]])assert.equal((await api('post',path,'paired',body)).status,404,path);
   const row=await db('complaint').where('complaint_id','C3').first();assert.equal(Number(row.edit_version),1);
  });
  await t.test('no scope includes administrator, concurrent users do not exchange data',async()=>{
   assert.equal((await api('get','/complaints','admin')).body.data.total,0);assert.equal((await api('get','/users','admin')).status,200);
   assert.equal((await api('get','/dicts/sensitive-words','admin')).body.data[0].hitCount,0);
   assert.equal((await api('get','/complaints','empty')).body.data.total,0);
   assert.equal((await api('get','/users/empty/scopes','admin')).status,200);
   assert.equal((await api('put','/users/empty/scopes','admin',{rules:[{kind:'restricted',enterpriseCodes:['A'],districtCodes:['G1']}],expectedVersion:1})).status,200);
   assert.equal((await api('get','/complaints','empty')).body.data.total,1);
   assert.equal((await api('get','/complaints','admin')).body.data.total,0);
   await users.updateUserScope('empty',[],2,ctx);
   const [a,b]=await Promise.all([api('get','/complaints','paired'),api('get','/complaints','other')]);assert.equal(a.body.data.total,2);assert.deepEqual(b.body.data.content.map((r:any)=>r.complaintId),['C3']);
  });
  await t.test('source projection also applies to analysis, document capability and audit are separate',async()=>{
   await db('approval_trace').insert({trace_id:'FOREIGN-TRACE',assignment_id:'D-C3',summary:'FOREIGN_TRACE_SECRET'});
   await db('analysis_record').where('analysis_id','ANA-C1').update({assignment_id:'D-C3'});
   const related=await api('get','/analysis/records/ANA-C1');assert.equal(related.status,200);assert.equal(JSON.stringify(related.body).includes('FOREIGN_TRACE_SECRET'),false);
   await db('analysis_record').where('analysis_id','ANA-C1').update({assignment_id:null});
   for(const path of ['/complaints/C1','/analysis/records/ANA-C1']){const r=await api('get',path);assert.equal(r.status,200);assert.equal(JSON.stringify(r.body).includes('DOCUMENT_SECRET'),false,path);}
   for(const [path,marker] of [['/complaints/C1/timeline','TIMELINE_SECRET'],['/dispatch/orders/D-C1/reporting-result','CALLBACK_SECRET'],['/dispatch/orders/D-C1/push-logs','PUSH_SECRET']]){const r=await api('get',path);assert.equal(r.status,200);assert.equal(JSON.stringify(r.body).includes(marker),false,path);}
   assert.equal((await api('get','/complaints/C1/source-document')).status,403);
   await users.updateUserScope('admin',[{kind:'all'}],1,ctx);
   assert.equal((await api('get','/dicts/sensitive-words','admin')).body.data[0].hitCount,3);
   const source=await api('get','/complaints/C1/source-document','admin');assert.equal(source.status,200);assert.equal(source.body.data.sourcePayload.secret,'DOCUMENT_SECRET');assert.equal((await db('operation_audit_log').where('action','SOURCE_DOCUMENT_READ')).length,1);
  });
  await t.test('scope version uses A5 lock, stale edit conflicts and revocation affect old token next request',async()=>{
   const old=token('paired');const first=await users.getUserScope('paired');assert.equal(first.scopeVersion,1);
   const r=await api('put','/users/paired/scopes','admin',{rules:[],expectedVersion:1});assert.equal(r.status,200);assert.equal(r.body.data.scopeVersion,2);
   assert.equal((await api('put','/users/paired/scopes','admin',{rules:scope,expectedVersion:1})).status,409);
   const now=await request(app).get('/api/v1/complaints').set('Authorization','Bearer '+old);assert.equal(now.body.data.total,0);
   await users.updateUserScope('paired',scope,2,ctx);
   const read=await resolveAccessContext('paired');assert.equal(read.scopeVersion,3);
  });
  await t.test('transaction checks current row after scope keys change, A1 MySQL editVersion protection remains',async()=>{
   const access=await resolveAccessContext('paired');
   await db('complaint').where('complaint_id','C1').update({district_code:'G2'});
   await assert.rejects(runWithAccessContext(access,()=>withTransaction(async tx=>{await assertLockedComplaintAccess(tx,'C1');})),{status:404});
   await db('complaint').where('complaint_id','C1').update({district_code:'G1'});
   const stale=await api('post','/corrections/COR-C1/confirm','paired',{expectedVersion:2,newValue:'新地址'});assert.equal(stale.status,409);
   const good=await api('post','/corrections/COR-C1/confirm','paired',{expectedVersion:1,newValue:'新地址',basis:'人工核实'});assert.equal(good.status,200);assert.equal(Number((await db('complaint').where('complaint_id','C1').first()).edit_version),2);
   assert.equal((await api('post','/corrections/COR-C1/reject','paired',{expectedVersion:1,basis:'旧窗口'})).status,409);
  });
  await t.test('service rechecks a current scope change after preflight and rolls back cross-scope assignment',async()=>{
   const original=pool.getConnection.bind(pool);let armed=true;
   (pool as any).getConnection=async()=>{const conn=await original();const begin=conn.beginTransaction.bind(conn);conn.beginTransaction=async()=>{if(armed){armed=false;await db('complaint').where('complaint_id','C2').update({district_code:'G1'});}return begin();};return conn;};
   try{assert.equal((await api('post','/complaints/C2/source-sync','paired',{})).status,404);}finally{pool.getConnection=original;await db('complaint').where('complaint_id','C2').update({district_code:'G2'});}
   const version=Number((await db('complaint').where('complaint_id','C1').first()).edit_version);
   assert.equal((await api('post','/complaints/C1/assignment','paired',{enterpriseCode:'B',enterpriseName:'虚构B',reason:'虚构变更'})).status,404);
   const row=await db('complaint').where('complaint_id','C1').first();assert.equal(row.enterprise_code,'A');assert.equal(Number(row.edit_version),version);
   assert.equal((await db('complaint_assignment').where('complaint_id','C1')).length,0);
   const {getTownshipSnapshot}=await import('../src/services/rules/townshipGazetteer');
   await db('correction_item').insert({correction_id:'DIST-C1',complaint_id:'C1',field_name:'district_name',status:'pending',created_at:new Date()});
   assert.equal((await api('post','/corrections/DIST-C1/confirm','paired',{expectedVersion:version,newValue:getTownshipSnapshot().counties[0].code})).status,404);
   assert.equal((await db('correction_item').where('correction_id','DIST-C1').first()).status,'pending');
   assert.equal((await db('complaint').where('complaint_id','C1').first()).district_code,'G1');
   assert.equal(Number((await db('complaint').where('complaint_id','C1').first()).edit_version),version);
   await db('correction_item').where('correction_id','DIST-C1').delete();
   const dispatch=await api('post','/dispatch/orders','paired',{complaintId:'C1',targetEnterpriseCode:'B',targetEnterpriseName:'虚构B'});
   assert.equal(dispatch.status,200);assert.equal(dispatch.body.data.created,true);assert.equal(dispatch.body.data.order.targetEnterpriseCode,'B');
   assert.equal((await db('complaint').where('complaint_id','C1').first()).enterprise_code,'A');
   await db('dispatch_order').where('assignment_id',dispatch.body.data.order.assignmentId).delete();
   await db('complaint').where('complaint_id','C1').update({supervision_status:'none'});
  });
  await t.test('bulk counts stay scoped and maintenance requires explicit all',async()=>{
   const batch=await api('post','/corrections/generate-batch','paired',{});assert.equal(batch.status,200);assert.equal(batch.body.data.totalComplaints,2);assert.equal(batch.body.data.uncoveredComplaints,0);
   await users.updateUserScope('admin',[],(await users.getUserScope('admin')).scopeVersion,ctx);
   for(const path of ['/address-candidates/backfill-preview','/address-candidates/backfill','/dicts/sensitive-words/rescan-preview','/dicts/sensitive-words/rescan'])assert.equal((await api('post',path,'admin',{})).status,403,path);
   await require('../migrations/20261009040000__user_object_scopes.js').up(db);assert.deepEqual((await users.getUserScope('admin')).rules,[]);
   const legacy=await db('app_user').where('user_id','legacy').first();assert.match(legacy.scope_provenance,/legacy-all-bootstrap/);
  });
 }finally{await closePool();await db.destroy();}
});
