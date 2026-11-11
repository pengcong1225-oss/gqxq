import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {puEnterpriseSchema,choosePuEnterpriseTarget,sourceEnterpriseStatus,type PuEnterpriseSource} from '../src/domain/puEnterprise';
import {applyPuEnterprise,retireMissingPuEnterprises,syncPuEnterpriseFeed,puEnterpriseSyncStatus,puEnterpriseSystemContext,puEnterpriseBinding} from '../src/services/puEnterpriseSyncService';
import {enterpriseService} from '../src/services/enterpriseService';
import {pool} from '../src/db/pool';
import {env} from '../src/config/env';

const source:PuEnterpriseSource={feedId:9,sourceKind:'company',sourceId:'9',sourceEnterpriseId:'PU-COMPANY-9',gqxqSubjectCode:'PU-COMPANY-9',sourceSubjectId:'42',sourceAppCode:'legacy',organizationCode:'SHARED-REGULATOR',companyName:'同名供水企业',businessTypes:['water'],creditCode:null,status:'enabled',dataMode:'real',revision:'source-one',subjectAliases:[{subjectId:'42',sourceAppCode:'legacy',subjectCode:'OLD-SOURCE-9',status:'ACTIVE'}],accountReadiness:{activeAccountCount:0,hasActiveEnterpriseAccount:false,canReceiveTask:false},provenance:{sourceSystem:'legacy',sourceModule:'legacy_company',migrationBatchId:5}};
test('PU identity is source company plus business, never a shared name or regulator organization',()=>{
 assert.equal(puEnterpriseSchema.parse(source).sourceId,'9');
 assert.equal(choosePuEnterpriseTarget(source,'water',null,[]).enterpriseCode,'PU-COMPANY-9-water');
 assert.equal(choosePuEnterpriseTarget({...source,sourceId:'10',sourceEnterpriseId:'PU-COMPANY-10',gqxqSubjectCode:'PU-COMPANY-10'},'water',null,[]).enterpriseCode,'PU-COMPANY-10-water');
 assert.equal(choosePuEnterpriseTarget(source,'water',{enterpriseCode:'BOUND'},[{enterpriseCode:'CREDIT',businessType:'water'}]).enterpriseCode,'BOUND');
 assert.equal(choosePuEnterpriseTarget(source,'water',null,[{enterpriseCode:'CREDIT',businessType:'water'}]).enterpriseCode,'CREDIT');
 assert.throws(()=>choosePuEnterpriseTarget(source,'water',null,[{enterpriseCode:'A',businessType:'water'},{enterpriseCode:'B',businessType:'water'}]));
 assert.throws(()=>puEnterpriseSchema.parse({...source,accountReadiness:{...source.accountReadiness,canReceiveTask:true}}));
 assert.throws(()=>puEnterpriseSchema.parse({...source,status:'1'}));assert.equal(sourceEnterpriseStatus('unknown'),'disabled');
});

