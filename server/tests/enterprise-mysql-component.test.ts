import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import express from 'express';
import request from 'supertest';
import {prepareGridAuditFixture} from './helpers/gridAuditFixture';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_B2_COMPONENT_DB==='gqxq_b2_contract_test';
test('B2 guarded real MySQL enterprise component (declared base, not canonical)',{skip:!enabled},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_b2_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_b2_contract_test'}});
 let close:(()=>Promise<void>)|undefined;
 try{
 const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_b2_contract_test');
 assert.equal(existsSync(new URL('../migrations/20261009080000__enterprise_management.js',import.meta.url)),true,'B2 additive enterprise migration missing');
 for(const name of ['enterprise_department_mapping','enterprise_household_version','enterprise_revision','enterprise','dictionary_code_registry','dictionary_version','dict_item','dict_type','complaint_category_revision','complaint','operation_audit_log','app_user','analysis_record','business_event','dispatch_order'])await db.schema.dropTableIfExists(name);
 await db.raw('create table enterprise(id bigint auto_increment primary key,enterprise_code varchar(64) not null unique,enterprise_name varchar(128) not null,business_type varchar(64),uscc varchar(18),legal_person varchar(64),contact_person varchar(64),contact_phone varchar(64),service_area varchar(500),annual_score decimal(5,2),status varchar(16)) engine=InnoDB');
 await db.raw('create table dict_type(id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(16)) engine=InnoDB');
 await db.raw('create table dict_item(id bigint auto_increment primary key,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16)) engine=InnoDB');
 await db.raw('create table complaint(complaint_id varchar(64) primary key,complaint_no varchar(64),enterprise_code varchar(64),district_code varchar(64),deleted int default 0) engine=InnoDB');
 await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
 await db.raw('create table dispatch_order(assignment_id varchar(64),target_enterprise_code varchar(64),target_enterprise_name varchar(128)) engine=InnoDB');
 await db.raw('create table app_user(user_id varchar(64),username varchar(64)) engine=InnoDB');
 await db.raw('create table analysis_record(analysis_id varchar(64),complaint_id varchar(64)) engine=InnoDB');
 await db.raw('create table business_event(event_id varchar(64),source_business_id varchar(64)) engine=InnoDB');
 await db('dict_type').insert([{dict_type:'business_type',dict_name:'业务',status:'enabled'},{dict_type:'district',dict_name:'区划',status:'enabled'}]);
 await db('dict_item').insert([{item_id:'water',dict_type:'business_type',item_value:'water',item_label:'供水',status:'enabled'},{item_id:'gas',dict_type:'business_type',item_value:'gas',item_label:'燃气',status:'disabled'},{item_id:'district1',dict_type:'district',item_value:'420502',item_label:'虚构区甲',status:'enabled'},{item_id:'district2',dict_type:'district',item_value:'420503',item_label:'虚构区乙',status:'enabled'}]);
 await require('../migrations/20261009070000__dictionary_governance_categories.js').up(db);
 await require('../migrations/20261009080000__enterprise_management.js').up(db);
 await prepareGridAuditFixture(db);
 const {enterpriseService:service,getHouseholdsAt}=await import('../src/services/enterpriseService');
 const {pool}=await import('../src/db/pool');close=()=>pool.end();
 const {withTransaction}=await import('../src/db/tx');const {runWithAccessContext}=await import('../src/auth/accessScope');
 const all={userId:'master',userName:'Synthetic master',clientIp:null,permissionCodes:['enterprise.manage','enterprise.read','system.audit.read'],access:{userId:'master',roles:[],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false}};
 const restricted={...all,access:{...all.access,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:[]}]}};
 const enterprise={enterpriseCode:'E1',enterpriseName:'虚构企业甲',businessType:'water',status:'enabled' as const,expectedVersion:0,districtCode:'420502',contactPerson:'CONTACT_SECRET'};
 await t.test('create/read duplicate optimistic version no-op and caller rollback',async()=>{
 const created=await service.save(enterprise,all);assert.equal(created.version,1);assert.equal(created.key,'E1');
 assert.equal((await service.detail('E1',all)).contactPerson,'CONTACT_SECRET');
 await assert.rejects(()=>service.save(enterprise,all),{status:409});
 const before=await db('operation_audit_log').count('* as n').first();const noop=await service.save({...enterprise,expectedVersion:1},all);assert.equal(noop.changed,false);assert.equal((await db('operation_audit_log').count('* as n').first()).n,before.n);
 await assert.rejects(()=>withTransaction(async tx=>{await service.saveInTx(tx,{...enterprise,enterpriseName:'rolled back',expectedVersion:1},all);throw Error('rollback');}));assert.equal((await service.detail('E1',all)).enterpriseName,enterprise.enterpriseName);
 await assert.rejects(()=>service.save({...enterprise,enterpriseName:'stale',expectedVersion:0},all),{status:409});
 });
 await t.test('scope new objects, locked before and resulting scope; no complaint-dependent authorization',async()=>{
 await service.save({...enterprise,enterpriseCode:'E2',enterpriseName:'企业乙',districtCode:'420503'},all);
 await assert.rejects(()=>service.detail('E2',restricted),{status:404});
 const district={...all,access:{...all.access,rules:[{kind:'restricted' as const,enterpriseCodes:[],districtCodes:['420502']}]}};
 await assert.rejects(()=>service.save({...enterprise,districtCode:'420503',expectedVersion:1},district),{status:404});
 const fresh={...restricted,access:{...restricted.access,rules:[{kind:'restricted' as const,enterpriseCodes:['NEW'],districtCodes:[]}]}};
 await service.save({...enterprise,enterpriseCode:'NEW',districtCode:null},fresh);
 await assert.rejects(()=>service.detail('NEW',district),{status:404});
 await assert.rejects(()=>service.save({...enterprise,enterpriseCode:'BAD',districtCode:'unknown'},all),{status:400});
 await assert.rejects(()=>service.save({...enterprise,enterpriseCode:'GAS',businessType:'gas'},all),{status:400});
 });
 await t.test('effective half-open periods retain old denominator; overlap serializes and no-op persists nothing',async()=>{
 const one=await service.saveHouseholds({enterpriseCode:'E1',households:20000,validFrom:'2026-01-01',validTo:null,expectedVersion:1},all);assert.equal(one.version,2);
 const two=await service.saveHouseholds({enterpriseCode:'E1',households:30000,validFrom:'2026-07-01',validTo:null,expectedVersion:2},all);assert.equal(two.version,3);
 await runWithAccessContext(all.access,async()=>{assert.equal((await getHouseholdsAt('E1','2026-06-30'))?.households,20000);assert.equal((await getHouseholdsAt('E1','2026-07-01'))?.households,30000);});
 assert.equal((await service.saveHouseholds({enterpriseCode:'E1',households:30000,validFrom:'2026-07-01',validTo:null,expectedVersion:3},all)).changed,false);
 await assert.rejects(()=>service.saveHouseholds({enterpriseCode:'E1',households:12,validFrom:'2026-03-01',validTo:'2026-04-01',expectedVersion:3},all),{status:409});
 const race=await Promise.allSettled([service.saveHouseholds({enterpriseCode:'E1',households:40000,validFrom:'2027-01-01',validTo:null,expectedVersion:3},all),service.saveHouseholds({enterpriseCode:'E1',households:50000,validFrom:'2027-02-01',validTo:null,expectedVersion:3},all)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal((await db('enterprise_household_version').where('enterprise_code','E1')).length,3);
 });
 await t.test('stable department identity verified aliases and no implicit name merge',async()=>{
 const input={sourceSystem:'synthetic',sourceDepartmentCode:'D1',sourceDepartmentName:'甲部门',enterpriseCode:'E1',entityType:'enterprise' as const,aliases:['同名'],verified:false,expectedVersion:0,expectedEnterpriseVersion:4};
 const saved=await service.saveMapping(input,all);assert.equal(saved.version,1);assert.equal(await service.resolveDepartment('synthetic','D1',all),null);
 assert.equal((await service.saveMapping({...input,verified:true,expectedVersion:1},all)).version,2);assert.equal((await service.resolveDepartment('synthetic','D1',all))?.enterpriseCode,'E1');assert.equal(await service.resolveDepartment('synthetic','同名',all),null);
 await assert.rejects(()=>service.saveMapping({...input,entityType:'government' as any},all),{status:400});
 await assert.rejects(()=>service.saveMapping({...input,sourceDepartmentCode:'D2',enterpriseCode:'missing'},all),{status:404});
 });
 await t.test('master audit uses stable enterprise key and current scope, rejects action collisions and raw details',async()=>{
 const {AuditQueryService}=await import('../src/services/auditQueryService');const query=new AuditQueryService();
 await db('complaint').insert({complaint_id:'E2',enterprise_code:'E1',district_code:'420502',deleted:0});
 await db('operation_audit_log').insert([{audit_id:'FOREIGN',biz_type:'enterprise',biz_id:'E2',action:'ENTERPRISE_SAVE',result:'success',created_at:new Date(),detail:JSON.stringify({contactPerson:'SECRET',enterpriseCode:'E1',before:{secret:'SECRET'}})},{audit_id:'WRONG',biz_type:'enterprise',biz_id:'E1',action:'CATEGORY_REVISE',result:'success',created_at:new Date(),detail:'{}'}]);
 const access={...restricted.access,permissionCodes:['system.audit.read']};await assert.rejects(()=>query.detail('FOREIGN',access),{status:404});await assert.rejects(()=>query.detail('WRONG',{...all.access,permissionCodes:['system.audit.read']}),{status:404});
 const result=await query.list({module:'enterprise'},{page:1,size:100},access);assert.ok(result.total>0);assert.equal(JSON.stringify(result).includes('CONTACT_SECRET'),false);assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.ok(result.content.every(x=>x.bizId==='E1'));
 });

 await t.test('actual capability middleware/routes deny revoked writes and picker leaks no operating data',async()=>{
 const {enterprisesRouter}=await import('../src/routes/enterprises');const {enforceRolePolicy}=await import('../src/middleware/requireRole');const {errorHandler}=await import('../src/middleware/errorHandler');
 const app=express();app.use(express.json());app.use((req,res,next)=>{const denied=req.headers['x-denied']==='yes';req.user={id:'route-user',username:'route-user',roles:['custom'],permissionCodes:denied?['enterprise.read']:['enterprise.read','enterprise.manage']};req.accessContext=restricted.access;runWithAccessContext(restricted.access,()=>next());});app.use(enforceRolePolicy());app.use(enterprisesRouter);app.use(errorHandler);
 const denied=await request(app).post('/enterprises').set('x-denied','yes').send({...enterprise,enterpriseCode:'DENIED'});assert.equal(denied.status,403);assert.equal(await db('enterprise').where('enterprise_code','DENIED').first(),undefined);
 const list=await request(app).get('/enterprises');assert.equal(list.status,200);assert.equal(list.body.data.total,1);assert.equal(list.body.data.content[0].enterpriseCode,'E1');
 assert.equal((await request(app).get('/enterprises/E2')).status,404);
 const options=await request(app).get('/enterprise-options');assert.equal(options.status,200);assert.ok(options.body.data.some((x:any)=>x.enterpriseCode==='E2'));assert.ok(options.body.data.every((x:any)=>Object.keys(x).sort().join(',')==='businessType,enterpriseCode,enterpriseName,status'));
 const reference=await request(app).get('/enterprise-reference-options');assert.equal(reference.status,200);assert.deepEqual(reference.body.data.businessTypes,[{value:'water',label:'供水'}]);
 });
 await t.test('different legitimate target remains valid; referenced enterprise controlled stop retains historical snapshot',async()=>{
 const {assertTargetEnterprise}=await import('../src/services/assignmentService');
 await runWithAccessContext(restricted.access,()=>withTransaction(tx=>assertTargetEnterprise(tx,'E2',null)));
 await db('dispatch_order').insert({assignment_id:'OLD',target_enterprise_code:'E2',target_enterprise_name:'企业乙'});
 await assert.rejects(()=>service.save({...enterprise,enterpriseCode:'E2',enterpriseName:'新企业乙',status:'disabled',expectedVersion:1},all),{status:400});
 await service.save({...enterprise,enterpriseCode:'E2',enterpriseName:'新企业乙',status:'disabled',disableReason:'虚构停用依据',expectedVersion:1},all);
 assert.equal((await db('dispatch_order').where('assignment_id','OLD').first()).target_enterprise_name,'企业乙');
 const stopAudit=await db('operation_audit_log').where({biz_type:'enterprise',biz_id:'E2',action:'ENTERPRISE_SAVE'}).orderBy('id','desc').first();const stopDetail=typeof stopAudit.detail==='string'?JSON.parse(stopAudit.detail):stopAudit.detail;assert.equal(stopDetail.disableReason,'虚构停用依据');
 await assert.rejects(()=>runWithAccessContext(restricted.access,()=>withTransaction(tx=>assertTargetEnterprise(tx,'E2',null))),{status:400});
 const {findEnterpriseOptions}=await import('../src/repositories/enterpriseRepo');assert.equal((await findEnterpriseOptions() as any[]).some(x=>x.enterpriseCode==='E2'),false);
 });

 await t.test('unchanged disabled historical dictionary district stays editable; new disabled district rejected',async()=>{
 await db('dict_item').where({dict_type:'district',item_value:'420502'}).update({status:'disabled'});
 const current=await service.detail('E1',all);await service.save({...enterprise,enterpriseName:'核实历史企业',expectedVersion:current.version},all);
 await assert.rejects(()=>service.save({...enterprise,enterpriseCode:'OFF-DISTRICT',expectedVersion:0},all),{status:400});
 });
 await require('../migrations/20261009080000__enterprise_management.js').up(db);
 }finally{await close?.();await db.destroy();}
});
