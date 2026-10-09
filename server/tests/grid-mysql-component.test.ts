import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import express from 'express';
import request from 'supertest';
const require=createRequire(import.meta.url);
test('B3 guarded real SQL component with explicitly declared legacy contract',{skip:process.env.GQXQ_B3_COMPONENT_DB!=='gqxq_b3_contract_test'},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_b3_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_b3_contract_test'}});let close:(()=>Promise<void>)|undefined;
 try{
 const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_b3_contract_test');
 assert.equal(existsSync(new URL('../migrations/20261009090000__service_grid_coverage.js',import.meta.url)),true,'B3 additive migration missing');
 for(const name of ['service_grid_community','service_grid_admin','service_grid_revision','community','admin_grid','grid_enterprise','service_grid','enterprise','dict_type','dict_item','operation_audit_log','app_user','complaint','analysis_record','business_event'])await db.schema.dropTableIfExists(name);
 // Declared fixture contract; this is NOT a copy of the unavailable original DDL.
 await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,business_type varchar(64),district_code varchar(64) null) engine=InnoDB');
 await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_pair(grid_code,enterprise_code)) engine=InnoDB');
 await db.raw('create table enterprise(enterprise_code varchar(64) primary key,enterprise_name varchar(128),business_type varchar(64),status varchar(16),version bigint, district_code varchar(64)) engine=InnoDB');
 await db.raw('create table dict_type(dict_type varchar(64) primary key,dict_name varchar(128),status varchar(16),version bigint,published tinyint,read_only tinyint,fixed_codes tinyint) engine=InnoDB');
 await db.raw('create table dict_item(item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16),version bigint,published tinyint,parent_code varchar(64),sort_order int) engine=InnoDB');
 await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
 await db.raw('create table app_user(user_id varchar(64),username varchar(64)) engine=InnoDB');
 await db.raw('create table complaint(complaint_id varchar(64) primary key,complaint_no varchar(64),enterprise_code varchar(64),district_code varchar(64),deleted int default 0) engine=InnoDB');
 await db.raw('create table analysis_record(analysis_id varchar(64),complaint_id varchar(64)) engine=InnoDB');await db.raw('create table business_event(event_id varchar(64),source_business_id varchar(64)) engine=InnoDB');
 await db('dict_type').insert([{dict_type:'business_type',dict_name:'业务',status:'enabled',version:1,published:1,read_only:0,fixed_codes:1},{dict_type:'district',dict_name:'区划',status:'enabled',version:1,published:1,read_only:0,fixed_codes:1}]);
 await db('dict_item').insert([{item_id:'water',dict_type:'business_type',item_value:'water',item_label:'供水',status:'enabled',version:1,published:1},{item_id:'gas',dict_type:'business_type',item_value:'gas',item_label:'燃气',status:'enabled',version:1,published:1},{item_id:'D1',dict_type:'district',item_value:'D1',item_label:'合成区甲',status:'enabled',version:1,published:1},{item_id:'D2',dict_type:'district',item_value:'D2',item_label:'合成区乙',status:'enabled',version:1,published:1}]);
 await db('enterprise').insert([{enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',status:'enabled',version:1,district_code:'D2'},{enterprise_code:'E2',enterprise_name:'合成燃气',business_type:'gas',status:'enabled',version:1,district_code:'D1'}]);
 const migration=require('../migrations/20261009090000__service_grid_coverage.js');await migration.up(db);
 const {serviceGridService:service}=await import('../src/services/serviceGridService');const {pool}=await import('../src/db/pool');close=()=>pool.end();const {withTransaction}=await import('../src/db/tx');
 const all={userId:'synthetic',userName:'Synthetic',clientIp:null,permissionCodes:['grid.read','grid.manage','system.audit.read'],access:{userId:'synthetic',roles:[],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false}};
 const scoped={...all,access:{...all.access,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:['D1']}]}};
 const geometry={type:'Polygon' as const,coordinates:[[[0,0],[1,0],[1,1],[0,0]]]};
 const master={code:'A1',name:'合成行政甲',districtCode:'D1',expectedVersion:0,geometry:null,coordinateSystem:null,geometrySource:null};
 await t.test('controlled stable admin/community maintenance validates permissions ownership and geometry',async()=>{
 await service.saveAdmin(master,all);await service.saveAdmin({...master,code:'A2',districtCode:'D2',name:'合成行政乙'},all);
 await service.saveCommunity({code:'X',name:'合成小区X',adminGridCode:'A1',expectedVersion:0},all);await service.saveCommunity({code:'Y',name:'合成小区Y',adminGridCode:'A2',expectedVersion:0},all);
 const n=Number((await db('operation_audit_log').count('* as n').first()).n);assert.equal((await service.saveAdmin({...master,expectedVersion:1},all)).changed,false);assert.equal((await service.saveCommunity({code:'X',name:'合成小区X',adminGridCode:'A1',expectedVersion:1},all)).changed,false);assert.equal(Number((await db('operation_audit_log').count('* as n').first()).n),n);
 await assert.rejects(()=>service.saveAdmin({...master,code:'DENIED'}, {...all,permissionCodes:['grid.read']}),{status:403});
 await assert.rejects(()=>service.saveAdmin({...master,code:'BAD',geometry:{...geometry,coordinates:[[[0,0],[1,1],[1,0],[0,1],[0,0]]]},coordinateSystem:'WGS84',geometrySource:'synthetic fixture'},all),{status:400});
 await assert.rejects(()=>service.saveAdmin({...master,code:'BAD',geometry,coordinateSystem:'GCJ02',geometrySource:'synthetic fixture'},all),{status:400});
 await assert.rejects(()=>service.saveAdmin({...master,code:'A2',expectedVersion:1},scoped),{status:404});
 });
 const input={code:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:['X'],validFrom:'2026-01-01',validTo:null,expectedVersion:0};
 await t.test('G1/G2 X/Y save/reload multi-grid no-op type/ownership stale version and rollback',async()=>{
 const saved=await service.save(input,scoped);assert.equal(saved.version,1);assert.equal(saved.value.geometry,null);assert.equal((await service.detail('G1',scoped)).enterpriseCode,'E1');
 await service.save({...input,code:'G2'},all);
 assert.equal((await service.list({page:1,size:20},scoped)).total,2);
 await assert.rejects(()=>service.save({...input,businessType:'gas',code:'BAD'},all),{status:400});await assert.rejects(()=>service.save({...input,communityCodes:['Y'],code:'BAD'},all),{status:400});
 await assert.rejects(()=>service.save({...input,expectedVersion:0},all),{status:409});
 const auditCount=Number((await db('operation_audit_log').count('* as n').first()).n);const noop=await service.save({...input,expectedVersion:1},all);assert.equal(noop.changed,false);assert.equal(Number((await db('operation_audit_log').count('* as n').first()).n),auditCount);
 await assert.rejects(()=>withTransaction(async tx=>{await service.saveInTx(tx,{...input,adminGridCodes:['A2'],communityCodes:['Y'],validFrom:'2026-07-01',expectedVersion:1},all);throw Error('rollback');}));assert.deepEqual((await service.detail('G1',all)).adminGridCodes,['A1']);
 });
 await t.test('all actual coverage pairs govern list/count/detail/history/boundary/write without master district substitution',async()=>{
 await service.save({...input,code:'MULTI',adminGridCodes:['A1','A2'],communityCodes:['X','Y']},all);
 assert.equal((await service.list({page:1,size:20},scoped)).total,2);
 for(const read of [()=>service.detail('MULTI',scoped),()=>service.history('MULTI',scoped),()=>service.boundary('MULTI',scoped)])await assert.rejects(read,{status:404});
 await assert.rejects(()=>service.save({...input,code:'MULTI',expectedVersion:1,validFrom:'2026-07-01'},scoped),{status:404});
 await assert.rejects(()=>service.save({...input,code:'NEW-MULTI',adminGridCodes:['A1','A2'],communityCodes:['X','Y']},scoped),{status:404});
 assert.equal((await service.list({page:1,size:20},{...scoped,access:{...scoped.access,rules:[]}})).total,0);
 const options=await service.referenceOptions(scoped);assert.deepEqual(options.adminGrids.map(x=>x.code),['A1']);assert.deepEqual(options.communities.map(x=>x.code),['X']);assert.ok(options.enterprises.every(x=>!('contactPhone' in x)));
 });
 await t.test('effective half-open coverage preserves revisions dependencies and overlaps fail atomically',async()=>{
 const two=await service.save({...input,adminGridCodes:['A2'],communityCodes:['Y'],validFrom:'2026-07-01',expectedVersion:1,expectedEnterpriseVersion:1,expectedBusinessTypeVersion:1,expectedAdminVersions:{A2:1},expectedCommunityVersions:{Y:1}},all);assert.equal(two.version,2);
 assert.deepEqual((await service.detail('G1',all,'2026-06-30')).adminGridCodes,['A1']);assert.deepEqual((await service.detail('G1',all,'2026-07-01')).communityCodes,['Y']);assert.equal((await service.history('G1',all))[0].validTo,'2026-07-01');
 await assert.rejects(()=>service.detail('G1',scoped,'2026-01-01'),{status:404});
 await assert.rejects(()=>service.save({...input,validFrom:'2026-03-01',validTo:'2026-04-01',expectedVersion:2},all),{status:409});
 await assert.rejects(()=>service.save({...input,code:'STALE',expectedAdminVersions:{A1:9}},all),{status:409});
 const races=await Promise.allSettled([service.save({...input,validFrom:'2027-01-01',expectedVersion:2},all),service.save({...input,validFrom:'2027-02-01',expectedVersion:2},all)]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
 });
 await t.test('authorized boundary reload uses valid source-labelled WGS84 geometry; missing source null and no unique overlap inference',async()=>{
 await service.saveAdmin({...master,expectedVersion:1,geometry,coordinateSystem:'WGS84',geometrySource:'synthetic fixture'},all);
 await service.save({...input,code:'SHAPE',expectedAdminVersions:{A1:2}},all);await service.save({...input,code:'OVERLAP',expectedAdminVersions:{A1:2}},all);
 const view=await service.boundary('SHAPE',scoped);assert.equal(view.geometry?.type,'FeatureCollection');assert.equal(view.coordinateSystem,'WGS84');assert.deepEqual(view.geometrySources,['synthetic fixture']);
 assert.equal((await service.boundary('G2',scoped)).geometry,null);
 await assert.rejects(()=>service.saveAdmin({...master,code:'A1',districtCode:'D2',expectedVersion:2},all),{status:409});
 await assert.rejects(()=>service.saveCommunity({code:'X',name:'x',adminGridCode:'A2',expectedVersion:1},all),{status:409});
 });
 await t.test('actual routes enforce capabilities and scoped audit stable type/action keys ignore complaint collisions',async()=>{
 const {gridsRouter}=await import('../src/routes/grids');const {enforceRolePolicy}=await import('../src/middleware/requireRole');const {errorHandler}=await import('../src/middleware/errorHandler');const {runWithAccessContext}=await import('../src/auth/accessScope');
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:'route',username:'route',roles:['custom'],permissionCodes:req.headers['x-denied']==='yes'?['grid.read']:['grid.read','grid.manage']};req.accessContext=scoped.access;runWithAccessContext(scoped.access,()=>next());});app.use(enforceRolePolicy());app.use(gridsRouter);app.use(errorHandler);
 assert.equal((await request(app).post('/grids').set('x-denied','yes').send({...input,code:'DENIED'})).status,403);
 assert.equal((await request(app).get('/grids/MULTI/boundary')).status,404);assert.equal((await request(app).get('/grids/MULTI')).status,404);
 const api=await request(app).get('/grids');assert.equal(api.status,200);assert.ok(api.body.data.content.every((x:any)=>x.code!=='MULTI'));
 await db('complaint').insert({complaint_id:'MULTI',complaint_no:'collision',enterprise_code:'E1',district_code:'D1'});
 await db('operation_audit_log').insert([{audit_id:'COLLISION',biz_type:'service_grid',biz_id:'MULTI',action:'SERVICE_GRID_SAVE',result:'success',created_at:new Date(),detail:JSON.stringify({code:'SHAPE',secret:'SECRET'})},{audit_id:'UNKNOWN',biz_type:'service_grid',biz_id:'SHAPE',action:'LOGIN',result:'success',created_at:new Date(),detail:'{}'}]);
 const {AuditQueryService}=await import('../src/services/auditQueryService');const query=new AuditQueryService();const access={...scoped.access,permissionCodes:['system.audit.read']};await assert.rejects(()=>query.detail('COLLISION',access),{status:404});await assert.rejects(()=>query.detail('UNKNOWN',{...all.access,permissionCodes:['system.audit.read']}),{status:404});
 const logs=await query.list({module:'service_grid'},{page:1,size:100},access);assert.ok(logs.total>0);assert.equal(JSON.stringify(logs).includes('SECRET'),false);assert.ok(logs.content.every(x=>x.bizId!=='MULTI'));
 const admins=await query.list({module:'admin_grid'},{page:1,size:100},access);assert.ok(admins.total>0);assert.ok(admins.content.every(x=>x.bizId==='A1'));
 });
 await migration.up(db);
 await t.test('migration validates all legacy contracts before any mutation and preserves existing baseline rows',async()=>{
 await db('service_grid').insert({grid_code:'LEGACY',grid_name:'原数据',business_type:'water',district_code:null});await migration.up(db);assert.equal((await db('service_grid').where('grid_code','LEGACY').first()).grid_name,'原数据');assert.equal((await service.detail('LEGACY',all)).geometry,null);
 await assert.rejects(()=>service.detail('LEGACY',scoped),{status:404});
 await service.save({...input,code:'LEGACY',expectedVersion:0},all);assert.equal((await service.detail('LEGACY',scoped)).enterpriseCode,'E1');assert.equal((await db('service_grid').where('grid_code','LEGACY').first()).grid_name,'原数据');
 await db.raw('alter table grid_enterprise change enterprise_code unsupported varchar(64) not null');await assert.rejects(()=>migration.up(db),/grid_enterprise.enterprise_code/);await db.raw('alter table grid_enterprise change unsupported enterprise_code varchar(64) not null');
 });
 }finally{await close?.();await db.destroy();}
});
