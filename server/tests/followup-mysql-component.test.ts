import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import knexFactory from 'knex';
import jwt from 'jsonwebtoken';
import {prepareGridAuditFixture} from './helpers/gridAuditFixture';
import request from 'supertest';
const require=createRequire(import.meta.url);
test('C3 actual SQL followup component on isolated declared fixture, not canonical acceptance',{skip:process.env.GQXQ_C3_COMPONENT_DB!=='gqxq_c3_contract_test'},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_c3_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_c3_contract_test',timezone:'+08:00'}});
 let close:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_c3_contract_test');
  assert.ok(existsSync(new URL('../migrations/20261009130000__account_identity_type.js',import.meta.url)),'C3 actual identity migration missing');
  for(const name of ['manual_followup_request','manual_followup_revision','manual_followup','platform_role_permission','platform_permission','platform_role','platform_authorization_state','app_user','number_sequence','complaint_source_log','complaint_field_version','operation_audit_log','complaint','dispatch_order','analysis_record','business_event','enterprise','service_grid','admin_grid','community'])await db.schema.dropTableIfExists(name);
  await require('../migrations/20260917100100__m1_g1_new_tables.js').up(db);
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64) unique,user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB default charset=utf8mb4');
  // Declared relevant legacy complaint/audit SQL contract; not M0/canonical DDL.
  await db.raw('create table complaint(id bigint auto_increment primary key,complaint_id varchar(64) not null unique,complaint_no varchar(64),enterprise_code varchar(64),district_code varchar(64),deleted tinyint default 0,source_payload json,edit_version bigint default 1,status varchar(64),closed_in_system tinyint default 0,supervision_status varchar(64),reporting_status varchar(64)) engine=InnoDB default charset=utf8mb4');
  await require('../migrations/20261009120000__location_correction_group.js').up(db);
  for(const sql of ['create table dispatch_order(assignment_id varchar(64),complaint_id varchar(64))','create table analysis_record(analysis_id varchar(64),complaint_id varchar(64))','create table business_event(event_id varchar(64),source_business_id varchar(64))'])await db.raw(sql+' engine=InnoDB');
  await require('../migrations/20261009030000__account_role_permissions.js').up(db);await require('../migrations/20261009040000__user_object_scopes.js').up(db);await prepareGridAuditFixture(db);
  await db('app_user').insert({user_id:'legacy',username:'legacy',password_hash:'synthetic',real_name:'Synthetic',roles:'["admin"]',permissions:'[]',must_change_password:0});
  await require('../migrations/20261009130000__account_identity_type.js').up(db);await require('../migrations/20261009130001__manual_complaint_followups.js').up(db);
  assert.equal((await db('app_user').where('user_id','legacy').first()).account_type,'unknown');
  for(const [id,role,type,scope] of [['owner','handler','enterprise',[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}]],['other','handler','internal',[{kind:'all'}]],['supervisor','admin','internal',[{kind:'all'}]],['enterprise','admin','enterprise',[{kind:'all'}]],['unknown','admin','unknown',[{kind:'all'}]],['viewer','readonly','internal',[{kind:'all'}]]] as const)await db('app_user').insert({user_id:id,username:id,password_hash:'synthetic',real_name:id,roles:JSON.stringify([role]),permissions:'[]',account_type:type,must_change_password:0,scope_rules:JSON.stringify(scope)});
  await db('complaint').insert([{complaint_id:'C1',complaint_no:'NO1',enterprise_code:'E1',district_code:'D1',source_payload:JSON.stringify({metadata:{'坐席满意度':'满意','前台备注':'13800001234'},phone:'13800001234'}),status:'open',supervision_status:'none',reporting_status:'not_started'}, {complaint_id:'C2',complaint_no:'NO2',enterprise_code:'E2',district_code:'D2'}]);
  const {pool}=await import('../src/db/pool');close=()=>pool.end();const service=await import('../src/services/followupService');const {createApp}=await import('../src/app');const app=createApp();
  const token=(id:string)=>jwt.sign({sub:id,username:id,sessionVersion:1},process.env.GQXQ_JWT_SECRET!);
  const call=(id:string,method:'get'|'post'|'patch',path:string,body?:unknown)=>request(app)[method]('/api/v1'+path).set('Authorization','Bearer '+token(id)).send(body);
  const facts={contacted:false,occurredAt:'2026-10-09T08:30:00+08:00',evaluationCode:null,dissatisfactionReason:null,notes:'Synthetic call'};
  let f1:any;
  await t.test('real HTTP create/retry/concurrent uniqueness, payload conflict and immutable source/state',async()=>{
   const original=await db('complaint').where('complaint_id','C1').first();
   const pair=await Promise.all([call('owner','post','/complaints/NO1/followups',{...facts,requestId:'one'}),call('owner','post','/complaints/C1/followups',{...facts,requestId:'one'})]);
   assert.ok(pair.every(r=>r.status===200),JSON.stringify(pair.map(r=>r.body)));f1=pair[0].body.data;assert.equal(pair[1].body.data.followupId,f1.followupId);assert.equal(f1.complaintId,'C1');assert.equal(f1.ownerId,'owner');
   assert.equal((await db('manual_followup')).length,1);assert.equal((await db('manual_followup_revision')).length,1);assert.equal((await db('operation_audit_log').where('action','FOLLOWUP_CREATE')).length,1);
   assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,notes:'changed',requestId:'one'})).status,409);
   assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,contacted:true,evaluationCode:'dissatisfied',requestId:'bad'})).status,400);
   const second=await call('owner','post','/complaints/C1/followups',{...facts,contacted:true,evaluationCode:'dissatisfied',dissatisfactionReason:'未解决',requestId:'two'});assert.equal(second.status,200);
   const list=await call('owner','get','/complaints/C1/followups');assert.equal(list.status,200);assert.equal(list.body.data.records.length,2);assert.equal(list.body.data.formalEvaluation.state,'unavailable');assert.equal(JSON.stringify(list.body.data).includes('13800001234'),false);assert.equal(list.body.data.sourceEvaluation.label,'满意');
   assert.deepEqual(await db('complaint').where('complaint_id','C1').first(),original);
  });
  await t.test('owner revisions preserve history and independently authorized conclusions cannot be forged',async()=>{
   const revised={...facts,contacted:true,evaluationCode:'satisfied',expectedVersion:1,reason:'核实更正',requestId:'same'};
   assert.equal((await call('other','patch','/followups/'+f1.followupId,revised)).status,403);
   assert.equal((await call('owner','patch','/followups/'+f1.followupId,{...revised,conclusion:'forged'})).status,400);
   const r=await call('owner','patch','/followups/'+f1.followupId,revised);assert.equal(r.status,200);assert.equal(r.body.data.version,2);
   assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,requestId:'one'})).body.data.version,1,'create replay returns original result');
   const input={expectedVersion:2,requestId:'same',conclusion:'主管核实事实',reason:'核对依据'};
   for(const actor of ['enterprise','unknown','viewer','owner'])assert.equal((await call(actor,'patch','/followups/'+f1.followupId+'/conclusion',input)).status,403,actor);
   const c=await call('supervisor','patch','/followups/'+f1.followupId+'/conclusion',input);assert.equal(c.status,200);assert.equal(c.body.data.version,3);assert.equal(c.body.data.evaluationCode,'satisfied');
   assert.equal((await call('supervisor','patch','/followups/'+f1.followupId+'/conclusion',input)).body.data.version,3);
   const stale=await call('owner','patch','/followups/'+f1.followupId,{...revised,requestId:'stale'});assert.equal(stale.status,409);
   const next=await call('owner','patch','/followups/'+f1.followupId,{...revised,expectedVersion:3,requestId:'next',notes:'new note'});assert.equal(next.status,200);assert.equal(next.body.data.conclusion,'主管核实事实');
   const list=(await call('owner','get','/complaints/C1/followups')).body.data;assert.deepEqual(list.history.filter((r:any)=>r.followupId===f1.followupId).map((r:any)=>r.version),[1,2,3,4]);
   const conflict=await Promise.all(['a','b'].map(requestId=>call('owner','patch','/followups/'+f1.followupId,{...revised,expectedVersion:4,requestId})));assert.deepEqual(conflict.map(r=>r.status).sort(),[200,409]);
  });
  await t.test('current identity, capability and scope changes apply to old tokens and idempotent replay',async()=>{
   const users=await import('../src/services/userService');const ctx={userId:'supervisor',userName:'supervisor',clientIp:null};
   const oldVersion=(await db('platform_authorization_state').first()).version;
   const changed=await users.updateUserByAdmin('supervisor',{accountType:'enterprise'},ctx);assert.ok(changed.changed.includes('accountType'));assert.ok(Number((await db('platform_authorization_state').first()).version)>Number(oldVersion));
   assert.equal((await call('supervisor','patch','/followups/'+f1.followupId+'/conclusion',{expectedVersion:2,requestId:'same',conclusion:'主管核实事实',reason:'核对依据'})).status,403);
   await users.updateUserByAdmin('supervisor',{accountType:'internal'},ctx);
   const scope=await users.getUserScope('owner');await users.updateUserScope('owner',[{kind:'restricted',enterpriseCodes:['E2'],districtCodes:[]}],scope.scopeVersion,ctx);
   assert.equal((await call('owner','get','/complaints/C1/followups')).status,404);assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,requestId:'one'})).status,404);
   assert.equal((await call('owner','patch','/followups/'+f1.followupId,{...facts,requestId:'outside',expectedVersion:5,reason:'test'})).status,404);
   await users.updateUserScope('owner',[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],scope.scopeVersion+1,ctx);
   const roles=await import('../src/services/roleService');const role=(await roles.getRoles()).find(r=>r.roleCode==='handler')!;
   await roles.writeRole('handler',{expectedVersion:role.version,permissionCodes:role.permissionCodes.filter(p=>p!=='followup.create')},false,ctx);
   assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,requestId:'one'})).status,403);
   await require('../migrations/20261009130001__manual_complaint_followups.js').up(db);
   assert.equal((await roles.resolveAuthorization('owner')).permissionCodes.includes('followup.create'),false,'migration replay must not regrant');
   await roles.writeRole('handler',{expectedVersion:role.version+1,permissionCodes:role.permissionCodes},false,ctx);
   const created=await users.createUser({username:'new-c3',realName:'Synthetic',role:'handler',password:'Synthetic-Pass-123'},ctx);assert.equal(created.accountType,'unknown');
   assert.equal((await call('supervisor','get','/auth/user-info')).body.data.accountType,'internal');
  });
  await t.test('authorization change wins before transaction lock: actual SQL read rejects stale authenticated context',async()=>{
   const users=await import('../src/services/userService');const {runWithAccessContext}=await import('../src/auth/accessScope');
   await assert.rejects(()=>service.getFollowups('C1',{userId:'supervisor'}),{status:403},'missing authenticated ALS must not become all-scope');
   const originalGet=pool.getConnection.bind(pool);let entered!:()=>void;let release!:()=>void;const started=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);let claimed=false;
   pool.getConnection=(async()=>{const conn=await originalGet();if(claimed)return conn;claimed=true;const originalQuery=conn.query.bind(conn);const originalRelease=conn.release.bind(conn);
    conn.query=(async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].includes('platform_authorization_state')&&args[0].includes('for update')){entered();await gate;}return (originalQuery as any)(...args);}) as any;
    conn.release=()=>{conn.query=originalQuery as any;conn.release=originalRelease;originalRelease();};return conn;
   }) as any;
   const ctx={userId:'supervisor',userName:'supervisor',clientIp:null};
   try{
    const attempt=runWithAccessContext({userId:'supervisor',roles:['admin'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false},()=>service.concludeFollowup(f1.followupId,{expectedVersion:5,requestId:'stale-identity',conclusion:'must not persist',reason:'test'},ctx));
    await started;await users.updateUserByAdmin('supervisor',{accountType:'enterprise'},ctx);release();await assert.rejects(()=>attempt,{status:403});
    assert.equal((await db('manual_followup_revision').where('conclusion','must not persist')).length,0);await users.updateUserByAdmin('supervisor',{accountType:'internal'},ctx);
   }finally{release();pool.getConnection=originalGet;}
  });
  await t.test('operation-bound retry namespaces and custom conclude-only capability remain independent',async()=>{
   const sameKey=await call('owner','patch','/followups/'+f1.followupId,{...facts,expectedVersion:5,requestId:'one',reason:'更正未接通事实'});assert.equal(sameKey.status,200);assert.equal(sameKey.body.data.version,6);
   assert.equal((await call('owner','post','/complaints/C1/followups',{...facts,requestId:'one'})).body.data.version,1);
   const ctx={userId:'supervisor',userName:'supervisor',clientIp:null};const roles=await import('../src/services/roleService');const users=await import('../src/services/userService');
   await roles.writeRole('concluder',{expectedVersion:0,name:'合成主管',permissionCodes:['complaint.read','followup.conclude']},true,ctx);await users.updateUserByAdmin('other',{role:'concluder',accountType:'internal'},ctx);
   const result=await call('other','patch','/followups/'+f1.followupId+'/conclusion',{expectedVersion:6,requestId:'one',conclusion:'独立主管补充',reason:'人工核实'});assert.equal(result.status,200);assert.equal(result.body.data.version,7);assert.equal(result.body.data.evaluationCode,null);
   assert.equal((await call('other','post','/complaints/C1/followups',{...facts,requestId:'one'})).status,403);
   const persisted=(await call('owner','get','/complaints/C1/followups')).body.data;const {selectCandidateEvaluations}=await import('../src/domain/followup');
   assert.equal(selectCandidateEvaluations(persisted.history).records.length,1);assert.equal(persisted.formalEvaluation.state,'unavailable');
  });
  await t.test('followup audit linkage uses actual followup key even with complaint-key collisions, safe account audit',async()=>{
   const audit=await import('../src/services/auditQueryService');const access={userId:'supervisor',permissionCodes:['system.audit.read'],roles:['admin'],scopeVersion:1,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false};
   await db('complaint').insert({complaint_id:f1.followupId,complaint_no:'COLLISION',enterprise_code:'E2',district_code:'D2'});
   const list=await audit.auditQueryService.list({module:'manual_followup',businessNo:'NO1'},{page:1,size:100},access);assert.ok(list.total>=5);assert.ok(list.content.every(r=>r.businessNo==='NO1'));assert.equal(JSON.stringify(list).includes('主管核实事实'),false);
   const outside={...access,rules:[{kind:'restricted' as const,enterpriseCodes:['E2'],districtCodes:[]}]};
   assert.equal((await audit.auditQueryService.list({module:'manual_followup'},{page:1,size:100},outside)).total,0);
   await assert.rejects(()=>audit.auditQueryService.detail(list.content[0].auditId,outside),{status:404});
   const u=await audit.auditQueryService.list({action:'USER_UPDATE'},{page:1,size:100},access);assert.ok(u.content.some(r=>(r.detail?.after as any)?.accountType==='enterprise'));
  });
  await t.test('fresh child process reads persisted followup heads/history with no inherited memory',async()=>{
   const reopened=spawnSync(process.execPath,[require.resolve('tsx/cli'),'--eval',`import {getFollowups} from './src/services/followupService'; import {pool} from './src/db/pool'; import {runWithAccessContext} from './src/auth/accessScope'; runWithAccessContext({userId:'supervisor',roles:[],scopeVersion:0,rules:[],canReadSource:false},()=>getFollowups('C1',{userId:'supervisor'})).then(v=>{if(v.records.length!==2||v.history.length<6)throw Error('Persisted history missing'); console.log('C3_FRESH_PROCESS_PERSISTENCE_OK');}).finally(()=>pool.end());`],{cwd:process.cwd(),env:process.env,encoding:'utf8',windowsHide:true});
   assert.equal(reopened.status,0,reopened.stderr);assert.match(reopened.stdout,/C3_FRESH_PROCESS_PERSISTENCE_OK/);
  });
  await t.test('migration preflight rejects incompatible identity column without schema/data mutation',async()=>{
   await db.raw('alter table app_user modify account_type varchar(16) null');
   await assert.rejects(()=>require('../migrations/20261009130000__account_identity_type.js').up(db),/incompatible/);
   await db.raw("alter table app_user modify account_type varchar(16) not null default 'unknown'");
   await require('../migrations/20261009130000__account_identity_type.js').up(db);
  });
  await t.test('standalone real schema export preflights every existing table before creating a missing first table',async()=>{
   const originalCount=(await db('manual_followup_revision').count('* as n').first()).n;
   await db.raw('rename table manual_followup to c3_saved_followup');
   try{await db.raw('alter table manual_followup_revision modify notes varchar(1000) null');
    await assert.rejects(()=>require('../migrations/20261009130001__manual_complaint_followups.js').ensureFollowupTables(db),/incompatible/);
    assert.equal(await db.schema.hasTable('manual_followup'),false);assert.equal((await db('manual_followup_revision').count('* as n').first()).n,originalCount);
   }finally{await db.raw('alter table manual_followup_revision modify notes varchar(2000) null');await db.raw('rename table c3_saved_followup to manual_followup');}
  });
  await t.test('prefix unique request identity is rejected by helper and production up before any owned DDL or seed',async()=>{
   const migrate=require('../migrations/20261009130001__manual_complaint_followups.js');
   const governance=async()=>JSON.stringify({permissions:await db('platform_permission').orderBy('permission_code'),grants:await db('platform_role_permission').orderBy(['role_code','permission_code']),roles:await db('platform_role').orderBy('role_code'),state:await db('platform_authorization_state').orderBy('id')});const before=await governance();
   const requests=JSON.stringify(await db('manual_followup_request').orderBy(['owner_id','complaint_id','operation','request_id']));
   await db.raw('alter table manual_followup_request drop primary key, add unique key uk_c3_prefix(owner_id,complaint_id,operation,request_id(8))');
   await db.raw('rename table manual_followup to c3_saved_followup');
   try{const [indexes]=await db.raw('show index from manual_followup_request');assert.ok(indexes.some(row=>row.Column_name==='request_id'&&Number(row.Sub_part)===8));
    for(const check of [migrate.ensureFollowupTables,migrate.up]){await assert.rejects(()=>check(db),/C3 incompatible key manual_followup_request/);assert.equal(await db.schema.hasTable('manual_followup'),false,'reject before creating missing first owned table');assert.equal(await governance(),before,'reject before capability/grant/version seed');assert.equal(JSON.stringify(await db('manual_followup_request').orderBy(['owner_id','complaint_id','operation','request_id'])),requests);}
   }finally{await db.schema.dropTableIfExists('manual_followup');await db.raw('rename table c3_saved_followup to manual_followup');await db.raw('alter table manual_followup_request drop index uk_c3_prefix, add primary key(owner_id,complaint_id,operation,request_id)');}
  });
 }finally{if(close)await close();await db.destroy();}
});
