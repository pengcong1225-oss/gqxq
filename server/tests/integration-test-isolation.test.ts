import test from 'node:test';
import assert from 'node:assert/strict';
import {INTEGRATION_TEST_ENTERPRISE,mayDispatchToDisabledTestEnterprise,isIntegrationTestComplaint,excludeIntegrationTestsSql} from '../src/domain/integrationTestPolicy';

test('disabled integration enterprise requires exact fixture identity and administrator',()=>{
 const row={source_system:'DEMO-20261110',source_id:'INTEGRATION-TEST-fixture'};
 assert.equal(mayDispatchToDisabledTestEnterprise(INTEGRATION_TEST_ENTERPRISE,row,['admin']),true);
 for(const roles of [[],['operator'],['supervisor']])assert.equal(mayDispatchToDisabledTestEnterprise(INTEGRATION_TEST_ENTERPRISE,row,roles),false);
 assert.equal(mayDispatchToDisabledTestEnterprise('ENT-WATER-001',row,['admin']),false);
 assert.equal(mayDispatchToDisabledTestEnterprise(INTEGRATION_TEST_ENTERPRISE,{...row,source_system:'宜接就办'},['admin']),false);
 assert.equal(mayDispatchToDisabledTestEnterprise(INTEGRATION_TEST_ENTERPRISE,{...row,source_id:'DEMO-normal'},['admin']),false);
 assert.equal(isIntegrationTestComplaint({source_system:null,source_id:null}),false);
});
test('aggregation exclusion requires both provenance markers and keeps ordinary DEMO data',()=>{
 assert.equal(isIntegrationTestComplaint({source_system:'DEMO-20261110',source_id:'ordinary-demo'}),false);
 assert.equal(isIntegrationTestComplaint({source_system:'宜接就办',source_id:'INTEGRATION-TEST-real-source-id'}),false);
 const sql=excludeIntegrationTestsSql('c');
 assert.match(sql,/coalesce\(c\.source_system,''\)='DEMO-20261110' and coalesce\(c\.source_id,''\) like 'INTEGRATION-TEST-%'/);
 assert.match(sql,/^\(not /);
 assert.throws(()=>excludeIntegrationTestsSql('unsafe' as 'c'));
});

test('enterprise writer rechecks locked provenance, administrator and master status',async()=>{
 process.env.GQXQ_DB_USER ||= 'isolated-unit';process.env.GQXQ_DB_NAME ||= 'isolated-unit';process.env.GQXQ_JWT_SECRET ||= 'isolated-unit-key';
 const {assertTargetEnterprise}=await import('../src/services/assignmentService');
 const {runWithAccessContext}=await import('../src/auth/accessScope');
 let source={source_system:'DEMO-20261110',source_id:'INTEGRATION-TEST-fixture'};
 let status='disabled';
 const tx={query:async(sql:string)=>sql.includes('from enterprise')?[[{enterprise_code:INTEGRATION_TEST_ENTERPRISE,enterprise_name:'Fixture',status}],[]]:[[source],[]]} as unknown as import('../src/db/tx').Tx;
 const context=(roles:string[])=>({userId:'fixture-admin',roles,scopeVersion:1,rules:[{kind:'all'} as const],canReadSource:false});
 const invoke=(roles:string[],id:string|undefined='fixture')=>runWithAccessContext(context(roles),()=>assertTargetEnterprise(tx,INTEGRATION_TEST_ENTERPRISE,'Fixture',{code:'code',name:'name'},id));
 assert.deepEqual(await invoke(['admin']),{code:INTEGRATION_TEST_ENTERPRISE,name:'Fixture'});
 await assert.rejects(invoke(['operator']),/停用/);
 await assert.rejects(runWithAccessContext(context(['admin']),()=>assertTargetEnterprise(tx,INTEGRATION_TEST_ENTERPRISE,'Fixture')),/停用/);
 source={...source,source_id:'normal-demo'};await assert.rejects(invoke(['admin']),/停用/);
 status='enabled';await assert.rejects(invoke(['admin']),/停用/);
 source={...source,source_id:'INTEGRATION-TEST-fixture',source_system:'宜接就办'};await assert.rejects(invoke(['admin']),/停用/);
});

test('normal enterprise directory and statistics SQL exclude the fixture before counting',async()=>{
 process.env.GQXQ_DB_USER ||= 'isolated-unit';process.env.GQXQ_DB_NAME ||= 'isolated-unit';process.env.GQXQ_JWT_SECRET ||= 'isolated-unit-key';
 const {pool}=await import('../src/db/pool');
 const {runWithAccessContext}=await import('../src/auth/accessScope');
 const {findEnterprises,findEnterpriseOptions}=await import('../src/repositories/enterpriseRepo');
 const {readStatisticsRows}=await import('../src/repositories/statisticsRepo');
 const saved=pool.query;
 const calls:Array<{sql:string;params:unknown[]}>=[];
 pool.query=(async(sql:string,params:unknown[])=>{calls.push({sql,params});return [sql.includes('count(*)')?[{total:0}]:[],[]];}) as typeof pool.query;
 const context={userId:'fixture-admin',roles:['admin'],scopeVersion:1,rules:[{kind:'all'} as const],canReadSource:false};
 try{
  await runWithAccessContext(context,()=>findEnterprises({},1,20));await findEnterpriseOptions();
  assert.equal(calls.length,3);
  for(const call of calls){assert.match(call.sql,/enterprise_code <> \?/);assert.ok(call.params.includes(INTEGRATION_TEST_ENTERPRISE));}
  let aggregateSql='';
  const db={query:async(sql:string)=>{aggregateSql=sql;return [[],[]];}};
  await readStatisticsRows(db,{dataset:'ledger'} as import('../src/types/statistics').StatisticsQuery,context);
  assert.ok(aggregateSql.includes(excludeIntegrationTestsSql('c')));
 }finally{pool.query=saved;}
});

test('ordinary complaint list and count hide explicit integration fixtures while direct id remains traceable',async()=>{
 process.env.GQXQ_DB_USER ||= 'isolated-unit';process.env.GQXQ_DB_NAME ||= 'isolated-unit';process.env.GQXQ_JWT_SECRET ||= 'isolated-unit-key';
 const {pool}=await import('../src/db/pool');const {runWithAccessContext}=await import('../src/auth/accessScope');
 const {buildWhere,findPage,findStats,findByIdOrNo}=await import('../src/repositories/complaintRepo');
 const access={userId:'fixture-admin',roles:['admin'],scopeVersion:1,rules:[{kind:'all'} as const],canReadSource:false};
 const calls:string[]=[];const original=pool.query;
 pool.query=(async(sql:string)=>{calls.push(sql);return [sql.includes(' limit 1')?[{complaint_id:'fixture',source_system:'DEMO-20261110',source_id:'INTEGRATION-TEST-fixture'}]:sql.includes('count(*)')?[{total:0}]:[],[]];}) as typeof pool.query;
 try{
  await runWithAccessContext(access,async()=>{
   assert.ok(buildWhere({}).text.includes(excludeIntegrationTestsSql('c')));
   await findPage({},1,20,'received_at_desc');await findStats({});
   for(const sql of calls)assert.ok(sql.includes(excludeIntegrationTestsSql('c')));
   const direct=await findByIdOrNo('fixture');assert.equal(direct?.complaint_id,'fixture');
   assert.equal(calls.at(-1)?.includes(excludeIntegrationTestsSql('c')),false);
  });
 }finally{pool.query=original;}
});
