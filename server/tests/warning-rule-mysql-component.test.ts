import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import express from 'express';
import request from 'supertest';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_D2_COMPONENT_DB==='gqxq_d2_contract_test';
test('D2 declared isolated real MySQL contract (not M0/canonical/restart)',{skip:!enabled},async t=>{
 for(const [key,value] of Object.entries({GQXQ_DB_NAME:'gqxq_d2_contract_test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'3306'}))assert.equal(process.env[key],value);
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_d2_contract_test',timezone:'+08:00'}});let close:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_d2_contract_test');
  assert.ok(existsSync(new URL('../migrations/20261009160000__heat_rules.js',import.meta.url)),'D2 rule migration is missing');
  for(const name of ['heat_rule_published','heat_policy_confirmation','heat_policy_version','heat_rule_draft','heat_rule_head','service_grid_community','service_grid_admin','service_grid_revision','community','admin_grid','grid_enterprise','service_grid','enterprise_department_mapping','enterprise_household_version','enterprise_revision','enterprise','complaint_location_clue','complaint_address_candidate','sensitive_hit','report_todo','analysis_record','correction_item','dispatch_order','business_event','complaint_category_revision','dictionary_version','dictionary_code_registry','dict_type','dict_item','complaint_field_version','complaint_source_log','number_sequence','platform_role_permission','platform_permission','platform_role','platform_authorization_state','app_user','operation_audit_log','complaint'])await db.schema.dropTableIfExists(name);
  // Explicit synthetic pre-M2 base. Existing actual migrations own all added columns.
  await db.raw(`create table complaint(id bigint unsigned auto_increment primary key,complaint_id varchar(64) not null unique,complaint_no varchar(64),source_system varchar(64),source_id varchar(128),title varchar(256),content text,business_type varchar(64),complaint_type varchar(64),urgency_level varchar(64),status varchar(64),is_sensitive tinyint,sensitive_keywords varchar(500),district_code varchar(64),district_name varchar(128),address varchar(500),corrected_address varchar(500),location_lng decimal(12,6),location_lat decimal(12,6),correction_status varchar(64),enterprise_code varchar(64),enterprise_name varchar(128),grid_code varchar(64),sync_status varchar(64),received_at datetime,closed_at datetime,created_at datetime,updated_at datetime,deleted tinyint default 0) engine=InnoDB default charset=utf8mb4`);
  await db.raw('create table dict_type(id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dict_item(id bigint auto_increment primary key,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table dispatch_order(id bigint auto_increment primary key,assignment_id varchar(64) unique,complaint_id varchar(64),active_complaint_id varchar(64) unique,status varchar(64),reporting_task_id varchar(64),created_at datetime) engine=InnoDB');
  await db.raw('create table business_event(event_id varchar(64),source_business_id varchar(64),task_id varchar(64),event_type varchar(64),payload json,id bigint auto_increment primary key) engine=InnoDB');
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  await db.raw('create table app_user(id bigint auto_increment primary key,user_id varchar(64) unique,username varchar(64) unique,password_hash varchar(100),real_name varchar(64),roles json,permissions json,status tinyint default 1) engine=InnoDB');
  await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,business_type varchar(64),district_code varchar(64)) engine=InnoDB default charset=utf8mb4');
  await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_pair(grid_code,enterprise_code)) engine=InnoDB');
  await db.raw('create table enterprise(id bigint auto_increment primary key,enterprise_code varchar(64) unique,enterprise_name varchar(128),business_type varchar(64),status varchar(16)) engine=InnoDB');
  for(const file of ['20260917100100__m1_g1_new_tables.js','20260917100200__m2_complaint_g1_columns.js','20260917100400__m4_correction_confidence.js','20260917100800__m8_g5_correction_analysis_report.js','20260917101100__m11_complaint_overtime_flag.js','20260917101200__m12_address_candidate.js','20260924100000__m13_location_clues.js','20261009010000__effective_field_protection.js','20261009030000__account_role_permissions.js','20261009040000__user_object_scopes.js','20261009070000__dictionary_governance_categories.js','20261009080000__enterprise_management.js','20261009090000__service_grid_coverage.js','20261009100001__service_grid_registration.js','20261009120000__location_correction_group.js','20261009130000__account_identity_type.js'])await require('../migrations/'+file).up(db);
  const migration=require('../migrations/20261009150000__statistics_snapshots.js');await migration.up(db);
  const {pool}=await import('../src/db/pool');const {withTransaction}=await import('../src/db/tx');close=()=>pool.end();const service=await import('../src/services/statisticsService');const {normalizeStatisticsQuery}=await import('../src/domain/statisticsQuery');const {runWithAccessContext}=await import('../src/auth/accessScope');
  for(const table of ['manual_followup_request','manual_followup_revision','manual_followup'])await db.schema.dropTableIfExists(table);await require('../migrations/20261009130001__manual_complaint_followups.js').ensureFollowupTables(db);
  const heat=await import('../src/services/heatRuleService');
  const domain=await import('../src/domain/heatRule');
  const hm=require('../migrations/20261009160000__heat_rules.js');await hm.up(db);
  const clock=()=>new Date('2026-10-09T16:00:00Z');
  const access={userId:'synthetic',roles:['custom'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
  const ctx={userId:'synthetic',userName:'Synthetic',clientIp:null,access,permissionCodes:['heatmap.manage','heatmap.read','statistics.read','dashboard.read','complaint.read']};
  await db('dict_type').where('dict_type','complaint_category').update({version:10,published:1,status:'enabled'});
  await db('dict_item').insert([{item_id:'synthetic-major',dict_type:'complaint_category',item_value:'fee',item_label:'Synthetic fee',parent_code:null,published:1,status:'enabled',version:1},{item_id:'synthetic-minor',dict_type:'complaint_category',item_value:'price',item_label:'Synthetic price',parent_code:'fee',published:1,status:'enabled',version:1}]);
  const policy={anchor:'upper',endpointOwner:'lower',zero:'green',belowFirst:'green',top:'red',day:'shanghai_inclusive',classFallback:'minor_then_major',noRule:'null',ruleSelection:'query_end'};
  const input={ruleId:'synthetic-rule',category:{majorCode:'fee',minorCode:null,dictionaryVersion:'10'},coefficients:['1','5','10','20','30'],policyId:'synthetic-policy',policyVersion:1,policy,effectiveFrom:'2026-10-10',expectedVersion:0};
  await t.test('unconfirmed drafts cannot publish and client confirmation cannot be forged',async()=>{
   const saved=await heat.saveHeatDraft(input,ctx);assert.equal(saved.editVersion,1);
   await assert.rejects(()=>heat.publishHeatDraft(input.ruleId,1,ctx,clock),/确认/);
   await assert.rejects(()=>heat.saveHeatDraft({...input,confirmed:true},ctx));
   await assert.rejects(()=>heat.saveHeatDraft({...input,coefficients:['1','1','2','3','4']},ctx));
   assert.equal((await db('heat_rule_published')).length,0);assert.equal((await db('heat_policy_confirmation')).length,0);
  });
  await t.test('exact synthetic confirmation publishes, frozen version survives newer append',async()=>{
   const fp=domain.policyFingerprint(policy as any);
   await db('heat_policy_confirmation').insert({policy_id:input.policyId,policy_version:1,fingerprint:fp,truth_table:JSON.stringify([{count:450,days:30,coefficients:input.coefficients,level:'orange'}]),evidence_ref:'SYNTHETIC ONLY - NOT Q7 APPROVAL',confirmed_by:'synthetic',confirmed_at:new Date()});
   const published=await heat.publishHeatDraft(input.ruleId,1,ctx,clock);assert.ok(published.version);
   const frozen=await heat.freezeHeatRule(published.version,ctx);
   assert.equal(domain.evaluateHeat({count:450,days:30,rule:frozen.rule,policy:frozen.policy}).level,'orange');
   await assert.rejects(()=>heat.publishHeatDraft(input.ruleId,1,ctx,clock));
   const edited=await heat.saveHeatDraft({...input,expectedVersion:2,effectiveFrom:'2026-10-11',coefficients:['2','6','11','21','31']},ctx);assert.equal(edited.editVersion,3);
   await heat.publishHeatDraft(input.ruleId,3,ctx,clock);
   assert.deepEqual(await heat.freezeHeatRule(published.version,ctx),frozen);
   assert.equal((await db('heat_rule_published')).length,2);
   const content=(await db('heat_rule_published').where('version_id',published.version).first()).content;assert.equal((typeof content==='string'?JSON.parse(content):content).rule.effectiveFrom,'2026-10-10');
   await heat.saveHeatDraft({...input,expectedVersion:4,effectiveFrom:'2026-10-09'},ctx);
   await assert.rejects(()=>heat.publishHeatDraft(input.ruleId,5,ctx,clock));
  });
  await t.test('real D1 capture and heat share counts, scope, temporal memberships and detail permission',async()=>{
   await db('enterprise').insert({enterprise_code:'E1',enterprise_name:'Synthetic',business_type:'water',status:'enabled',version:1,district_code:'D1'});
   await db('admin_grid').insert({code:'A1',name:'Synthetic grid',district_code:'D1',version:1});
   const coverage=(code:string)=>({code,serviceGridCode:code,enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:[],version:'1',validFrom:'2026-01-01',validTo:null,geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A1'},geometry:{type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]]]}}]},coordinateSystem:'WGS84',geometrySources:['Synthetic evidence'],coverageState:'maintained'});
   for(const code of ['G1','G2']){await db('service_grid').insert({grid_code:code,grid_name:code,business_type:'water',version:1,import_state:'published'});await db('grid_enterprise').insert({grid_code:code,enterprise_code:'E1'});await db('service_grid_revision').insert({grid_code:code,version:1,valid_from:'2026-01-01',snapshot:JSON.stringify(coverage(code)),operator_id:'synthetic',created_at:new Date()});await db('service_grid_admin').insert({grid_code:code,version:1,admin_grid_code:'A1'});}
   await db('dictionary_version').insert({type_code:'complaint_category',version:10,snapshot:JSON.stringify({type:{code:'complaint_category'},items:[{code:'fee',label:'Synthetic fee',parentCode:null},{code:'price',label:'Synthetic price',parentCode:'fee'}]}),created_at:new Date()});
   for(const [id,crs] of [['C1','WGS84'],['C2','unknown']])await db('complaint').insert({complaint_id:id,complaint_no:id,source_reported_at:'2026-10-10 08:00:00',received_at:'2026-10-10 08:00:00',business_type:'water',enterprise_code:'E1',district_code:'D1',major_category_code:'fee',minor_category_code:'price',category_dictionary_version:10,location_lng:1,location_lat:1,location_coordinate_system:crs,location_coordinate_source:'Synthetic',edit_version:1});
   const q={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-09-11',to:'2026-10-10',comparisonPolicyId:'candidate-calendar-v1',majorCode:'fee'};
   const r=await heat.getHeatData(q,ctx,clock);assert.equal(r.total,2);assert.equal(r.unlocatedCount,1);assert.deepEqual(r.grids.map(g=>g.count),[1,1]);assert.equal(r.points.length,1);assert.equal(r.grids[0].level,'green');assert.ok(r.grids[0].ruleVersion);
   const aggregate=await heat.getHeatData(q,{...ctx,permissionCodes:ctx.permissionCodes.filter(p=>p!=='complaint.read')},clock);assert.equal(aggregate.points.length,0);assert.equal(JSON.stringify(aggregate).includes('C1'),false);
   const unknown=await heat.getHeatData({...q,majorCode:undefined},ctx,clock);assert.equal(unknown.grids[0].reason,'CATEGORY_SELECTION_REQUIRED');
   await assert.rejects(()=>heat.getHeatData(q,{...ctx,permissionCodes:['heatmap.read','dashboard.read']},clock));
   const scoped=await heat.getHeatData(q,{...ctx,access:{...access,rules:[{kind:'restricted',enterpriseCodes:['E2'],districtCodes:[]}]}},clock);assert.equal(scoped.total,0);assert.equal(scoped.points.length,0);
  });
  await t.test('permissions and exact configuration audit classification remain explicit',async()=>{
   await assert.rejects(()=>heat.saveHeatDraft(input,{...ctx,permissionCodes:['heatmap.read']}));
   const {heatRulesRouter}=await import('../src/routes/heatRules');const {enforceRolePolicy}=await import('../src/middleware/requireRole');const {errorHandler}=await import('../src/middleware/errorHandler');
   const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:'synthetic',username:'Synthetic',roles:['custom'],permissionCodes:['heatmap.read'],authorizationVersion:1} as any;req.accessContext=access;next();});app.use(enforceRolePolicy());app.use(heatRulesRouter);app.use(errorHandler);
   assert.equal((await request(app).post('/heat-rules').send(input)).status,403);
   const {queryAuditLogs}=await import('../src/repositories/auditLogRepo');const conn=await pool.getConnection();try{const result=await queryAuditLogs(conn,{module:'heat_rule'},{page:1,size:100},access);assert.ok(result.total>=4);}finally{conn.release();}
   await db('platform_role_permission').where({role_code:'admin',permission_code:'heatmap.manage'}).delete();await hm.up(db);assert.equal((await db('platform_role_permission').where({role_code:'admin',permission_code:'heatmap.manage'})).length,0);
  });
  await t.test('same-category concurrent publication has one winner and no overlapping starts',async()=>{
   await heat.saveHeatDraft({...input,ruleId:'synthetic-minor',category:{...input.category,minorCode:'price'},expectedVersion:0,effectiveFrom:'2026-10-12'},ctx);
   const attempts=await Promise.allSettled([heat.publishHeatDraft('synthetic-minor',1,ctx,clock),heat.publishHeatDraft('synthetic-minor',1,ctx,clock)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
   assert.equal((await db('heat_rule_published').where('category_key','fee|price')).length,1);
  });
  await t.test('owned prefix identity conflict refuses all DDL before repairing a missing table',async()=>{
   await db.schema.dropTable('heat_policy_version');await db.raw('alter table heat_rule_head drop primary key, add unique key bad_prefix(category_key(16))');
   await assert.rejects(()=>hm.up(db),/full unique/);assert.equal(await db.schema.hasTable('heat_policy_version'),false);
   await db.raw('alter table heat_rule_head drop key bad_prefix, add primary key(category_key)');await hm.up(db);
  });
 }finally{if(close)await close();await db.destroy();}
});