function memoryDatabase(){
 const enterprises=new Map<string,any>(),bindings=new Map<string,any>(),stores=new Map<string,any>(),audits:any[]=[],writes:string[]=[];
 const key=(kind:string,id:string,business:string)=>kind+':'+id+':'+business;
 const query=async(sql:string,args:any[]=[])=>{
  if(sql.includes('from dict_type'))return [[{code:args[0],name:args[0],status:'enabled',version:1,published:1}],[]];
  if(sql.includes('from dict_item'))return [['water','gas','lpg'].map((code,i)=>({itemId:i,typeCode:'business_type',code,label:code,status:'enabled',version:1,published:1,sort:i,parentCode:null})),[]];
  if(sql.includes('from pu_enterprise_binding')){
   let rows=[...bindings.values()];if(sql.includes('where enterprise_code=?'))rows=rows.filter(r=>r.enterprise_code===args[0]);else if(sql.includes('source_system=?'))rows=rows.filter(r=>r.source_system===args[0]&&r.source_kind===args[1]&&r.source_id===args[2]&&r.business_type===args[3]);
   return [rows.map(r=>({...r,enterpriseCode:r.enterprise_code})),[]];
  }
  if(sql.includes('from enterprise where uscc=?'))return [[...enterprises.values()].filter(e=>e.uscc===args[0]&&e.business_type===args[1]).map(e=>({enterpriseCode:e.enterprise_code,businessType:e.business_type})),[]];
  if(sql.includes('from enterprise where enterprise_code=?'))return [enterprises.has(args[0])?[{...enterprises.get(args[0])}]:[],[]];
  if(sql.includes('from gqxq_tender_support_store')){const row=stores.get(args[0]);return [row?[{revision:row.revision,content:JSON.stringify(row.content,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v)}]:[],[]];}
  throw Error('Unexpected query '+sql);
 };
 const execute=async(sql:string,args:any[])=>{
  writes.push(sql);
  if(sql.startsWith('update enterprise set')||sql.startsWith('insert into enterprise(')){
   const columns=['enterprise_name','business_type','status','version','district_code','uscc','legal_person','contact_person','contact_phone','service_area','address','display_on_screen','screen_name'];
   const code=args[13],before=enterprises.get(code)??{id:enterprises.size+1,enterprise_code:code,annual_score:null};enterprises.set(code,{...before,...Object.fromEntries(columns.map((c,i)=>[c,args[i]]))});return [{insertId:before.id},[]];
  }
  if(sql.startsWith('insert into pu_enterprise_binding')){
   const columns=['source_system','source_kind','source_id','business_type','enterprise_code','source_enterprise_id','source_subject_id','source_app_code','source_organization_code','gqxq_subject_code','source_revision','account_readiness','source_payload'];const value={...Object.fromEntries(columns.map((c,i)=>[c,args[i]])),updated_at:new Date()};bindings.set(key(args[1],args[2],args[3]),value);
  }else if(sql.startsWith('update pu_enterprise_binding')){const b=[...bindings.values()].find(b=>b.enterprise_code===args[2]);b.account_readiness=args[0];b.source_payload=args[1];b.updated_at=new Date();}
  else if(sql.startsWith('insert ignore into gqxq_tender_support_store')){if(!stores.has(args[0]))stores.set(args[0],{revision:0,content:{}});}
  else if(sql.startsWith('update gqxq_tender_support_store'))stores.set(args[3],{revision:args[0],content:JSON.parse(args[1])});
  else if(sql.startsWith('insert into operation_audit_log'))audits.push(args);
  else if(!sql.startsWith('insert into enterprise_revision')&&!sql.startsWith('insert into gqxq_tender_support_history'))throw Error('Unexpected execute '+sql);
  return [{affectedRows:1},[]];
 };
 const q=test.mock.method(pool,'query',query as any),c=test.mock.method(pool,'getConnection',async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}}) as any);
 return {enterprises,bindings,stores,audits,writes,restore:()=>{q.mock.restore();c.mock.restore();}};
}

test('source updates preserve local operating metadata, reject manual authority edits, remain idempotent and retire missing identities',async()=>{
 const db=memoryDatabase();
 db.enterprises.set('LOCAL',{id:1,enterprise_code:'LOCAL',enterprise_name:'原企业名',business_type:'water',status:'enabled',version:7,uscc:null,legal_person:null,contact_person:'本地联系人',contact_phone:'本地电话',service_area:'本地经营范围',address:'本地补充地址',district_code:'420502',display_on_screen:1,screen_name:'本地大屏简称',annual_score:88});
 db.bindings.set('company:9:water',{source_system:'public-utility',source_kind:'company',source_id:'9',business_type:'water',enterprise_code:'LOCAL',source_revision:'old',source_payload:JSON.stringify({...source,revision:'old',ownedFields:['enterpriseName','businessType','status']}),account_readiness:JSON.stringify(source.accountReadiness),updated_at:new Date()});
 try{
  const first=await applyPuEnterprise(source);assert.equal(first[0].enterpriseCode,'LOCAL');assert.equal(first[0].changed,true);
  const saved=db.enterprises.get('LOCAL');assert.equal(saved.enterprise_name,source.companyName);assert.equal(saved.version,8);
  for(const [field,value] of Object.entries({contact_person:'本地联系人',contact_phone:'本地电话',service_area:'本地经营范围',address:'本地补充地址',district_code:'420502',display_on_screen:1,screen_name:'本地大屏简称',annual_score:88}))assert.equal(saved[field],value,field);
  assert.ok(!db.writes.some(s=>s.includes('household')||s.includes('service_grid')));
  const writes=db.writes.length;assert.equal((await applyPuEnterprise(source))[0].changed,false);assert.equal(db.writes.length,writes,'unchanged source does not create audit or enterprise revisions');
  await assert.rejects(enterpriseService.save({enterpriseCode:'LOCAL',enterpriseName:'本地冒改来源名称',businessType:'water',status:'enabled',expectedVersion:8},{...puEnterpriseSystemContext,userId:'real-admin'}),/来源企业字段/);
  await assert.rejects(applyPuEnterprise({...source,dataMode:'simulation'}),/模拟企业/);assert.equal(db.enterprises.size,1);
  const blankAddress={...source,address:'   ',revision:'blank-address'};await applyPuEnterprise(blankAddress);assert.equal(db.enterprises.get('LOCAL').address,null,'explicit blank source address clears its previous value');const afterBlank=db.writes.length;assert.equal((await applyPuEnterprise(blankAddress))[0].changed,false);assert.equal(db.writes.length,afterBlank,'normalized blank address never repeats audit/update writes');
  const nullAddress={...source,address:null,revision:'null-address'};await applyPuEnterprise(nullAddress);assert.equal(db.enterprises.get('LOCAL').address,null);const afterNull=db.writes.length;assert.equal((await applyPuEnterprise(nullAddress))[0].changed,false);assert.equal(db.writes.length,afterNull,'explicit null source is stable too');
  await applyPuEnterprise({...source,address:'来源地址',revision:'known-address'});assert.equal(db.enterprises.get('LOCAL').address,'来源地址');await applyPuEnterprise({...source,address:null,revision:'cleared-address'});assert.equal(db.enterprises.get('LOCAL').address,null,'explicit null can clear an earlier source-owned address');
  assert.equal(await retireMissingPuEnterprises([]),1);assert.equal(db.enterprises.get('LOCAL').status,'disabled');assert.equal(db.enterprises.get('LOCAL').service_area,'本地经营范围');assert.equal(JSON.parse(db.bindings.get('company:9:water').account_readiness).canReceiveTask,false);assert.equal((await puEnterpriseBinding('LOCAL'))?.sourceStatus,'unavailable','retired source must not still display enabled');
  assert.equal(await retireMissingPuEnterprises([]),0,'retirement itself is idempotent');
  await applyPuEnterprise(source);assert.equal(db.enterprises.get('LOCAL').status,'enabled','same source can reappear without a new identity');
 }finally{db.restore();}
});

