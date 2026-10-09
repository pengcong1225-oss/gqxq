import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_B1_COMPONENT_DB==='gqxq_b1_contract_test';
test('B1 isolated MySQL dictionary/category component, not canonical baseline or restart acceptance',{skip:!enabled},async t=>{
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_b1_contract_test');assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_b1_contract_test',timezone:'+08:00'}});
 let closePool:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_b1_contract_test');
  // Only the explicitly owned synthetic schema is reset. No M0/full-schema claim.
  for(const table of ['complaint_source_log','sensitive_hit','complaint_category_revision','dictionary_version','dictionary_code_registry','dict_item','dict_type','correction_item','complaint_field_version','business_event','analysis_record','dispatch_order','complaint_address_candidate','complaint_location_clue','complaint','platform_role_permission','platform_permission','platform_role','platform_authorization_state','operation_audit_log','a6_saved_audit','app_user','number_sequence'])await db.schema.dropTableIfExists(table);
  await db.raw("create table app_user (id bigint primary key auto_increment,user_id varchar(64) not null unique,username varchar(64) not null unique,password_hash varchar(100) not null,real_name varchar(64) not null,roles json not null,permissions json not null,status tinyint not null default 1,last_login_at datetime,created_at datetime not null default current_timestamp,updated_at datetime not null default current_timestamp on update current_timestamp) engine=InnoDB default charset=utf8mb4");
  await db.raw('create table operation_audit_log (id bigint auto_increment primary key,audit_id varchar(64) unique,user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  await db.raw('create table complaint_source_log (id bigint auto_increment primary key,log_id varchar(64),source_system varchar(64),source_id varchar(128),complaint_id varchar(64),payload_hash varchar(64),payload json,result varchar(32),message text,remote_ip varchar(64),request_id varchar(64),received_at datetime) engine=InnoDB');
  await db.raw('create table number_sequence (seq_key varchar(64),biz_date date,current_value bigint default 0,primary key(seq_key,biz_date)) engine=InnoDB');
  await require('../migrations/20261009030000__account_role_permissions.js').up(db);
  await require('../migrations/20261009040000__user_object_scopes.js').up(db);
  const migration='../migrations/20261009050000__audit_query_indexes.js';if(existsSync(new URL(migration,import.meta.url)))await require(migration).up(db);
  await db.raw("create table dict_type (id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(32)) engine=InnoDB");
  await db.raw("create table dict_item (id bigint auto_increment primary key,item_id varchar(64) unique,dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(32)) engine=InnoDB");
  const {COMPLAINT_COLUMNS}=await import('../src/repositories/complaintMapper');
  const columns=[...new Set(COMPLAINT_COLUMNS.split(', ').map(c=>c.slice(2)).filter(c=>!['major_category_code','minor_category_code','category_dictionary_version','source_major_category_code','source_minor_category_code','source_category_version'].includes(c)).concat(['deleted','source_payload_hash']))];
  const json=new Set(['source_payload','source_fields','effective_field_state']);const nums=new Set(['edit_version','deleted','is_sensitive','closed_in_system','analysis_included','overtime_flag']);
  await db.raw('create table complaint ('+columns.map(c=>c==='id'?'id bigint auto_increment primary key':c==='complaint_id'?'complaint_id varchar(64) unique':json.has(c)?c+' json':nums.has(c)?c+' bigint default '+(c==='edit_version'?1:0):c.endsWith('_at')?c+' datetime':c+' text').join(',')+') engine=InnoDB');
  await db.raw('create table dispatch_order (id bigint auto_increment primary key,assignment_id varchar(64) unique,complaint_id varchar(64),reporting_task_id varchar(128),status varchar(32),active_complaint_id varchar(64)) engine=InnoDB');
  await db.raw('create table analysis_record (id bigint auto_increment primary key,analysis_id varchar(64) unique,complaint_id varchar(64)) engine=InnoDB');
  await db.raw('create table sensitive_hit (id bigint auto_increment primary key,hit_id varchar(64),complaint_id varchar(64),dict_item_id varchar(64),hit_word varchar(128),hit_field varchar(64),created_at datetime) engine=InnoDB');
  await db.raw('create table complaint_address_candidate (complaint_id varchar(64),candidate_text text,evidence_text text,source_field varchar(32),extractor_version varchar(64),input_hash varchar(64),district_code varchar(64),parent_match varchar(64),snapshot_id varchar(64)) engine=InnoDB');
  await db.raw('create table complaint_location_clue (id bigint auto_increment primary key,complaint_id varchar(64),clue_kind varchar(32),clue_value text,evidence_text text,source_field varchar(32),source_start int,source_end int,township_code varchar(64),district_code varchar(64),parent_match varchar(32),extractor_version varchar(64),snapshot_id varchar(64),input_hash varchar(64)) engine=InnoDB');
  await db.raw('create table business_event (id bigint auto_increment primary key,event_id varchar(128) unique,source_business_id varchar(128)) engine=InnoDB');
  await db.raw('create table correction_item (id bigint primary key auto_increment,correction_id varchar(64) unique,complaint_id varchar(64),assignment_id varchar(64),field_name varchar(64),field_label varchar(64),old_value text,new_value text,basis text,status varchar(32),confirmer_id varchar(64),confirmer_name varchar(64),confirmed_at datetime,created_at datetime) engine=InnoDB');
  await db.raw('create table complaint_field_version (id bigint primary key auto_increment,version_id varchar(64),complaint_id varchar(64),field_name varchar(64),old_value text,new_value text,change_source varchar(64),reason text,operator_id varchar(64),operator_name varchar(64),changed_at datetime) engine=InnoDB');
  for(const [id,role,rules] of [['admin','admin',[]],['scoped','auditor',[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['G1']}]],['scoped2','auditor',[{kind:'restricted',enterpriseCodes:['E2'],districtCodes:['G2']}]],['all','auditor',[{kind:'all'}]],['denied','handler',[{kind:'all'}]]] as const)
   await db('app_user').insert({user_id:id,username:id,password_hash:await bcrypt.hash('Synthetic-Pass-1',4),real_name:'虚构',roles:JSON.stringify([role]),permissions:'[]',scope_rules:JSON.stringify(rules),session_version:1,must_change_password:0});
  await db('platform_role').insert({role_code:'auditor',name:'虚构审计员',enabled:1,built_in:0,version:1});
  await db('platform_role_permission').insert({role_code:'auditor',permission_code:'system.audit.read'});
  for(const [id,e,g,deleted] of [['C1','E1','G1',0],['C2','E2','G2',0],['DEL','E1','G1',1]])await db('complaint').insert({complaint_id:id,complaint_no:'NO-'+id,title:'RAW_CONTENT_SECRET',content:'RAW_CONTENT_SECRET',enterprise_code:e,district_code:g,deleted,edit_version:1,effective_field_state:'{}',address:'旧地址'});
  await db('dispatch_order').insert({assignment_id:'D2',complaint_id:'C2',reporting_task_id:'T2'});
  await db('analysis_record').insert({analysis_id:'ANA1',complaint_id:'C1'});await db('analysis_record').insert({analysis_id:'ANA2',complaint_id:'C2'});
  await db('business_event').insert([{event_id:'EV1',source_business_id:'C1'},{event_id:'EV2',source_business_id:'C2'}]);
  const stamp=new Date('2026-10-09T00:00:00Z');
  const {createApp}=await import('../src/app');const poolModule=await import('../src/db/pool');closePool=poolModule.closePool;
  await require('../migrations/20261009070000__dictionary_governance_categories.js').up(db);
  await db('platform_role_permission').insert(['system.dict.manage','dict.read','complaint.correct','complaint.read'].map(permission_code=>({role_code:'auditor',permission_code})));
  const app=createApp();const token=(id:string)=>jwt.sign({sub:id,username:id,sessionVersion:1},process.env.GQXQ_JWT_SECRET!);
  const api=(method:string,path:string,user='scoped',body?:unknown)=>{const q=(request(app) as any)[method]('/api/v1'+path).set('Authorization','Bearer '+token(user));return body===undefined?q:q.send(body);};
  const typeCode='virtual_service';
  const save=(code:string,parentCode:string|null=null,extra:Record<string,unknown>={})=>api('post','/dict-types/complaint_category/items','scoped',{code,label:code,parentCode,published:true,expectedVersion:0,...extra});
  await t.test('managed routes capability, fixed enums and no-scope management',async()=>{
   assert.equal((await api('get','/dict-types','denied')).status,403);
   assert.equal((await api('post','/dict-types','admin',{code:typeCode,name:'虚构服务',expectedVersion:0})).status,200);
   assert.equal((await api('post','/dict-types','scoped',{code:'supervision_status',name:'状态',expectedVersion:0})).status,403);
   assert.equal((await api('post','/dict-types','scoped',{code:'complaint_type',name:'诉求性质',expectedVersion:0,published:true})).status,200);
   assert.equal((await api('post','/dict-types/complaint_type/items','scoped',{code:'unknown',label:'未知',expectedVersion:0})).status,400);
   assert.equal((await api('post','/dict-types/complaint_type/items','scoped',{code:'complaint',label:'投诉',published:true,expectedVersion:0})).status,200);
  });
  await t.test('two-level hierarchy, published history, explicit parent disable and stale item conflict',async()=>{
   for(const code of ['fee','pressure'])assert.equal((await save(code)).status,200);
   assert.equal((await save('price','fee')).status,200);
   assert.equal((await save('bad','missing')).status,400);
   assert.equal((await save('third','price')).status,400);
   assert.equal((await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'fee',parentCode:'price',expectedVersion:1})).status,400);
   assert.equal((await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'费用',expectedVersion:1})).status,200);
   assert.equal((await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'过时',expectedVersion:1})).status,409);
   assert.equal((await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'费用',status:'disabled',expectedVersion:2})).status,400);
   const disabled=await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'费用',status:'disabled',expectedVersion:2,cascadeDisable:true});assert.equal(disabled.status,200);
   const options=await api('get','/categories');assert.ok(!options.body.data.items.some((i:any)=>['fee','price'].includes(i.code)));
   const historicalVersion=String(disabled.body.data.dictionaryVersion-1);
   const {validateCategory}=await import('../src/services/categoryService');
   await validateCategory({majorCode:'fee',minorCode:'price',dictionaryVersion:historicalVersion},{forNewSelection:false});
   await assert.rejects(()=>validateCategory({majorCode:'fee',minorCode:'price',dictionaryVersion:String(disabled.body.data.dictionaryVersion)},{forNewSelection:true}),/停用/);
   assert.equal((await api('delete','/dict-types/complaint_category/items/fee','scoped',{expectedVersion:3})).status,409);
   assert.equal((await api('patch','/dict-types/complaint_category/items/fee','scoped',{label:'费用',status:'enabled',expectedVersion:3})).status,200);
   assert.equal((await api('patch','/dict-types/complaint_category/items/price','scoped',{label:'价格',status:'enabled',expectedVersion:2})).status,200);
  });
  await t.test('draft deletion reserves code forever; no-op leaves versions/audit unchanged',async()=>{
   const created=await api('post','/dict-types/'+typeCode+'/items','scoped',{code:'draft',label:'草稿',expectedVersion:0});assert.equal(created.status,200);
   const count=Number((await db('operation_audit_log').count('* as total'))[0].total);
   const noop=await api('patch','/dict-types/'+typeCode+'/items/draft','scoped',{label:'草稿',expectedVersion:1});assert.equal(noop.status,200);assert.equal(noop.body.data.changed,false);
   assert.equal(Number((await db('operation_audit_log').count('* as total'))[0].total),count);
   assert.equal((await api('delete','/dict-types/'+typeCode+'/items/draft','scoped',{expectedVersion:1})).status,200);
   assert.equal((await api('post','/dict-types/'+typeCode+'/items','scoped',{code:'draft',label:'复用',expectedVersion:0})).status,409);
  });
  await t.test('A1 classification version/scope/protection, actual grouping and preserved analysis values',async()=>{
   const options=await api('get','/categories');const dictionaryVersion=options.body.data.dictionaryVersion;
   const category={majorCode:'fee',minorCode:'price',dictionaryVersion};
   assert.equal((await api('post','/complaints/C2/category','scoped',{category,expectedVersion:1,basis:'虚构核对'})).status,404);
   // Already-analyzed legacy record still requires prior dispatch and no pending correction.
   assert.equal((await api('post','/complaints/C1/category','scoped',{category,expectedVersion:1,basis:'虚构核对'})).status,409);
   await db('dispatch_order').insert({assignment_id:'D1',complaint_id:'C1'});
   const first=await api('post','/complaints/C1/category','scoped',{category,expectedVersion:1,basis:'虚构核对'});assert.equal(first.status,200);
   assert.equal((await api('post','/complaints/C1/category','scoped',{category,expectedVersion:1,basis:'过时'})).status,409);
   const row=await db('complaint').where('complaint_id','C1').first();assert.equal(row.major_category_code,'fee');assert.equal(row.edit_version,2);
   const state=typeof row.effective_field_state==='string'?JSON.parse(row.effective_field_state):row.effective_field_state;assert.equal(state.major_category_code.resolution,'confirmed');
   const group=()=>db('complaint as c').join('analysis_record as ar','ar.complaint_id','c.complaint_id').select('major_category_code').count('* as total').groupBy('major_category_code');
   const before=await group();const frozen=await db('analysis_record').where('complaint_id','C1').first();
   const revision=await api('post','/complaints/C1/category','scoped',{category:{majorCode:'pressure',minorCode:null,dictionaryVersion},expectedVersion:2,basis:'费用核实为气压'});assert.equal(revision.status,200);
   const after=await group();assert.equal(before.find((r:any)=>r.major_category_code==='fee').total,1);assert.equal(after.some((r:any)=>r.major_category_code==='fee'),false);assert.equal(after.find((r:any)=>r.major_category_code==='pressure').total,1);
   assert.equal(after.reduce((s:number,r:any)=>s+Number(r.total),0),before.reduce((s:number,r:any)=>s+Number(r.total),0));
   assert.deepEqual(await db('analysis_record').where('complaint_id','C1').first(),frozen,'existing analysis snapshot storage remains untouched');
   const history=await api('get','/complaints/C1/category-history');assert.equal(history.body.data.length,2);assert.equal(history.body.data[0].majorCode,'fee');assert.equal(history.body.data[1].oldMajorCode,'fee');
   assert.equal((await api('get','/dict-types/complaint_category/items/fee/references')).body.data.complaints[0].complaintId,'C1');
   const q=await api('get','/audit-logs?action=CATEGORY_REVISE');assert.equal(q.body.data.total,2);assert.equal(q.body.data.content[0].detail.majorCode,'pressure');
   const foreign=await api('get','/audit-logs?action=CATEGORY_REVISE','scoped2');assert.equal(foreign.body.data.total,0);
   const global=await api('get','/audit-logs?module=dictionary','admin');assert.ok(global.body.data.total>0,'global dictionary configuration visible without complaint scope');
   assert.equal((await api('get','/complaints/C1')).body.data.category.majorCode,'pressure');
   assert.equal((await api('get','/complaints/C2','all')).body.data.category,null,'legacy not mass classified');
  });
  await t.test('B4 caller transaction atomically rolls back item/history/audit and category revision',async()=>{
   const {DictionaryService}=await import('../src/services/dictService');const {reviseCategoryInTx}=await import('../src/services/categoryService');const {withTransaction}=await import('../src/db/tx');
   const service=new DictionaryService();const ctx={userId:'scoped',userName:'虚构',clientIp:null,permissionCodes:['system.dict.manage','complaint.correct'],access:{userId:'scoped',roles:['auditor'],scopeVersion:1,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:['G1']}],canReadSource:false}};
   const facts=await service.items('complaint_category',ctx);const audits=Number((await db('operation_audit_log').count('* as total'))[0].total);
   await assert.rejects(()=>withTransaction(async tx=>{
    const validation=await service.validateItemInTx(tx,{typeCode,code:'atomic',label:'事务',expectedVersion:0},ctx);assert.equal(validation.dependency.typeCode,typeCode);
    await service.saveItemInTx(tx,{typeCode,code:'atomic',label:'事务',expectedVersion:0},ctx);
    await reviseCategoryInTx(tx,{complaintId:'C1',category:{majorCode:'fee',minorCode:null,dictionaryVersion:String(facts.type.version)},expectedVersion:3,basis:'事务回滚'},ctx);
    throw Error('synthetic rollback');
   }),/synthetic rollback/);
   assert.equal((await db('dict_item').where({dict_type:typeCode,item_value:'atomic'})).length,0);
   assert.equal((await db('dictionary_code_registry').where({type_code:typeCode,item_code:'atomic'})).length,0);
   assert.equal((await db('complaint_category_revision').where('complaint_id','C1')).length,2);
   assert.equal((await db('complaint').where('complaint_id','C1').first()).edit_version,3);
   assert.equal(Number((await db('operation_audit_log').count('* as total'))[0].total),audits);
   await withTransaction(tx=>service.saveItemInTx(tx,{typeCode,code:'atomic',label:'事务',expectedVersion:0},ctx));
   assert.equal((await db('dict_item').where({dict_type:typeCode,item_value:'atomic'})).length,1,'separate SQL connection observes committed persistence');
   await assert.rejects(()=>withTransaction(tx=>service.saveItemInTx(tx,{typeCode,code:'atomic',label:'过时',expectedVersion:0},ctx)),/版本/);
  });
  await t.test('deterministic concurrent category selection/disable uses shared type-first locks',async()=>{
   const {pool}=await import('../src/db/pool');const {DictionaryService}=await import('../src/services/dictService');const {reviseCategoryInTx}=await import('../src/services/categoryService');
   const service=new DictionaryService();const ctx={userId:'scoped',userName:'虚构',clientIp:null,permissionCodes:['system.dict.manage','complaint.correct'],access:{userId:'scoped',roles:['auditor'],scopeVersion:1,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:['G1']}],canReadSource:false}};
   const facts=await service.items('complaint_category',ctx);const item=facts.items.find(i=>i.code==='fee')!;
   const first=await pool.getConnection();const second=await pool.getConnection();await first.beginTransaction();await second.beginTransaction();
   try{
    const select=await reviseCategoryInTx(first,{complaintId:'C1',category:{majorCode:'fee',minorCode:'price',dictionaryVersion:String(facts.type.version)},expectedVersion:3,basis:'并发选择'},ctx);assert.equal(select.editVersion,4);
    let entered!:()=>void;const attempted=new Promise<void>(r=>entered=r);const query=second.query.bind(second);let settled=false;
    second.query=((sql:any,...args:any[])=>{const result=(query as any)(sql,...args);if(String(sql).includes('from dict_type')&&String(sql).includes('for update'))entered();return result;}) as typeof second.query;
    const disabling=service.saveItemInTx(second,{typeCode:'complaint_category',code:'fee',label:item.label,status:'disabled',expectedVersion:item.version,cascadeDisable:true},ctx).finally(()=>{settled=true;});
    await attempted;assert.equal(settled,false,'second transaction awaits held dictionary lock');await first.commit();await disabling;await second.commit();
    const stored=await db('complaint').where('complaint_id','C1').first();assert.equal(stored.major_category_code,'fee');assert.equal(stored.edit_version,4);
    const off=await service.items('complaint_category',ctx);assert.equal(off.items.find(i=>i.code==='price')!.status,'disabled');
    const rejected=await api('post','/complaints/C1/category','scoped',{category:{majorCode:'fee',minorCode:null,dictionaryVersion:String(off.type.version)},expectedVersion:4,basis:'停用后新选'});assert.equal(rejected.status,400);
    const enabled=await service.saveItem({typeCode:'complaint_category',code:'fee',label:item.label,status:'enabled',expectedVersion:off.items.find(i=>i.code==='fee')!.version},ctx);
    const minor=(await service.items('complaint_category',ctx)).items.find(i=>i.code==='price')!;await service.saveItem({typeCode:'complaint_category',code:'price',label:minor.label,status:'enabled',expectedVersion:minor.version},ctx);
   }finally{await first.rollback();await second.rollback();first.release();second.release();}
  });
  await t.test('already-analyzed formal correction cannot bypass unresolved legacy correction gate',async()=>{
   const dictionaryVersion=(await api('get','/categories')).body.data.dictionaryVersion;
   await db('correction_item').insert([{correction_id:'ANALYZED-CAT',complaint_id:'C1',field_name:'formal_category',status:'pending',created_at:stamp},{correction_id:'UNKNOWN-GATE',complaint_id:'C1',field_name:'address',status:'legacy_unknown',created_at:stamp}]);
   try{
    const response=await api('post','/corrections/ANALYZED-CAT/confirm','scoped',{newValue:JSON.stringify({majorCode:'pressure',minorCode:null,dictionaryVersion}),expectedVersion:4,basis:'未知项未处理'});assert.equal(response.status,409);
    const row=await db('complaint').where('complaint_id','C1').first();assert.equal(row.major_category_code,'fee');assert.equal(row.edit_version,4);assert.equal((await db('complaint_category_revision').where('complaint_id','C1')).length,3);
   }finally{await db('correction_item').whereIn('correction_id',['ANALYZED-CAT','UNKNOWN-GATE']).delete();}
  });
  await t.test('formal correction item uses category cascade data and retains source/nature; manual fixed-code new selection rejects disabled',async()=>{
   await db('analysis_record').where('complaint_id','C2').delete(); // This sample exercises not-yet-analyzed correction; C1 above proves analyzed gates.
   const dictionaryVersion=(await api('get','/categories')).body.data.dictionaryVersion;
   await db('complaint').where('complaint_id','C2').update({complaint_type:'consult',source_major_category_code:'source_fact',source_category_version:'source-v1'});
   await db('correction_item').insert([{correction_id:'CAT-COR2',complaint_id:'C2',field_name:'formal_category',status:'pending',created_at:stamp},{correction_id:'GUARD2',complaint_id:'C2',field_name:'address',status:'pending',created_at:stamp}]);
   const corrected=await api('post','/corrections/CAT-COR2/confirm','scoped2',{newValue:JSON.stringify({majorCode:'pressure',minorCode:null,dictionaryVersion}),expectedVersion:1,basis:'虚构分类核对'});
   assert.equal(corrected.status,200);assert.equal(corrected.body.data.writtenBack,true);
   const row=await db('complaint').where('complaint_id','C2').first();assert.equal(row.major_category_code,'pressure');assert.equal(row.complaint_type,'consult');assert.equal(row.source_major_category_code,'source_fact');assert.equal(row.edit_version,2);
   const state=typeof row.effective_field_state==='string'?JSON.parse(row.effective_field_state):row.effective_field_state;assert.equal(state.major_category_code.resolution,'confirmed');
   await db('correction_item').insert({correction_id:'NATURE-COR2',complaint_id:'C2',field_name:'complaint_type',status:'pending',created_at:stamp});
   assert.equal((await api('post','/corrections/NATURE-COR2/confirm','scoped2',{newValue:'unknown',expectedVersion:2})).status,400);
   await api('patch','/dict-types/complaint_type/items/complaint','scoped',{label:'投诉',status:'disabled',expectedVersion:1});
   assert.equal((await api('post','/corrections/NATURE-COR2/confirm','scoped2',{newValue:'complaint',expectedVersion:2})).status,400);
  });
  await t.test('sensitive-word dedicated management remains valid under isolated schema',async()=>{
   const one=await api('post','/dicts/sensitive-words','scoped',{word:'虚构敏感词甲'});assert.equal(one.status,200);
   assert.equal((await api('post','/dicts/sensitive-words','scoped',{word:'虚构敏感词甲'})).status,409);
   const two=await api('post','/dicts/sensitive-words','scoped',{word:'虚构敏感词乙'});assert.equal(two.status,200);
   assert.equal((await api('patch','/dicts/sensitive-words/'+one.body.data.itemId,'scoped',{status:'disabled'})).status,200);
   assert.equal((await api('patch','/dicts/sensitive-words/'+two.body.data.itemId,'scoped',{status:'disabled'})).status,409,'dedicated last-word guard is preserved');
   const list=await api('get','/dicts/sensitive-words');assert.equal(list.status,200);assert.equal(list.body.data.length,2);assert.equal(list.body.data.filter((w:any)=>w.status==='enabled').length,1);
   assert.equal((await api('post','/dicts/sensitive-words','denied',{word:'未授权'})).status,403);
  });
  await t.test('actual source redelivery keeps human formal category and records attempts; disabled protocol source remains a fact',async()=>{
   const {intakeAppeal}=await import('../src/services/intakeService');const {runAsTrustedSystem}=await import('../src/auth/accessScope');
   const previous=await db('complaint').where('complaint_id','C2').first();
   await db('complaint').where('complaint_id','C2').update({source_system:'synthetic-source',source_id:'synthetic-redelivery',source_payload_hash:'old-hash',source_fields:JSON.stringify({title:'RAW_CONTENT_SECRET',content:'RAW_CONTENT_SECRET',complaint_type:'consult'}),business_type:'water',urgency_level:'normal',sensitive_keywords:''});
   const result=await runAsTrustedSystem(()=>intakeAppeal({sourceSystem:'synthetic-source',sourceId:'synthetic-redelivery',channel:null,title:'RAW_CONTENT_SECRET',content:'RAW_CONTENT_SECRET',address:null,districtCode:null,districtName:null,longitude:null,latitude:null,explicitBusinessType:'water',explicitComplaintType:'complaint',explicitUrgencyLevel:'normal',sourceReportedAt:null,payload:{complaintType:'complaint',majorCategoryCode:'fee',minorCategoryCode:'price',categoryDictionaryVersion:'999'},payloadHash:'new-hash',warnings:[],remoteIp:null,requestId:null}));
   const row=await db('complaint').where('complaint_id','C2').first();assert.equal(row.major_category_code,previous.major_category_code);assert.equal(row.minor_category_code,previous.minor_category_code);assert.equal(row.category_dictionary_version,previous.category_dictionary_version);assert.equal(row.edit_version,previous.edit_version);assert.equal(row.source_major_category_code,'source_fact');
   const source=typeof row.source_fields==='string'?JSON.parse(row.source_fields):row.source_fields;assert.equal(source.complaint_type,'complaint','known disabled protocol code stays in source facts');
   assert.ok(result.warnings.some(w=>w.includes('major_category_code')),'formal category mutation attempt is explicitly rejected');
   const evidence=await db('complaint_field_version').where({complaint_id:'C2',field_name:'major_category_code'}).orderBy('id','desc').first();assert.equal(evidence.old_value,'pressure');assert.equal(evidence.new_value,'pressure');
  });
  await t.test('audit type/action mapping ignores collision/forged detail and projects only approved metadata',async()=>{
   const rows=[['B1-GLOBAL','dictionary','C2','DICTIONARY_ITEM_SAVE'],['B1-FOREIGN','complaint','C2','CATEGORY_REVISE'],['B1-BAD-TYPE','dictionary','C1','CATEGORY_REVISE'],['B1-BAD-ACTION','complaint','C1','DICTIONARY_ITEM_SAVE']];
   for(const [audit_id,biz_type,biz_id,action] of rows)await db('operation_audit_log').insert({audit_id,user_id:'contract-audits',biz_type,biz_id,action,result:'success',created_at:stamp,detail:JSON.stringify({typeCode:'complaint_category',itemCode:'fee',label:'费用',majorCode:'fee',complaintId:'C1',password:'SECRET',before:{payload:'SECRET'}})});
   const scoped=await api('get','/audit-logs?actor=contract-audits');assert.equal(scoped.body.data.total,1);assert.equal(scoped.body.data.content[0].auditId,'B1-GLOBAL');assert.equal(JSON.stringify(scoped.body).includes('SECRET'),false);assert.equal(scoped.body.data.content[0].detail.complaintId,undefined);
   const all=await api('get','/audit-logs?actor=contract-audits','all');assert.equal(all.body.data.total,2);
   assert.equal((await api('get','/audit-logs/B1-FOREIGN')).status,404);for(const id of ['B1-BAD-TYPE','B1-BAD-ACTION'])assert.equal((await api('get','/audit-logs/'+id,'all')).status,404);
   assert.equal((await api('get','/audit-logs/B1-FOREIGN','scoped2')).body.data.businessNo,'NO-C2');
   assert.equal((await api('get','/audit-logs?actor=contract-audits&businessNo=NO-C2')).body.data.total,0);
  });
  await t.test('observed source-system options obey current scopes and all-disabled does not fallback',async()=>{
   await db('complaint').where('complaint_id','C1').update({source_system:'local-one'});await db('complaint').where('complaint_id','C2').update({source_system:'foreign-two'});
   assert.deepEqual((await api('get','/dicts/source_system/items')).body.data,[{value:'local-one',label:'local-one'}]);
   assert.deepEqual((await api('get','/dicts/source_system/items','admin')).body.data,[]);
   assert.equal((await api('patch','/dict-types/complaint_type/items/complaint','scoped',{label:'投诉',status:'disabled',expectedVersion:2})).status,200);
   assert.deepEqual((await api('get','/dicts/complaint_type/items')).body.data,[]);
   await require('../migrations/20261009070000__dictionary_governance_categories.js').up(db);
   assert.equal((await db('complaint_category_revision').where('complaint_id','C1')).length,3);
  });
 }finally{await closePool?.();await db.destroy();}
});
