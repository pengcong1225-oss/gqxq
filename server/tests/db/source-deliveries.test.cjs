const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {createHmac}=require('node:crypto');const knex=require('knex');const express=require('express');const request=require('supertest');

// Run with tsx so application TypeScript is loaded ONLY after the isolated env.
test('signed process and followup delivery against full-chain isolated MySQL',{skip:process.env.GQXQ_ISOLATED_MIGRATION_TEST!=='1'},async t=>{
 const connection={host:'127.0.0.1',port:13317,user:'root',password:''};
 const admin=knex({client:'mysql2',connection,pool:{min:0,max:1}});let db,closePool;
 try{
  const [[server]]=await admin.raw('select @@port as port,@@datadir as datadir');assert.equal(Number(server.port),13317);assert.match(String(server.datadir).replaceAll('\\','/'),/gqxq-merge-mysql-20261111\/data\/$/);
  const database='gqxq_merge_source_'+process.pid+'_test';await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);
  db=knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1},migrations:{directory:path.join(__dirname,'../../migrations'),disableTransactions:true}});
  await db.raw(fs.readFileSync(path.join(__dirname,'../fixtures/external-baseline-ddl.sql'),'utf8'));const [,migrations]=await db.migrate.latest();assert.equal(migrations.length,fs.readdirSync(path.join(__dirname,'../../migrations')).filter(f=>f.endsWith('.js')).length);
  // Do not load .env or let any inherited operational credentials/settings leak
  // into application imports. This child test process owns its environment.
  for(const key of Object.keys(process.env))if(key.startsWith('GQXQ_')||key.startsWith('DOTENV_CONFIG_'))delete process.env[key];
  Object.assign(process.env,{DOTENV_CONFIG_PATH:path.join(__dirname,'__intentionally_absent_test_env__'),NODE_ENV:'test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'13317',GQXQ_DB_USER:'root',GQXQ_DB_PASSWORD:'',GQXQ_DB_NAME:database,GQXQ_JWT_SECRET:'synthetic-test-signing-key-at-least-32-characters',GQXQ_PU_DELIVERY_WORKER_ENABLED:'false'});
  const config={sourceId:'synthetic-feed',sourceSystem:'SYNTHETIC',keyId:'test-key',secret:'synthetic-hmac-secret-only-for-this-test-123',maxSkewSeconds:300,complaintTargets:[{sourceSystem:'SYNTHETIC',enterpriseCodes:['E-ALLOWED']}]};
  process.env.GQXQ_BUSINESS_SOURCES_JSON=JSON.stringify([config]);
  const {env}=require('../../src/config/env');const {sourceDeliveryRouter}=require('../../src/routes/sourceDeliveries');
  const {getSourceProcesses}=require('../../src/services/sourceProcessService');const {businessEventService}=require('../../src/services/businessEventService');const {runWithAccessContext}=require('../../src/auth/accessScope');const {findByIdOrNo}=require('../../src/repositories/complaintRepo');const {projectComplaintDetail}=require('../../src/services/complaintProjection');
  closePool=require('../../src/db/pool').closePool;
  const app=express();app.use(express.json({verify:(req,res,body)=>{req.rawBody=Buffer.from(body);}}));app.use('/source',sourceDeliveryRouter);app.use((error,req,res,next)=>res.status(error.status||500).json({message:error.message,errorCode:error.errorCode}));
  const post=(endpoint,body,overrides={})=>{const raw=JSON.stringify(body),stamp=new Date().toISOString(),signature=createHmac('sha256',config.secret).update(stamp+'\n').update(raw).digest('hex');return request(app).post('/source/'+endpoint).set({'content-type':'application/json','x-source-id':config.sourceId,'x-key-id':config.keyId,'x-source-timestamp':stamp,'x-source-signature':signature,...overrides}).send(raw);};
  for(const [id,enterprise] of [['C-A','E-ALLOWED'],['C-B','E-ALLOWED'],['C-X','E-DENIED']])await db('complaint').insert({complaint_id:id,complaint_no:'N-'+id,source_system:'SYNTHETIC',source_id:'S-'+id,title:'Synthetic delivery fixture',business_type:'water',complaint_type:'complaint',urgency_level:'normal',enterprise_code:enterprise,source_payload:JSON.stringify({metadata:{'规定完成时间':'2026-01-01 12:00:00','实际完成时间':'2026-01-02 12:00:00'}})});
  const access=(enterprise='E-ALLOWED',canReadSource=false)=>({userId:'synthetic-reader',roles:['readonly'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:[enterprise],districtCodes:[]}],canReadSource});
  const ctx=(enterprise='E-ALLOWED',canReadSource=false)=>({userId:'synthetic-reader',userName:'Synthetic',clientIp:null,permissionCodes:['complaint.read'],access:access(enterprise,canReadSource)});
  const node=(v)=>({sourceSystem:'SYNTHETIC',sourceId:'S-C-A',nodeId:'N1',sourceSequence:1,sourceVersion:String(v),occurredAt:'2026-11-01T01:00:00.000Z',stage:'Synthetic stage '+v,department:'Synthetic department',contactName:'Synthetic Contact '+v,contactPhone:'TEST-PHONE-'+v,opinion:'Synthetic opinion'});
  const processBody=(version)=>({sourceSystem:'SYNTHETIC',sourceId:'S-C-A',sourceVersion:version,cutoffAt:'2026-11-02T01:00:00.000Z',complete:true,deadlineAt:'2026-11-03T01:00:00.000Z',completedAt:'2026-11-02T01:00:00.000Z',nodes:[node(version)]});
  await t.test('HTTP rejects unsigned/unconfigured sources and target enterprise escalation',async()=>{
   assert.equal((await post('processes',processBody(1),{'x-source-signature':'0'.repeat(64)})).status,401);
   const saved=env.businessSources;env.businessSources='[]';assert.equal((await post('processes',processBody(1))).status,401);env.businessSources=saved;
   const denied={...processBody(1),sourceId:'S-C-X',nodes:[{...node(1),sourceId:'S-C-X'}]};assert.equal((await post('processes',denied)).status,403);
   assert.equal(Number((await db('source_process_stream').count('* as n').first()).n),0);
  });
  await t.test('process revisions are monotonic, idempotent, scoped and fully masked',async()=>{
   const imported=await runWithAccessContext(access(),()=>findByIdOrNo('C-A'));assert.equal(projectComplaintDetail(imported,access()).sourceDeadlineAt,'2026-01-01T04:00:00.000Z');assert.equal(projectComplaintDetail(imported,access()).sourceCompletedAt,'2026-01-02T04:00:00.000Z');
   let res=await post('processes',processBody(1));assert.equal(res.status,200,JSON.stringify(res.body));assert.equal(res.body.data.result,'updated');
   res=await post('processes',processBody(1));assert.equal(res.body.data.result,'duplicate');
   res=await post('processes',processBody(0));assert.equal(res.body.data.result,'stale');
   res=await post('processes',{...processBody(1),deadlineAt:null});assert.equal(res.status,409);
   assert.equal(Number((await db('source_process_revision').count('* as n').first()).n),1);
   const original=await runWithAccessContext(access(),()=>findByIdOrNo('C-A'));assert.equal(projectComplaintDetail(original,access()).sourceDeadlineAt,'2026-11-03T01:00:00.000Z');
   res=await post('processes',{...processBody(2),deadlineAt:null,completedAt:null});assert.equal(res.status,200,JSON.stringify(res.body));
   const current=await runWithAccessContext(access(),()=>findByIdOrNo('C-A')),projection=projectComplaintDetail(current,access());assert.equal(projection.sourceDeadlineAt,null);assert.equal(projection.sourceCompletedAt,null);assert.ok(current.source_process_received_at);
   const redacted=await runWithAccessContext(access(),()=>getSourceProcesses('C-A'));assert.equal(redacted.revisions.length,2);assert.equal(redacted.nodes.length,1);
   for(const n of [...redacted.nodes,...redacted.revisions]){assert.equal(n.contactName,'已脱敏');assert.equal(n.contactPhone,'已脱敏');}
   const full=await runWithAccessContext(access('E-ALLOWED',true),()=>getSourceProcesses('C-A'));assert.equal(full.nodes[0].contactName,'Synthetic Contact 2');assert.equal(full.revisions[0].contactPhone,'TEST-PHONE-1');
   await assert.rejects(runWithAccessContext(access('E-DENIED'),()=>getSourceProcesses('C-A')),e=>e.status===404);
   assert.equal((await db('source_process_stream').where('complaint_id','C-A').first()).ingress_version,2);
  });
  const followup=(version,complaintId='C-A')=>({sourceId:config.sourceId,kind:'followup',sourceObjectId:'FOLLOWUP-1',sourceVersion:version,sourceUpdatedAt:'2026-11-02T01:00:00.000Z',enterpriseCode:'E-DENIED',districtCode:null,payload:{complaintId,occurredAt:'2026-11-02T01:00:00.000Z',contacted:true,evaluation:'satisfied',operatorName:'Synthetic Operator '+version,notes:'Synthetic private notes '+version}});
  await t.test('followup binding is trusted, immutable and current-complaint scoped; all history masked',async()=>{
   assert.equal((await post('events',followup(1),{'x-source-signature':'0'.repeat(64)})).status,401);
   const saved=env.businessSources;env.businessSources='[]';assert.equal((await post('events',followup(1))).status,401);env.businessSources=saved;
   assert.equal((await post('events',followup(1,'C-X'))).status,403);
   let res=await post('events',followup(1));assert.equal(res.status,200,JSON.stringify(res.body));const id=res.body.data.id;assert.equal(res.body.data.result,'new');
   const stored=await db('source_business_head').where('event_id',id).first(),binding=typeof stored.followup_binding==='string'?JSON.parse(stored.followup_binding):stored.followup_binding;
   assert.equal(binding.enterpriseCode,'E-ALLOWED');assert.equal(binding.complaintId,'C-A');assert.equal(binding.sourceId,config.sourceId);assert.equal(binding.sourceObjectId,'S-C-A');
   res=await post('events',followup(1));assert.equal(res.body.data.result,'duplicate');
   res=await post('events',followup(0));assert.equal(res.body.data.result,'stale');
   assert.equal((await post('events',{...followup(1),payload:{...followup(1).payload,notes:'Changed same version'}})).status,409);
   assert.equal((await post('events',followup(2,'C-B'))).status,409);
   res=await post('events',followup(2));assert.equal(res.status,200,JSON.stringify(res.body));
   const detail=await businessEventService.detail('followup',id,ctx());assert.equal(detail.history.length,2);for(const record of [detail,...detail.history]){assert.equal(record.payload.operatorName,'已脱敏');assert.equal(record.payload.notes,null);}
   const full=await businessEventService.detail('followup',id,ctx('E-ALLOWED',true));assert.equal(full.payload.operatorName,'Synthetic Operator 2');assert.equal(full.history[1].payload.notes,'Synthetic private notes 1');
   assert.equal((await businessEventService.list('followup',{},ctx())).total,1);assert.equal((await businessEventService.list('followup',{},ctx('E-DENIED'))).total,0);
   await assert.rejects(businessEventService.detail('followup',id,ctx('E-DENIED')),e=>e.status===404);
   await db('complaint').where('complaint_id','C-A').update({enterprise_code:'E-MOVED'});
   assert.equal((await businessEventService.list('followup',{},ctx())).total,0);await assert.rejects(businessEventService.detail('followup',id,ctx()),e=>e.status===404);
   assert.equal((await businessEventService.list('followup',{},ctx('E-MOVED'))).total,1);
   assert.equal((await businessEventService.detail('followup',id,ctx('E-MOVED'))).history.length,2);
   await db('complaint').where('complaint_id','C-A').update({deleted:1});assert.equal((await businessEventService.list('followup',{},ctx('E-MOVED'))).total,0);
   assert.equal(Number((await db('source_business_revision').where('event_id',id).count('* as n').first()).n),2);
  });
  console.log('SOURCE DELIVERY DB VERIFIED',database);
 }finally{if(closePool)await closePool();if(db)await db.destroy();await admin.destroy();}
});