test('signed complete scan handles empty department pages, preserves active bindings on interrupted scans and detects simulation mode mismatch',async()=>{
 const db=memoryDatabase(),pu=env.pu as any,old={...pu};pu.baseUrl='http://pu.test';pu.secret='enterprise-test-secret';pu.keyId='key';process.env.GQXQ_PU_ENTERPRISE_SYNC_ENABLED='true';
 let phase='complete',requests=0;
 const fetchMock=test.mock.method(globalThis,'fetch',async(url:any,init:any)=>{
  requests++;const payload=JSON.parse(Buffer.from(init.body).toString('utf8'));assert.equal(payload.mode,'real');
  const path=new URL(String(url)).pathname;assert.equal(path,'/api/integrations/gqxq/utility-enterprises');
  const canonical=['v1','POST',path,init.headers['X-PU-Timestamp'],init.headers['X-PU-Nonce'],createHash('sha256').update(Buffer.from(init.body)).digest('hex')].join('\n');assert.equal(init.headers['X-PU-Signature'],createHmac('sha256','enterprise-test-secret').update(canonical).digest('hex'));
  if(phase==='broken'&&payload.afterId>0)return new Response('{}',{status:503});
  if(payload.afterId===0)return new Response(JSON.stringify({items:[],snapshotMaxId:9,nextAfterId:1,hasMore:true,departmentCount:1,unresolvedCount:0,unclassifiedCount:0}));
  return new Response(JSON.stringify({items:[phase==='simulation'?{...source,dataMode:'simulation'}:source],snapshotMaxId:9,nextAfterId:9,hasMore:false,departmentCount:2,unresolvedCount:0,unclassifiedCount:0}));
 });
 try{
  await syncPuEnterpriseFeed();assert.equal(requests,2);assert.equal(db.enterprises.size,1);const status=await puEnterpriseSyncStatus(puEnterpriseSystemContext);assert.equal(status.synced,1);assert.equal(status.departmentCount,3);
  const revision=db.stores.get('pu-enterprise-feed-real').revision;await syncPuEnterpriseFeed();assert.equal(db.stores.get('pu-enterprise-feed-real').revision,revision,'MySQL key normalization does not create repeated snapshots');
  phase='broken';await syncPuEnterpriseFeed();assert.equal(db.enterprises.get('PU-COMPANY-9-water').status,'enabled');assert.equal((await puEnterpriseSyncStatus(puEnterpriseSystemContext)).lastError?.includes('503'),true);
  const limited=await puEnterpriseSyncStatus({...puEnterpriseSystemContext,access:{...puEnterpriseSystemContext.access,rules:[{kind:'restricted',enterpriseCodes:['PU-COMPANY-9-water'],districtCodes:[]}]}});assert.equal(limited.restricted,true);assert.equal(limited.synced,null);assert.equal(limited.unclassifiedCount,null);assert.equal(limited.departmentCount,null);assert.equal(limited.lastError,null);assert.deepEqual(limited.rows,[]);
  phase='simulation';await syncPuEnterpriseFeed();assert.equal(db.enterprises.size,1);assert.equal(db.enterprises.get('PU-COMPANY-9-water').status,'enabled');assert.equal(db.stores.get('pu-enterprise-feed-real').revision,revision,'invalid/mismatched snapshot neither replaces state nor retires real records');
 }finally{fetchMock.mock.restore();db.restore();Object.assign(pu,old);delete process.env.GQXQ_PU_ENTERPRISE_SYNC_ENABLED;}
});
