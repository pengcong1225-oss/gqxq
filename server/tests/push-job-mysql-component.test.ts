import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
test('C4 real SQL delivery component, declared fixture only',{skip:process.env.GQXQ_C4_COMPONENT_DB!=='gqxq_c4_contract_test'},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_c4_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_c4_contract_test',timezone:'+08:00'}});
 let close:(()=>Promise<void>)|undefined;const originalFetch=globalThis.fetch;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_c4_contract_test');
  for(const table of ['dispatch_outbox','dispatch_push_snapshot','dispatch_request_log','approval_trace','business_event','manual_followup_request','manual_followup_revision','manual_followup','platform_role_permission','platform_permission','platform_role','platform_authorization_state','app_user','complaint_field_version','complaint_source_log','number_sequence','operation_audit_log','complaint_assignment','sensitive_hit','complaint_disposition','dispatch_order','complaint','analysis_record'])await db.schema.dropTableIfExists(table);
  // Explicit legacy columns needed by current dispatch readers, not canonical/M0 DDL.
  await db.raw(`create table complaint(id bigint auto_increment primary key,complaint_id varchar(64) unique not null,complaint_no varchar(64),source_id varchar(128),source_system varchar(64),source_payload json,title varchar(256),content text,enterprise_code varchar(64),enterprise_name varchar(128),district_code varchar(64),deleted tinyint default 0,edit_version bigint default 1,status varchar(32),reporting_status varchar(32),supervision_status varchar(32),updated_at datetime) engine=InnoDB default charset=utf8mb4`);
  await db.raw(`create table dispatch_order(id bigint auto_increment primary key,assignment_id varchar(64) unique not null,order_no varchar(64),complaint_id varchar(64),complaint_title varchar(256),dispatch_type varchar(32),trigger_type varchar(32),sensitive_words json,target_enterprise_code varchar(64),target_enterprise_name varchar(128),status varchar(32),sync_status varchar(32),external_status varchar(32),deadline datetime,created_at datetime,updated_at datetime,pushed_at datetime,completed_at datetime,archived_at datetime,result_content text) engine=InnoDB default charset=utf8mb4`);
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64) unique,user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB default charset=utf8mb4');
  for(const file of ['20260917100100__m1_g1_new_tables.js','20260917100600__m6_g2_dispatch_and_assignment.js','20260917100700__m7_g3_g4_integration.js','20261003100000__reporting_integration.js','20261009030000__account_role_permissions.js','20261009040000__user_object_scopes.js','20261009120000__location_correction_group.js','20261009130000__account_identity_type.js'])await require('../migrations/'+file).up(db);
  await require('../migrations/20261009130001__manual_complaint_followups.js').ensureFollowupTables(db);
  await require('../migrations/20261009140000__dispatch_outbox.js').up(db);
  await db('app_user').insert({user_id:'operator',username:'operator',password_hash:'synthetic',real_name:'Synthetic',roles:'["handler"]',permissions:'[]',account_type:'internal',must_change_password:0,scope_rules:JSON.stringify([{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}])});
  const {pool}=await import('../src/db/pool');close=()=>pool.end();const {env}=await import('../src/config/env');Object.assign(env.pu,{keyId:'synthetic',secret:'synthetic',baseUrl:'http://127.0.0.1:1'});
  const {serializeOnce}=await import('../src/clients/publicUtilityClient');const {pushDispatch}=await import('../src/services/dispatchPushService');const {resolveAccessContext,runWithAccessContext}=await import('../src/auth/accessScope');
  const access=await resolveAccessContext('operator');const ctx={userId:'operator',userName:'operator',clientIp:null};
  const seed=async(id:string,stored=true)=>{await db('complaint').insert({complaint_id:'C'+id,complaint_no:'NO'+id,title:'Synthetic',enterprise_code:'E1',district_code:'D1',status:'open',reporting_status:'not_started',supervision_status:'pending'});await db('dispatch_order').insert({assignment_id:id,order_no:id,complaint_id:'C'+id,target_enterprise_code:'E1',target_enterprise_name:'Synthetic',request_id:'R'+id,status:'pending',sync_status:'not_synced',deadline:'2026-10-10 08:00:00',created_at:'2026-10-09 08:00:00'});const body=serializeOnce({sourceAppCode:'gqxq',sourceBusinessId:'C'+id,requestId:'R'+id,sceneCode:'GQXQ_SENSITIVE_DISPATCH',templateVersion:1,metadata:{contractVersion:2,assignmentId:id},enterpriseSubjects:[{subjectCode:'E1',subjectName:'Synthetic'}]});if(stored)await db('dispatch_push_snapshot').insert({assignment_id:id,request_id:'R'+id,body:body.bodyText,sha256:body.bodySha256,created_at:new Date()});return body;};
  await t.test('explicit push durably enqueues once without sending inside the user request',async()=>{
   await seed('A',false);let sends=0;globalThis.fetch=async(url)=>{if(String(url).endsWith('/preflight'))return new Response('{"ready":true,"issues":[]}',{status:200});sends++;return new Response('{"created":true,"task":{"id":"T1"}}',{status:200});};
   const result=await runWithAccessContext(access,()=>pushDispatch('A',ctx));
   assert.equal(sends,0,'operator endpoint must only enqueue durable work');assert.equal(result.deliveryState,'pending');assert.equal(result.accepted,false);
   const pair=await Promise.all([runWithAccessContext(access,()=>pushDispatch('A',ctx)),runWithAccessContext(access,()=>pushDispatch('A',ctx))]);assert.ok(pair.every(r=>r.deliveryState==='pending'));assert.equal((await db('dispatch_outbox')).length,1);
  });
  const {recoverDispatch}=await import('../src/services/dispatchRecoveryService');
  const enqueue=async(id:string,stored=false)=>{const bytes=await seed(id,stored);globalThis.fetch=async()=>new Response('{"ready":true,"issues":[]}',{status:200});await runWithAccessContext(access,()=>pushDispatch(id,ctx));return bytes;};
  const unsupported=async()=>({kind:'unsupported' as const});
  const confirmed=(taskId:string)=>({kind:'response' as const,httpStatus:200,bodyText:JSON.stringify({created:true,task:{id:taskId}})});
  await t.test('real authenticated API uses current capability and scope after preflight; committed intent survives revocation',async()=>{
   const {createApp}=await import('../src/app');const app=createApp();const token=jwt.sign({sub:'operator',username:'operator',sessionVersion:1},process.env.GQXQ_JWT_SECRET!);
   const call=(method:'get'|'post',path:string)=>request(app)[method]('/api/v1'+path).set('Authorization','Bearer '+token);
   await enqueue('AUTHORIZED');await seed('REVOKED',false);
   globalThis.fetch=async()=>{await db.transaction(async tx=>{await tx.raw('select version from platform_authorization_state where id=1 for update');await tx('platform_role_permission').where({role_code:'handler',permission_code:'dispatch.push'}).delete();await tx('platform_authorization_state').where('id',1).increment('version',1);});return new Response('{"ready":true,"issues":[]}',{status:200});};
   assert.equal((await call('post','/dispatch/orders/REVOKED/push')).status,403);assert.equal((await db('dispatch_outbox').where('request_id','RREVOKED')).length,0);
   assert.equal((await call('post','/dispatch/orders/AUTHORIZED/repush')).status,403);
   assert.equal((await recoverDispatch('RAUTHORIZED',{queryByRequestId:unsupported,sendExact:async()=>confirmed('T-AUTHORIZED')})).state,'succeeded');
   await db.transaction(async tx=>{await tx.raw('select version from platform_authorization_state where id=1 for update');await tx('platform_role_permission').insert({role_code:'handler',permission_code:'dispatch.push'});await tx('platform_authorization_state').where('id',1).increment('version',1);await tx('app_user').where('user_id','operator').update({scope_rules:JSON.stringify([{kind:'restricted',enterpriseCodes:['E2'],districtCodes:[]}]),scope_version:2});});
   assert.equal((await call('get','/dispatch/orders/AUTHORIZED')).status,404);assert.equal((await call('post','/dispatch/orders/AUTHORIZED/push')).status,404);const list=await call('get','/dispatch/orders');assert.equal(list.status,200);assert.equal(list.body.data.total,0);
   await db('app_user').where('user_id','operator').update({scope_rules:JSON.stringify(access.rules),scope_version:3});
   const detail=await call('get','/dispatch/orders/AUTHORIZED');assert.equal(detail.status,200);assert.equal(detail.body.data.deliveryState,'succeeded');assert.equal(JSON.stringify(detail.body.data).includes('transport_identity'),false);assert.equal(JSON.stringify(detail.body.data).includes('lease_token'),false);
  });
  await t.test('two workers claim one job, HTTP holds no complaint lock, completion is atomic',async()=>{
   let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r);const gate=new Promise<void>(r=>release=r);let sends=0;
   const worker=recoverDispatch('RA',{queryByRequestId:unsupported,sendExact:async body=>{sends++;assert.equal(body.bodyText,(await db('dispatch_push_snapshot').where('assignment_id','A').first()).body);await db.transaction(async tx=>{await tx.raw('set innodb_lock_wait_timeout=1');await tx.raw('select complaint_id from complaint where complaint_id=? for update',['CA']);});enter();await gate;return confirmed('TA');}});
   await entered;const loser=await recoverDispatch('RA',{queryByRequestId:unsupported,sendExact:async()=>{throw Error('duplicate send');}});assert.equal(loser.reason,'busy');release();assert.equal((await worker).state,'succeeded');assert.equal(sends,1);
   assert.equal((await db('dispatch_order').where('assignment_id','A').first()).reporting_task_id,'TA');assert.equal((await db('dispatch_outbox').where('request_id','RA').first()).state,'succeeded');assert.equal((await db('dispatch_request_log').where('request_id','RA')).length,1);
   await runWithAccessContext(access,()=>pushDispatch('A',ctx));assert.equal(sends,1);
  });
  await t.test('legacy bytes without job and ambiguous send default to manual, never another send',async()=>{
   await enqueue('LEGACY',true);assert.equal((await db('dispatch_outbox').where('request_id','RLEGACY').first()).state,'unknown');let sends=0;
   const transport={queryByRequestId:unsupported,sendExact:async()=>{sends++;return confirmed('unsafe');}};assert.equal((await recoverDispatch('RLEGACY',transport)).state,'unknown');assert.equal(sends,0);
   await enqueue('TIMEOUT');const first=await recoverDispatch('RTIMEOUT',{queryByRequestId:unsupported,sendExact:async()=>({kind:'timeout',message:'response lost'})});assert.equal(first.state,'unknown');assert.equal((await recoverDispatch('RTIMEOUT',transport)).state,'unknown');assert.equal(sends,0);assert.equal((await db('dispatch_order').where('assignment_id','TIMEOUT').first()).sync_status,'unknown');
  });
  await t.test('explicit confirmed fake idempotence recovers the same bytes into one provider task',async()=>{
   Object.assign(env.pu,{recoveryMode:'same-body-idempotent',recoveryContractVersion:'synthetic-deployment-contract-v1'});await enqueue('IDEM');const tasks=new Map<string,string>();let count=0;let exact='';
   const transport={queryByRequestId:unsupported,sendExact:async(body:any)=>{count++;if(exact)assert.equal(body.bodyText,exact);else exact=body.bodyText;const requestId=JSON.parse(exact).requestId;tasks.set(requestId,'T-IDEM');return count===1?{kind:'timeout' as const,message:'accepted then response lost'}:confirmed(tasks.get(requestId)!);}};
   assert.equal((await recoverDispatch('RIDEM',transport)).state,'unknown');await db('dispatch_outbox').where('request_id','RIDEM').update('next_attempt_at',new Date(0));assert.equal((await recoverDispatch('RIDEM',transport)).state,'succeeded');assert.equal(tasks.size,1);assert.equal(count,2);
   Object.assign(env.pu,{recoveryMode:'manual',recoveryContractVersion:''});
  });
  await t.test('expired lease fences late worker and a crash before send becomes unknown',async()=>{
   await enqueue('STALE');let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r);const gate=new Promise<void>(r=>release=r);
   const old=recoverDispatch('RSTALE',{queryByRequestId:unsupported,sendExact:async()=>{enter();await gate;return confirmed('TOO-LATE');}});await entered;
   await db('dispatch_outbox').where('request_id','RSTALE').update('lease_expires_at',new Date(0));assert.equal((await recoverDispatch('RSTALE',{queryByRequestId:unsupported,sendExact:async()=>{throw Error('must not resend');}})).state,'unknown');release();assert.equal((await old).reason,'lease_lost');assert.equal((await db('dispatch_order').where('assignment_id','STALE').first()).reporting_task_id,null);
   await enqueue('BEFORE');const {claimOutbox}=await import('../src/repositories/dispatchOutboxRepo');assert.ok(await claimOutbox('RBEFORE',60000));await db('dispatch_outbox').where('request_id','RBEFORE').update('lease_expires_at',new Date(0));assert.equal((await recoverDispatch('RBEFORE',{queryByRequestId:unsupported,sendExact:async()=>{throw Error('uncertain crash must not resend');}})).state,'unknown');
  });
  await t.test('permanent rejection is failed, target drift unknown, frozen bytes cannot be replaced',async()=>{
   await enqueue('REJECT');assert.equal((await recoverDispatch('RREJECT',{queryByRequestId:unsupported,sendExact:async()=>({kind:'response',httpStatus:422,bodyText:'{}'})})).state,'failed');
   await enqueue('TARGET');env.pu.baseUrl='http://127.0.0.1:2';assert.equal((await recoverDispatch('RTARGET',{queryByRequestId:unsupported,sendExact:async()=>{throw Error('new target');}})).state,'unknown');env.pu.baseUrl='http://127.0.0.1:1';
   await db('dispatch_push_snapshot').where('assignment_id','TARGET').update('body','{}');await assert.rejects(()=>runWithAccessContext(access,()=>pushDispatch('TARGET',ctx)),/digest mismatch/);
  });
  await t.test('preflight is unlocked and changed final inputs cannot enqueue with old approval',async()=>{
   await seed('DRIFT',false);globalThis.fetch=async()=>{await db('complaint').where('complaint_id','CDRIFT').update({title:'changed after preflight',edit_version:2});return new Response('{"ready":true,"issues":[]}',{status:200});};
   await assert.rejects(()=>runWithAccessContext(access,()=>pushDispatch('DRIFT',ctx)),{status:409});assert.equal((await db('dispatch_outbox').where('request_id','RDRIFT')).length,0);assert.equal((await db('dispatch_push_snapshot').where('assignment_id','DRIFT')).length,0);
  });
  await t.test('known legacy task without original bytes cannot invent a fresh request snapshot',async()=>{
   await seed('NOEVIDENCE',false);await db('dispatch_order').where('assignment_id','NOEVIDENCE').update({reporting_task_id:'T-OLD',status:'pushed'});let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{"ready":true,"issues":[]}',{status:200});};
   await assert.rejects(()=>runWithAccessContext(access,()=>pushDispatch('NOEVIDENCE',ctx)),{status:409});assert.equal(calls,0);assert.equal((await db('dispatch_push_snapshot').where('assignment_id','NOEVIDENCE')).length,0);
  });
  await t.test('result write failure rolls back log, business linkage and job; known callback linkage wins',async()=>{
   await enqueue('ATOMIC');await db.raw("create trigger c4_fail_audit before insert on operation_audit_log for each row begin if json_unquote(json_extract(NEW.detail,'$.stage'))='delivery' then signal sqlstate '45000' set message_text='synthetic completion crash'; end if; end");
   try{await assert.rejects(()=>recoverDispatch('RATOMIC',{queryByRequestId:unsupported,sendExact:async()=>confirmed('T-ATOMIC')}),/synthetic completion crash/);}finally{await db.raw('drop trigger c4_fail_audit');}
   assert.equal((await db('dispatch_order').where('assignment_id','ATOMIC').first()).reporting_task_id,null);assert.equal((await db('dispatch_outbox').where('request_id','RATOMIC').first()).state,'sending');assert.equal((await db('dispatch_request_log').where('request_id','RATOMIC')).length,0);
   await db('dispatch_order').where('assignment_id','ATOMIC').update({reporting_task_id:'T-ATOMIC',status:'accepted'});await db('dispatch_outbox').where('request_id','RATOMIC').update('lease_expires_at',new Date(0));assert.equal((await recoverDispatch('RATOMIC',{queryByRequestId:unsupported,sendExact:async()=>{throw Error('known task should not send');}})).state,'succeeded');
  });
  await t.test('cancelled queued work does not send; late historical success cannot advance new round',async()=>{
   await enqueue('CANCEL');await db('dispatch_order').where('assignment_id','CANCEL').update('status','cancelled');let sent=0;assert.equal((await recoverDispatch('RCANCEL',{queryByRequestId:unsupported,sendExact:async()=>{sent++;return confirmed('bad');}})).state,'failed');assert.equal(sent,0);
   await enqueue('LATE');const before=(await db('complaint').where('complaint_id','CLATE').first()).reporting_status;
   assert.equal((await recoverDispatch('RLATE',{queryByRequestId:unsupported,sendExact:async()=>{await db('dispatch_order').where('assignment_id','LATE').update('status','cancelled');await db('dispatch_order').insert({assignment_id:'NEXT',complaint_id:'CLATE',request_id:'RNEXT',status:'pending',target_enterprise_code:'E1'});return confirmed('T-LATE');}})).state,'succeeded');
   assert.equal((await db('complaint').where('complaint_id','CLATE').first()).reporting_status,before);assert.equal((await db('dispatch_order').where('assignment_id','NEXT').first()).reporting_task_id,null);
  });
  await t.test('migration rejects prefix identity and incompatible precision without mutating data',async()=>{
   const migrate=require('../migrations/20261009140000__dispatch_outbox.js');await migrate.up(db);const count=(await db('dispatch_outbox')).length;
   await db.raw('alter table dispatch_outbox drop primary key, add unique key uk_c4_prefix(request_id(8))');try{await assert.rejects(()=>migrate.up(db),/incompatible full identity key/);assert.equal((await db('dispatch_outbox')).length,count);}finally{await db.raw('alter table dispatch_outbox drop index uk_c4_prefix, add primary key(request_id)');}
   await db.raw('alter table dispatch_outbox modify lease_expires_at datetime null');try{await assert.rejects(()=>migrate.up(db),/incompatible column/);}finally{await db.raw('alter table dispatch_outbox modify lease_expires_at datetime(3) null');}
  });
  await t.test('independent process crashes before/after HTTP and reopened workers recover durable intent',async()=>{
   await db.schema.dropTableIfExists('c4_fake_provider');await db.raw('create table c4_fake_provider(request_id varchar(128) primary key,payload_hash varchar(64),task_id varchar(128),calls int) engine=InnoDB');
   const spawn=(mode:string,id:string)=>spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','tests/fixtures/dispatch-recovery-worker.ts',mode,id],{cwd:process.cwd(),env:{...process.env,GQXQ_PU_KEY_ID:'synthetic',GQXQ_PU_SECRET:'synthetic',GQXQ_PU_RECOVERY_MODE:env.pu.recoveryMode,GQXQ_PU_RECOVERY_CONTRACT_VERSION:env.pu.recoveryContractVersion},encoding:'utf8',windowsHide:true,timeout:20000});
   await enqueue('PROCESSBEFORE');const before=spawn('crash-before-send','RPROCESSBEFORE');assert.equal(before.status,23,before.stderr);await db('dispatch_outbox').where('request_id','RPROCESSBEFORE').update('lease_expires_at',new Date(0));const manual=spawn('recover','RPROCESSBEFORE');assert.equal(manual.status,0,manual.stderr);assert.match(manual.stdout,/C4_FRESH_PROCESS_RESULT=unknown/);assert.equal((await db('c4_fake_provider')).length,0);
   Object.assign(env.pu,{recoveryMode:'same-body-idempotent',recoveryContractVersion:'synthetic-deployment-contract-v1'});await enqueue('PROCESSAFTER');const crashed=spawn('crash-after-send','RPROCESSAFTER');assert.equal(crashed.status,23,crashed.stderr);assert.equal((await db('dispatch_outbox').where('request_id','RPROCESSAFTER').first()).state,'sending');await db('dispatch_outbox').where('request_id','RPROCESSAFTER').update('lease_expires_at',new Date(0));const recovered=spawn('recover','RPROCESSAFTER');assert.equal(recovered.status,0,recovered.stderr);assert.match(recovered.stdout,/C4_FRESH_PROCESS_RESULT=succeeded/);assert.equal((await db('c4_fake_provider')).length,1);assert.equal((await db('c4_fake_provider').first()).calls,2);assert.equal((await db('dispatch_order').where('assignment_id','PROCESSAFTER').first()).reporting_task_id,'TASK-RPROCESSAFTER');console.log('C4_INDEPENDENT_PROCESS_CRASH_AND_RECOVERY_OK');Object.assign(env.pu,{recoveryMode:'manual',recoveryContractVersion:''});
  });
  await t.test('fake request lookup requires exact identity and accepted-without-id remains unknown',async()=>{
   await enqueue('LOOKUP');await recoverDispatch('RLOOKUP',{queryByRequestId:unsupported,sendExact:async()=>({kind:'response',httpStatus:200,bodyText:'{"created":false}'})});assert.equal((await db('dispatch_outbox').where('request_id','RLOOKUP').first()).state,'unknown');const row=await db('dispatch_outbox').where('request_id','RLOOKUP').first();
   const found={kind:'found' as const,taskId:'T-LOOKUP',requestId:'RLOOKUP',assignmentId:'LOOKUP',sourceBusinessId:'CLOOKUP',sourceAppCode:'gqxq',payloadHash:row.payload_hash};
   assert.equal((await recoverDispatch('RLOOKUP',{queryByRequestId:async()=>({...found,assignmentId:'WRONG'}),sendExact:async()=>{throw Error('must query first');}})).state,'unknown');
   assert.equal((await recoverDispatch('RLOOKUP',{queryByRequestId:async()=>found,sendExact:async()=>{throw Error('must not send after found');}})).state,'succeeded');
  });
  await t.test('a task registered during lookup is rechecked before another send',async()=>{
   Object.assign(env.pu,{recoveryMode:'same-body-idempotent',recoveryContractVersion:'synthetic-deployment-contract-v1'});
   try{await enqueue('DURINGLOOKUP',true);let sends=0;
    const result=await recoverDispatch('RDURINGLOOKUP',{queryByRequestId:async()=>{await db('dispatch_order').where('assignment_id','DURINGLOOKUP').update({reporting_task_id:'T-DURINGLOOKUP',status:'accepted'});return {kind:'unsupported'};},sendExact:async()=>{sends++;return confirmed('T-DURINGLOOKUP');}});
    assert.equal(result.state,'succeeded');assert.equal(result.taskId,'T-DURINGLOOKUP');assert.equal(sends,0,'newly registered exact task must stop a recovery send');
   }finally{Object.assign(env.pu,{recoveryMode:'manual',recoveryContractVersion:''});}
  });
  await t.test('complaint before dispatch before outbox locks allow interleaved user and signed callback',async()=>{
   await enqueue('LOCK');const {withTransaction}=await import('../src/db/tx');const {assertLockedComplaintAccess}=await import('../src/auth/accessScope');
   const originalGet=pool.getConnection.bind(pool);let observing=false;let waiting!:()=>void;const wait=new Promise<void>(r=>waiting=r);
   pool.getConnection=(async()=>{const conn=await originalGet();const query=conn.query.bind(conn),release=conn.release.bind(conn);conn.query=(async(...args:any[])=>{if(observing&&typeof args[0]==='string'&&args[0].includes('from complaint where complaint_id = ? for update')&&args[1]?.[0]==='CLOCK')waiting();return (query as any)(...args);}) as any;conn.release=()=>{conn.query=query as any;conn.release=release;release();};return conn;}) as any;
   let worker:Promise<any>|undefined;
   try{await runWithAccessContext(access,()=>withTransaction(async tx=>{
    await assertLockedComplaintAccess(tx,'CLOCK');
    observing=true;
    worker=recoverDispatch('RLOCK',{queryByRequestId:unsupported,sendExact:async()=>{
     const {handleCallback}=await import('../src/services/callbackService');const {signCallback}=await import('../src/clients/callbackSignature');Object.assign(env.callback,{keyId:'c4',keyVersion:'v1',secret:'synthetic',ackMode:'BODY',ackValue:'OK'});
     const event={contractVersion:2,eventId:'LOCK-CB',eventType:'TASK_ACCEPTED',sourceAppCode:'gqxq',sourceBusinessId:'CLOCK',assignmentId:'LOCK',requestId:'RLOCK',reportingItemId:'I-LOCK',eventSequence:1,taskId:'T-LOCK',sceneCode:'GQXQ_SENSITIVE_DISPATCH',enterpriseSubject:{subjectCode:'E1',subjectName:'Synthetic'},enterpriseDisposalResult:{},approvalConclusion:'PENDING',templateVersion:1,attachments:[],occurredAt:new Date().toISOString()};
     const rawBody=Buffer.from(JSON.stringify(event));const timestamp=String(Math.floor(Date.now()/1000));const callback=await handleCallback({rawBody,keyId:'c4',keyVersion:'v1',timestamp,headerEventId:event.eventId,signature:signCallback('synthetic',Number(timestamp),rawBody),remoteIp:null});assert.equal(callback.status,200);return confirmed('T-LOCK');
    }});
    await wait;await tx.query('select assignment_id from dispatch_order where assignment_id=? for update',['LOCK']);await tx.query('select request_id from dispatch_outbox where request_id=? for update',['RLOCK']);
   }));assert.equal((await worker!).state,'succeeded');assert.equal((await db('dispatch_order').where('assignment_id','LOCK').first()).status,'accepted');assert.equal((await db('business_event').where('event_id','LOCK-CB').first()).processed_result,'applied');}
   finally{pool.getConnection=originalGet;}
  });
  await t.test('A6 query shows queue versus delivery phase safely and ignores colliding assignment ownership',async()=>{
   // Minimal unrelated master columns required by the shared A6 scope SQL, plus real C3 tables above.
   for(const table of ['service_grid_admin','grid_enterprise','service_grid','community','admin_grid','enterprise','analysis_record'])await db.schema.dropTableIfExists(table);
   for(const sql of ['create table enterprise(enterprise_code varchar(64),district_code varchar(64))','create table service_grid(grid_code varchar(64),version bigint,import_state varchar(32))','create table grid_enterprise(grid_code varchar(64),enterprise_code varchar(64))','create table service_grid_admin(grid_code varchar(64),version bigint,admin_grid_code varchar(64))','create table admin_grid(code varchar(64),district_code varchar(64))','create table community(code varchar(64),admin_grid_code varchar(64))','create table analysis_record(analysis_id varchar(64),complaint_id varchar(64))'])await db.raw(sql+' engine=InnoDB');
   await db('complaint').insert({complaint_id:'FOREIGN',enterprise_code:'E2',district_code:'D2'});await db('dispatch_order').insert({assignment_id:'CA',complaint_id:'FOREIGN',request_id:'R-COLLISION',status:'pending'});
   const {auditQueryService}=await import('../src/services/auditQueryService');const logs=await auditQueryService.list({action:'DISPATCH_PUSH',businessNo:'CA'},{page:1,size:100},{...access,permissionCodes:['system.audit.read']});
   assert.equal(logs.total,2);const queue=logs.content.find(r=>r.detail.stage==='enqueue')!;assert.equal(queue.result,'unknown');assert.equal(queue.originalResult,'pending');assert.equal(queue.detail.deliveryState,'pending');assert.equal(logs.content.find(r=>r.detail.stage==='delivery')?.detail.deliveryState,'succeeded');assert.ok(logs.content.every(r=>r.businessNo==='NOA'));assert.equal(JSON.stringify(logs).includes('transport_identity'),false);
   assert.equal((await auditQueryService.list({action:'DISPATCH_PUSH',businessNo:'CA'},{page:1,size:100},{...access,rules:[{kind:'restricted',enterpriseCodes:['E2'],districtCodes:[]}],permissionCodes:['system.audit.read']})).total,0);
  });
 }finally{globalThis.fetch=originalFetch;if(close)await close();await db.destroy();}
});
