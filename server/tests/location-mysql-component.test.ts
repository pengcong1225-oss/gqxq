import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import express from 'express';
import request from 'supertest';
const require=createRequire(import.meta.url);
const json=(value:any)=>typeof value==='string'?JSON.parse(value):value;
test('C2 real SQL location-group component on explicitly declared legacy contract',{skip:process.env.GQXQ_C2_COMPONENT_DB!=='gqxq_c2_contract_test'},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_c2_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_c2_contract_test'}});let close:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_c2_contract_test');
  assert.equal(existsSync(new URL('../migrations/20261009120000__location_correction_group.js',import.meta.url)),true,'C2 location-group migration missing');
  for(const name of ['service_grid_community','service_grid_admin','service_grid_revision','community','admin_grid','grid_enterprise','service_grid','enterprise','complaint_location_clue','complaint_address_candidate','sensitive_hit','report_todo','analysis_record','correction_item','dispatch_order','business_event','complaint_category_revision','dictionary_version','dictionary_code_registry','dict_type','dict_item','complaint_field_version','complaint_source_log','number_sequence','operation_audit_log','app_user','complaint'])await db.schema.dropTableIfExists(name);
  // Declared synthetic pre-M2 fixture, not a production/canonical schema assertion.
  await db.raw(`create table complaint(id bigint unsigned auto_increment primary key,complaint_id varchar(64) not null unique,complaint_no varchar(64),source_system varchar(64),source_id varchar(128),title varchar(256),content text,business_type varchar(64),complaint_type varchar(64),urgency_level varchar(64),status varchar(64),is_sensitive tinyint,sensitive_keywords varchar(500),district_code varchar(64),district_name varchar(128),address varchar(500),corrected_address varchar(500),location_lng decimal(12,6),location_lat decimal(12,6),correction_status varchar(64),enterprise_code varchar(64),enterprise_name varchar(128),grid_code varchar(64),sync_status varchar(64),received_at datetime,closed_at datetime,created_at datetime,updated_at datetime,deleted tinyint default 0) engine=InnoDB default charset=utf8mb4`);
  await db.raw('create table dict_type(id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dict_item(id bigint auto_increment primary key,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dispatch_order(id bigint auto_increment primary key,assignment_id varchar(64),complaint_id varchar(64),active_complaint_id varchar(64) unique,status varchar(64),reporting_task_id varchar(64)) engine=InnoDB');
  await db.raw('create table business_event(event_id varchar(64),source_business_id varchar(64),task_id varchar(64),event_type varchar(64),payload json,id bigint auto_increment primary key) engine=InnoDB');
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,business_type varchar(64),district_code varchar(64) null) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_pair(grid_code,enterprise_code)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table enterprise(enterprise_code varchar(64) primary key,enterprise_name varchar(128),business_type varchar(64),status varchar(16),version bigint, district_code varchar(64)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table sensitive_hit(id bigint auto_increment primary key,complaint_id varchar(64),dict_item_id varchar(64),keyword varchar(128),matched_field varchar(64),rule_version varchar(64),matched_at datetime) engine=InnoDB');
  for(const file of ['20260917100100__m1_g1_new_tables.js','20260917100200__m2_complaint_g1_columns.js','20260917100400__m4_correction_confidence.js','20260917100800__m8_g5_correction_analysis_report.js','20260917101100__m11_complaint_overtime_flag.js','20260917101200__m12_address_candidate.js','20260924100000__m13_location_clues.js','20261009010000__effective_field_protection.js','20261009070000__dictionary_governance_categories.js'])await require('../migrations/'+file).up(db);
  await db('enterprise').insert({enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',status:'enabled',version:1,district_code:'D2'});
  await require('../migrations/20261009090000__service_grid_coverage.js').up(db);await require('../migrations/20261009100001__service_grid_registration.js').up(db);
  await require('../migrations/20261009120000__location_correction_group.js').up(db);await require('../migrations/20261009120000__location_correction_group.js').up(db);
  await db('dict_type').insert({dict_type:'district',dict_name:'合成区划',status:'enabled',version:1,published:1});
  await db('dict_item').insert([{item_id:'D1',dict_type:'district',item_value:'D1',item_label:'合成区甲',status:'enabled',version:1,published:1},{item_id:'D2',dict_type:'district',item_value:'D2',item_label:'合成区乙',status:'enabled',version:1,published:1}]);
  await db('admin_grid').insert([{code:'A1',name:'同名行政网格',district_code:'D1',version:1},{code:'A2',name:'同名行政网格',district_code:'D2',version:1}]);
  await db('community').insert([{code:'X1',name:'同名小区',admin_grid_code:'A1',version:1},{code:'X2',name:'同名小区',admin_grid_code:'A2',version:1}]);
  const polygon={type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]]]};
  const coverage={code:'G1',serviceGridCode:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:['X1'],version:'1',validFrom:'2026-01-01',validTo:null,geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A1'},geometry:polygon}]},coordinateSystem:'WGS84',geometrySources:['合成授权资料'],coverageState:'maintained'};
  await db('service_grid').insert({grid_code:'G1',grid_name:'合成服务网格',business_type:'water',version:1,import_state:'legacy'});await db('grid_enterprise').insert({grid_code:'G1',enterprise_code:'E1'});
  await db('service_grid_revision').insert({grid_code:'G1',version:1,valid_from:'2026-01-01',snapshot:JSON.stringify(coverage),operator_id:'synthetic',created_at:new Date()});await db('service_grid_admin').insert({grid_code:'G1',version:1,admin_grid_code:'A1'});await db('service_grid_community').insert({grid_code:'G1',version:1,community_code:'X1'});
  const {pool}=await import('../src/db/pool');close=()=>pool.end();const service=await import('../src/services/correctionService');const {runWithAccessContext}=await import('../src/auth/accessScope');
  const access={userId:'synthetic',roles:['custom'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
  const ctx={userId:'synthetic',userName:'Synthetic',clientIp:null,permissionCodes:['complaint.correct','complaint.read'],access};
  const scoped={...ctx,access:{...access,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:['D1']}]}};
  const clock=()=>new Date('2026-10-08T16:00:00Z');const input=(id:string,extra:any={})=>({complaintId:id,expectedVersion:1,districtCode:'D1',address:'人工地址B',longitude:1,latitude:1,adminGridCode:'A1',communityCode:'X1',coordinateSystem:'WGS84',coordinateSource:'操作者声明：合成WGS84记录',basis:'合成核对依据',...extra});
  const seed=async(id:string,extra:any={})=>{
   await db('complaint').insert({complaint_id:id,complaint_no:'LOCAL-'+id,source_system:'synthetic',source_id:id,title:'合成标题',content:'合成正文',address:'来源地址A',district_code:'D1',district_name:'旧合成名称',location_lng:0,location_lat:0,enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',complaint_type:'other',received_at:'2026-10-09 08:00:00',source_payload_hash:'old-hash',...extra});
   await db('correction_item').insert(['district_name','address','location_lng','location_lat','summary'].map(field=>({correction_id:id+'-'+field,complaint_id:id,field_name:field,status:'pending',old_value:'old'})));
  };
  const save=(id:string,extra:any={},actor:any=ctx)=>runWithAccessContext(actor.access,()=>service.confirmLocationGroup(input(id,extra),actor,clock));
  const snapshot=async(id:string)=>({row:await db('complaint').where('complaint_id',id).first(),items:await db('correction_item').where('complaint_id',id).orderBy('id'),versions:await db('complaint_field_version').where('complaint_id',id).orderBy('id'),audits:await db('operation_audit_log').where({biz_id:id}).orderBy('id'),analysis:await db('analysis_record').where('complaint_id',id)});
  await t.test('one version settles the four related fields and protects complete group with proven coverage',async()=>{
   await seed('atomic');const result=await save('atomic');assert.equal(result.version,2);assert.equal(result.validationDate,'2026-10-09');assert.equal(result.spatialStatus,'verified');assert.equal(result.analysisEntered,false);
   const after=await snapshot('atomic');assert.equal(after.row.address,'人工地址B');assert.equal(after.row.district_name,'合成区甲');assert.equal(after.row.admin_grid_code,'A1');assert.equal(after.row.community_code,'X1');assert.equal(after.row.location_coordinate_system,'WGS84');assert.equal(after.row.edit_version,2);assert.equal(after.items.filter((i:any)=>i.status==='confirmed').length,4);assert.equal(after.items.find((i:any)=>i.field_name==='summary').status,'pending');
   const state=json(after.row.effective_field_state);for(const name of ['district_code','district_name','address','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source'])assert.equal(state[name].resolution,'confirmed');
   assert.deepEqual(result.coverageEvidence.map((e:any)=>[e.code,e.version]),[['G1','1']]);assert.equal(after.audits.filter((a:any)=>a.action==='CORRECTION_LOCATION_GROUP').length,1);
  });
  await t.test('stale A1 version, invalid relationships and proposed/current scope deny without writes',async()=>{
   await seed('denied');const before=await snapshot('denied');
   for(const patch of [{expectedVersion:9},{communityCode:'X2'},{districtCode:'D2'},{longitude:99}])await assert.rejects(()=>save('denied',patch));
   await assert.rejects(()=>save('denied',{districtCode:'D2',adminGridCode:'A2',communityCode:'X2',coordinateSystem:'unknown'},scoped),{status:404});
   await assert.rejects(()=>save('denied',{}, {...ctx,access:{...access,rules:[]}}),{status:404});assert.deepEqual(await snapshot('denied'),before);
  });
  await t.test('a late audit failure rolls back fields, decisions, history and shared version',async()=>{
   await seed('rollback');const before=await snapshot('rollback');await db.raw("create trigger c2_fail_audit before insert on operation_audit_log for each row begin if new.action='CORRECTION_LOCATION_GROUP' and new.biz_id='rollback' then signal sqlstate '45000' set message_text='synthetic late audit failure'; end if; end");
   try{await assert.rejects(()=>save('rollback'),/synthetic late audit failure/);}finally{await db.raw('drop trigger c2_fail_audit');}assert.deepEqual(await snapshot('rollback'),before);
  });
  await t.test('unknown/manual coordinates and explicit null clearing save without fabricated spatial proof',async()=>{
   await seed('unknown');const result=await save('unknown',{longitude:170,coordinateSystem:'unknown',coordinateSource:'天地图候选，坐标系未核实'});assert.equal(result.spatialStatus,'unknown');assert.deepEqual(result.coverageEvidence,[]);
   await seed('clear');await save('clear',{address:null,longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null,adminGridCode:null,communityCode:null,districtCode:null});const row=await db('complaint').where('complaint_id','clear').first();for(const k of ['address','district_code','district_name','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source'])assert.equal(row[k],null);
  });
  await t.test('re-correction preserves old decisions; unchanged completed members retain their decision; all-complete group denies',async()=>{
   await seed('again');await db('correction_item').where({complaint_id:'again',field_name:'address'}).update({status:'confirmed',new_value:'previous decision',basis:'old basis',confirmer_name:'Old'});
   await db('correction_item').where({complaint_id:'again',field_name:'location_lng'}).update({status:'rejected',basis:'keep coordinate',confirmer_name:'Old'});
   await save('again',{longitude:0,latitude:1});const after=await snapshot('again');assert.equal(after.items.find((i:any)=>i.field_name==='location_lng').status,'rejected');assert.equal(after.items.find((i:any)=>i.field_name==='location_lng').confirmer_name,'Old');
   const audit=json(after.audits.find((a:any)=>a.action==='CORRECTION_LOCATION_GROUP').detail);assert.equal(audit.decisions.find((d:any)=>d.fieldName==='address').statusBefore,'confirmed');assert.equal(audit.decisions.find((d:any)=>d.fieldName==='address').basisBefore,'old basis');
   const before=await snapshot('again');await assert.rejects(()=>save('again',{expectedVersion:2,address:'new arbitrary edit'}),(e:any)=>e.errorCode==='INVALID_STATE_TRANSITION');assert.deepEqual(await snapshot('again'),before);
  });
  await t.test('source redelivery preserves manual location and independent source snapshot',async()=>{
   const {intakeAppeal}=await import('../src/services/intakeService');const before=(await snapshot('atomic')).row;
   await intakeAppeal({sourceSystem:'synthetic',sourceId:'atomic',channel:'test',title:'来源标题C',content:'来源正文C',address:'来源地址C',districtCode:'D2',districtName:'来源区乙',longitude:50,latitude:50,explicitBusinessType:'water',explicitComplaintType:'other',explicitUrgencyLevel:null,sourceReportedAt:null,payload:{address:'来源地址C'},payloadHash:'new-hash',warnings:[],remoteIp:null,requestId:null});
   const after=(await snapshot('atomic')).row;for(const k of ['address','district_code','district_name','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source'])assert.equal(after[k],before[k]);assert.equal(json(after.source_fields).address,'来源地址C');
  });
  await t.test('effective-date reads ignore future latest revision, drafts and incomplete geometry',async()=>{
   await db('service_grid').where('grid_code','G1').update({version:2});await db('service_grid_revision').where({grid_code:'G1',version:1}).update({valid_to:'2027-01-01'});await db('service_grid_revision').insert({grid_code:'G1',version:2,valid_from:'2027-01-01',snapshot:JSON.stringify({...coverage,version:'2',validFrom:'2027-01-01',geometry:null}),operator_id:'synthetic',created_at:new Date()});await db('service_grid_admin').insert({grid_code:'G1',version:2,admin_grid_code:'A1'});
   await seed('date');assert.equal((await save('date')).coverageEvidence[0].version,'1');
   await db('service_grid').where('grid_code','G1').update({import_state:'draft'});await seed('draft');assert.equal((await save('draft')).spatialStatus,'unknown');await db('service_grid').where('grid_code','G1').update({import_state:'published'});
   await db('service_grid_revision').where({grid_code:'G1',version:1}).update({snapshot:JSON.stringify({...coverage,geometry:null})});await seed('geometry');assert.equal((await save('geometry',{longitude:99})).spatialStatus,'unknown');await db('service_grid_revision').where({grid_code:'G1',version:1}).update({snapshot:JSON.stringify(coverage)});
  });
  await t.test('options need complaint capability only and preserve same-name authorized IDs without exposing geometry',async()=>{
   await seed('options');const result=await runWithAccessContext(ctx.access,()=>service.locationCorrectionOptions('options',ctx));assert.deepEqual(result.adminGrids.map((v:any)=>v.code),['A1','A2']);assert.equal(result.communities.filter((v:any)=>v.name==='同名小区').length,2);assert.equal(JSON.stringify(result).includes('geometry'),false);
   const limited=await runWithAccessContext(scoped.access,()=>service.locationCorrectionOptions('options',scoped));assert.deepEqual(limited.adminGrids.map((v:any)=>v.code),['A1']);await assert.rejects(()=>service.locationCorrectionOptions('options',{...ctx,permissionCodes:['complaint.read']}),{status:403});
  });
  await t.test('direct API denies revoked custom role; legacy changed single address directs to atomic group',async()=>{
   await seed('api');const {correctionsRouter}=await import('../src/routes/corrections');const {enforceRolePolicy}=await import('../src/middleware/requireRole');const {errorHandler}=await import('../src/middleware/errorHandler');
   const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:'synthetic',username:'Synthetic',roles:['custom'],permissionCodes:req.headers['x-denied']?['complaint.read']:ctx.permissionCodes};req.accessContext=access;runWithAccessContext(access,()=>next());});app.use(enforceRolePolicy(),correctionsRouter,errorHandler);
   assert.equal((await request(app).post('/complaints/api/location-corrections').set('x-denied','yes').send(input('api'))).status,403);assert.equal((await request(app).get('/complaints/api/location-correction-options').set('x-denied','yes')).status,403);
   assert.equal((await request(app).post('/corrections/api-address/confirm').send({expectedVersion:1,newValue:'separate change'})).status,400);assert.equal((await request(app).post('/complaints/api/location-corrections').send(input('api'))).status,200);
  });
  await t.test('A6 links new group action to actual complaint scope and exposes only approved typed details',async()=>{
   const {queryAuditLogs}=await import('../src/repositories/auditLogRepo');const {projectAuditLog}=await import('../src/services/auditQueryService');
   const rows=await queryAuditLogs(pool,{action:'CORRECTION_LOCATION_GROUP'},{page:1,size:100},scoped.access);assert.ok(rows.total>0);const row=rows.content.find((r:any)=>r.biz_id==='atomic')!;assert.equal(row.business_no,'LOCAL-atomic');const projected=projectAuditLog(row);assert.equal(projected.detail.validationDate,'2026-10-09');assert.ok(Array.isArray(projected.detail.changes));assert.equal(JSON.stringify(projected).includes('basisBefore'),false);
   await db('complaint').where('complaint_id','atomic').update({district_code:'D2'});const denied=await queryAuditLogs(pool,{action:'CORRECTION_LOCATION_GROUP',businessNo:'LOCAL-atomic'},{page:1,size:100},scoped.access);assert.equal(denied.total,0);await db('complaint').where('complaint_id','atomic').update({district_code:'D1'});
   await db('business_event').insert({event_id:'atomic',source_business_id:'hidden'});await db('operation_audit_log').insert({audit_id:'collision',biz_type:'business_event',biz_id:'atomic',action:'CORRECTION_LOCATION_GROUP',result:'success',created_at:new Date()});assert.equal((await queryAuditLogs(pool,{action:'CORRECTION_LOCATION_GROUP',businessNo:'LOCAL-atomic'},{page:1,size:100},scoped.access)).content.some((r:any)=>r.audit_id==='collision'),false);
  });
  await t.test('unchanged historical disabled district retains actual name; new disabled choices reject',async()=>{
   await seed('disabled');await db('dict_item').where({dict_type:'district',item_value:'D1'}).update({status:'disabled'});await save('disabled',{coordinateSystem:'unknown'});assert.equal((await db('complaint').where('complaint_id','disabled').first()).district_name,'旧合成名称');
   await seed('newdisabled',{district_code:'D2'});await assert.rejects(()=>save('newdisabled',{coordinateSystem:'unknown'}),{status:400});await db('dict_item').where({dict_type:'district',item_value:'D1'}).update({status:'enabled'});
  });
  await t.test('analysis admission still requires every pending correction and an existing dispatch',async()=>{
   await seed('unassigned');await db('correction_item').where({complaint_id:'unassigned',field_name:'summary'}).update({status:'rejected'});assert.equal((await save('unassigned')).analysisEntered,false);assert.equal((await db('analysis_record').where('complaint_id','unassigned')).length,0);
   await seed('assigned');await db('dispatch_order').insert({assignment_id:'AS1',complaint_id:'assigned',active_complaint_id:'assigned',status:'completed'});assert.equal((await save('assigned')).analysisEntered,false);await runWithAccessContext(access,()=>service.rejectCorrection('assigned-summary',{expectedVersion:2,basis:'合成核验'},ctx));assert.equal((await db('analysis_record').where('complaint_id','assigned')).length,1);
  });
  await t.test('persisted DECIMAL precision is the value in decisions, protection and field history',async()=>{
   await seed('precision');await save('precision',{longitude:1.12345678});const actual=await snapshot('precision');
   assert.equal(Number(actual.row.location_lng),1.123457);assert.equal(json(actual.row.effective_field_state).location_lng.value,1.123457);
   assert.equal(actual.items.find((i:any)=>i.field_name==='location_lng').new_value,'1.123457');assert.equal(actual.versions.find((v:any)=>v.field_name==='location_lng').new_value,'1.123457');
  });
  await t.test('enterprise wait before dependency discovery uses newly committed coverage rather than an old RR probe',async()=>{
   if(await db('dict_type').where('dict_type','business_type').first())await db('dict_type').where('dict_type','business_type').update({status:'enabled',published:1});else await db('dict_type').insert({dict_type:'business_type',dict_name:'合成业务',status:'enabled',published:1,version:1});
   if(await db('dict_item').where({dict_type:'business_type',item_value:'water'}).first())await db('dict_item').where({dict_type:'business_type',item_value:'water'}).update({status:'enabled',published:1});else await db('dict_item').insert({item_id:'synthetic-water',dict_type:'business_type',item_value:'water',item_label:'合成供水',status:'enabled',published:1,version:1});
   await seed('race');for(const [code,x] of [['A3',10],['A4',20]] as const)await db('admin_grid').insert({code,name:'合成并发行政',district_code:'D1',version:1,geometry:JSON.stringify({type:'Polygon',coordinates:[[[x,0],[x+4,0],[x+4,4],[x,4],[x,0]]]}),coordinate_system:'WGS84',geometry_source:'合成并发资料'});
   await db('community').insert({code:'X3',name:'合成并发小区',admin_grid_code:'A3',version:1});
   const {serviceGridService}=await import('../src/services/serviceGridService');const master={...ctx,permissionCodes:['grid.manage'],access};
   const initial={code:'GR',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:['X1'],validFrom:'2026-01-01',validTo:null,expectedVersion:0};await serviceGridService.save(initial,master);
   const writer=await pool.getConnection();await writer.beginTransaction();const next={...initial,adminGridCodes:['A3','A4'],communityCodes:['X3'],validFrom:'2026-10-01',expectedVersion:1};await serviceGridService.validateInTx(writer,next,master);
   const original=pool.getConnection;let readerId=0;let submitted!:()=>void;const entered=new Promise<void>(r=>submitted=r);
   pool.getConnection=(async()=>{const connection=await original.call(pool);readerId=connection.threadId;return new Proxy(connection,{get(target,key){if(key==='query')return async(sql:string,...args:any[])=>{if(sql.includes('from enterprise where enterprise_code=? for update'))submitted();return (target.query as any)(sql,...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}) as any;
   const pending=save('race',{longitude:11,adminGridCode:'A3',communityCode:'X3'}).then(value=>({value}),error=>({error}));
   try{
    await entered;const deadline=Date.now()+5000;let waiting=false;
    do{const [locks]=await db.raw('select count(*) as n from performance_schema.data_lock_waits w join performance_schema.threads th on th.thread_id=w.requesting_thread_id where th.processlist_id=?',[readerId]);waiting=Number(locks[0].n)>0;if(!waiting)await new Promise<void>(r=>setImmediate(r));}while(!waiting&&Date.now()<deadline);
    assert.equal(waiting,true,'actual enterprise-lock wait must be observed');await serviceGridService.saveInTx(writer,next,master);await writer.commit();const outcome=await pending;
    assert.equal('error' in outcome,false,'group should see committed whole dependency set after waiting');if('value' in outcome){assert.equal(outcome.value.spatialStatus,'verified');assert.deepEqual(outcome.value.coverageEvidence.map(e=>[e.code,e.version]),[['GR','2']]);}
   }finally{pool.getConnection=original;await writer.rollback();writer.release();await pending;}
  });
 }finally{if(close)await close();await db.destroy();}
});
