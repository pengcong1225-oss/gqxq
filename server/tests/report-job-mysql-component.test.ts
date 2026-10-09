import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import knexFactory from 'knex';
import {prepareReportFixture} from './helpers/reportDbFixture';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_D3_COMPONENT_DB==='gqxq_d3_contract_test';
const fix1=process.env.GQXQ_D3_FIX1==='1';
const busyFix=process.env.GQXQ_D3_FIX1_BUSY==='1';
test('D3 actual isolated SQL, immutable artifacts and independent report-only restart',{skip:!enabled||fix1},async t=>{
 for(const [key,value] of Object.entries({GQXQ_DB_NAME:'gqxq_d3_contract_test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'3306'}))assert.equal(process.env[key],value);
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_d3_contract_test',timezone:'+08:00'}});let close:(()=>Promise<void>)|undefined;
 try{
  await prepareReportFixture(db);const migration=require('../migrations/20261009170000__report_artifacts.js');await migration.up(db);
  const {pool}=await import('../src/db/pool');close=()=>pool.end();const service=await import('../src/services/reportService');const repo=await import('../src/repositories/reportRepo');
  const access={userId:'synthetic',roles:['admin'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
  const ctx={userId:'synthetic',userName:'Synthetic',clientIp:null,access,permissionCodes:[]};
  await db('app_user').insert([{user_id:'synthetic',username:'synthetic',password_hash:'synthetic',real_name:'Synthetic',roles:JSON.stringify(['admin']),status:1,scope_rules:JSON.stringify([{kind:'all'}]),scope_version:1,must_change_password:0,account_type:'internal'},{user_id:'reader',username:'reader',password_hash:'synthetic',roles:JSON.stringify(['readonly']),status:1,scope_rules:JSON.stringify([{kind:'all'}]),scope_version:1,must_change_password:0,account_type:'internal'}]);
  await db('enterprise').insert({enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',status:'enabled',version:1,district_code:'D1'});
  await db('admin_grid').insert({code:'A1',name:'合成行政网格',district_code:'D1',version:1});
  await db('enterprise_household_version').insert({enterprise_code:'E1',version:1,households:200,valid_from:'2025-01-01',operator_id:'synthetic',created_at:new Date()});
  const coverage={code:'G1',serviceGridCode:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:[],version:'1',validFrom:'2025-01-01',validTo:null,geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A1'},geometry:{type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]]]}}]},coordinateSystem:'WGS84',geometrySources:['合成资料'],coverageState:'maintained'};
  await db('service_grid').insert({grid_code:'G1',grid_name:'合成服务网格',business_type:'water',version:1,import_state:'published'});await db('grid_enterprise').insert({grid_code:'G1',enterprise_code:'E1'});await db('service_grid_admin').insert({grid_code:'G1',version:1,admin_grid_code:'A1'});await db('service_grid_revision').insert({grid_code:'G1',version:1,valid_from:'2025-01-01',snapshot:JSON.stringify(coverage),operator_id:'synthetic',created_at:new Date()});
  await db('dictionary_version').insert({type_code:'complaint_category',version:10,snapshot:JSON.stringify({type:{code:'complaint_category'},items:[{code:'fee',label:'旧费用',parentCode:null}]}),created_at:new Date()});
  for(const [id,date] of [['C1','2026-09-10 08:00:00'],['Y1','2025-09-10 08:00:00']])await db('complaint').insert({complaint_id:id,complaint_no:'NO-'+id,title:'PRIVATE_SOURCE_TITLE',source_reported_at:date,received_at:date,business_type:'water',enterprise_code:'E1',district_code:'D1',major_category_code:'fee',category_dictionary_version:10,location_lng:1,location_lat:1,location_coordinate_system:'WGS84',location_coordinate_source:'合成声明',edit_version:1,source_payload:JSON.stringify({SECRET:'RAW_SECRET'})});
  await db('analysis_record').insert({analysis_id:'A-C1',complaint_id:'C1',confirmed_at:'2026-09-10 08:00:00'});await db('report_todo').insert({todo_id:'T-C1',analysis_id:'A-C1',complaint_id:'C1',status:'pending'});
  const query={dataset:'ledger',projection:'current',periodKind:'month',from:'2026-09-01',to:'2026-09-30',comparisonPolicyId:'candidate-calendar-v1',enterpriseCode:'E1'};
  const input=(requestId:string,extra:any={})=>({requestId,templateCode:'statistics-draft',templateVersion:'v1',format:'docx',query,...extra});
  const currentPermissions=async()=>(await db('platform_role_permission').where('role_code','admin')).map(p=>p.permission_code);
  const auditAccess=async()=>({...access,permissionCodes:await currentPermissions()});
  await t.test('real create/idempotent replay conflict and legacy row identity preserved',async()=>{
   const a=await service.createReport(input('sql-idempotent'),ctx);const b=await service.createReport(input('sql-idempotent'),ctx);assert.equal(a.reportId,b.reportId);assert.equal(a.snapshotId,b.snapshotId);await assert.rejects(()=>service.createReport(input('sql-idempotent',{format:'xlsx'}),ctx),/不同/);
   const old=await db('report_record').where('id',1).first();assert.equal(old.preview_content,'Preserve me');assert.equal(old.d3_report_id,null);assert.equal((await db('report_record').where('d3_report_id',a.reportId)).length,1);
   const s=(await db('statistics_snapshot').where('snapshot_id',a.snapshotId).first()).snapshot_bytes.toString();const frozen=JSON.parse(s);assert.equal(frozen.statistics.periodFacts[1].rows[0].complaintId,'Y1');assert.equal(frozen.statistics.masterScopeFacts[0].districtCode,'D1');assert.ok(frozen.statistics.coverageEvidence[0].selectedBusinessDays.length);assert.equal(s.includes('RAW_SECRET'),false);
   await service.generateReport(a.reportId);const one=await service.authorizeReportDownload(a.reportId,ctx),two=await service.authorizeReportDownload(a.reportId,ctx);assert.deepEqual(one.bytes,two.bytes);assert.equal(one.hash,two.hash);
   await db('enterprise_household_version').where('enterprise_code','E1').update({households:999});await db('dictionary_version').where('version',10).update({snapshot:JSON.stringify({renamed:'new'})});assert.deepEqual((await service.authorizeReportDownload(a.reportId,ctx)).bytes,one.bytes);
   assert.equal((await service.authorizeReportDownload(a.reportId,{...ctx,userId:'reader'})).hash,one.hash);await assert.rejects(()=>service.retryReport(a.reportId,{...ctx,userId:'reader'}));
   const {queryAuditLogs,findAuditLog}=await import('../src/repositories/auditLogRepo');const logs=await queryAuditLogs(pool,{module:'report_record',businessNo:a.reportId},{page:1,size:50},await auditAccess());assert.ok(logs.total>=3);assert.ok(logs.content.every(r=>r.biz_id===a.reportId));assert.ok(await findAuditLog(pool,String(logs.content[0].audit_id),await auditAccess()));
  });
  await t.test('empty original query domain, moved objects/master and missing proof deny whole artifacts/audit',async()=>{
   const empty=await service.createReport(input('empty-domain',{query:{...query,enterpriseCode:undefined,from:'2026-07-01',to:'2026-07-31'}}),ctx);await service.generateReport(empty.reportId);
   await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}])});await assert.rejects(()=>service.authorizeReportDownload(empty.reportId,ctx));await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([{kind:'all'}])});
   await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['D1']}])});const r=await service.createReport(input('move-check'),ctx);await service.generateReport(r.reportId);await service.authorizeReportDownload(r.reportId,ctx);
   await db('complaint').where('complaint_id','Y1').update({district_code:'D2'});await assert.rejects(()=>service.authorizeReportDownload(r.reportId,ctx));await db('complaint').where('complaint_id','Y1').update({district_code:'D1'});
   await db('enterprise').where('enterprise_code','E1').update({district_code:'D2'});await assert.rejects(()=>service.authorizeReportDownload(r.reportId,ctx));await db('enterprise').where('enterprise_code','E1').update({district_code:'D1'});
   await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([{kind:'all'}])});await db('report_scope_proof').where({snapshot_id:r.snapshotId,kind:'domain'}).delete();await assert.rejects(()=>service.authorizeReportDownload(r.reportId,ctx));
   const {queryAuditLogs}=await import('../src/repositories/auditLogRepo');assert.equal((await queryAuditLogs(pool,{module:'report_record',businessNo:r.reportId},{page:1,size:50},await auditAccess())).total,0);
   await assert.rejects(()=>service.getReport('RPT-00000000-0000-0000-0000-000000000000',ctx));await assert.rejects(()=>service.authorizeReportDownload('../x',ctx));
  });
  await t.test('fenced claim, expired worker, final actor revoke and retry by new authorized actor',async()=>{
   const r=await service.createReport(input('fence'),ctx);const claim=async(ms:number)=>{const c=await pool.getConnection();try{await c.beginTransaction();const x=await repo.claimReport(c,r.reportId,ms);await c.commit();return x!;}finally{c.release();}};
   const a=await claim(1000);assert.equal(await claim(1000),null);await db('report_job').where('report_id',r.reportId).update({lease_until:'2020-01-01'});const b=await claim(60000);assert.ok(b.fence>a.fence);
   const {renderReport}=await import('../src/services/reportRenderer');assert.equal(await service.finalizeReport(a,await renderReport(a.snapshot)),false);
   const revokedBytes=await renderReport(b.snapshot);await db('app_user').where('user_id','synthetic').update({status:0});await assert.rejects(()=>service.finalizeReport(b,revokedBytes));await service.failReport(b,'AUTH_CHANGED');assert.equal((await db('report_artifact').where('report_id',r.reportId)).length,0);
   await db('app_user').where('user_id','synthetic').update({status:1});await db('app_user').insert({user_id:'retry-actor',username:'retry-actor',password_hash:'synthetic',roles:JSON.stringify(['admin']),status:1,scope_rules:JSON.stringify([{kind:'all'}]),must_change_password:0,account_type:'internal'});
   await service.retryReport(r.reportId,{...ctx,userId:'retry-actor'});assert.equal((await db('report_job').where('report_id',r.reportId).first()).execution_actor,'retry-actor');await service.generateReport(r.reportId);assert.equal((await service.getReport(r.reportId,ctx)).state,'succeeded');
  });
  await t.test('only actual successful selected analysis todo completes; first successful link stays',async()=>{
   const a=await service.createReport(input('todo',{query:{...query,dataset:'analysis'},todoIds:['T-C1']}),ctx);assert.equal((await db('report_todo').first()).status,'pending');await service.generateReport(a.reportId);assert.equal((await db('report_todo').first()).report_id,a.reportId);
   const b=await service.createReport(input('todo-second',{query:{...query,dataset:'analysis'},todoIds:['T-C1'],format:'xlsx'}),ctx);await service.generateReport(b.reportId);assert.equal((await db('report_todo').first()).report_id,a.reportId);assert.equal((await service.getReport(b.reportId,ctx)).state,'succeeded');
   await assert.rejects(()=>service.createReport(input('invalid-todo',{todoIds:['T-C1']}),ctx));
  });
  await t.test('optional heat is one same-snapshot real capture and remains neutral with Q7 unconfirmed',async()=>{
   const a=await service.createReport(input('heat',{includeHeat:true}),ctx);const frozen=JSON.parse((await db('statistics_snapshot').where('snapshot_id',a.snapshotId).first()).snapshot_bytes.toString());assert.equal(frozen.heat.statistics.summary.dataCutoffAt,frozen.statistics.summary.dataCutoffAt);assert.equal(frozen.heat.data.grids[0].level,null);assert.equal(frozen.heat.data.points.length,0);assert.deepEqual(frozen.heat.rules,[]);
  });
  await t.test('OR domains include empty branches, content grants revoke, SQL pagination has no hidden total',async()=>{
   const scope=[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['D1']},{kind:'restricted',enterpriseCodes:['E2'],districtCodes:['D2']}];await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify(scope)});
   const a=await service.createReport(input('or-domain',{query:{...query,enterpriseCode:undefined}}),ctx);await service.getReport(a.reportId,ctx);
   await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([scope[0]])});await assert.rejects(()=>service.getReport(a.reportId,ctx));assert.equal((await service.listReports(ctx)).content.some(r=>r.reportId===a.reportId),false);
   for(const key of ['page-one','page-two'])await service.createReport(input(key),ctx);const page=await service.listReports(ctx,1);assert.equal('total' in page,false);assert.ok(page.hasMore&&page.continuation);assert.equal(page.continuation!.includes(page.content[0].reportId),false);assert.equal((await service.listReports(ctx,1,page.continuation!)).content.length,1);await assert.rejects(()=>service.listReports({...ctx,userId:'reader'},1,page.continuation!));
   await db('platform_role_permission').where({role_code:'admin',permission_code:'complaint.read'}).delete();await assert.rejects(()=>service.getReport(page.content[0].reportId,ctx));await assert.rejects(()=>service.listReports(ctx));await assert.rejects(()=>service.retryReport(page.content[0].reportId,ctx));await db('platform_role_permission').insert({role_code:'admin',permission_code:'complaint.read'});
   await db('app_user').where('user_id','synthetic').update({scope_rules:JSON.stringify([{kind:'all'}])});
  });
  await t.test('independent process kill/restart persists lease reclaim, pending jobs and identical successful bytes',async()=>{
   const r=await service.createReport(input('process-restart',{format:'xlsx'}),ctx);
   const start=(mode:string)=>spawn(process.execPath,['--import','tsx','scripts/report-worker-test-harness.ts',r.reportId,mode],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
   const child=start('claim-hang');const [message]=await Promise.race([once(child,'message'),new Promise<any>((_,reject)=>setTimeout(()=>reject(Error('claim process timeout')),15000))]);assert.equal((message as any).event,'claimed');child.kill();await once(child,'exit');
   assert.equal((await db('report_job').where('report_id',r.reportId).first()).state,'generating');await new Promise(resolve=>setTimeout(resolve,1100));
   const restarted=start('generate');const [code]=await once(restarted,'exit');assert.equal(code,0);const one=await service.authorizeReportDownload(r.reportId,ctx);const again=start('generate');assert.equal((await once(again,'exit'))[0],0);assert.deepEqual((await service.authorizeReportDownload(r.reportId,ctx)).bytes,one.bytes);
  });
  await t.test('all migration metadata preflight before DDL; revoked seed not restored',async()=>{
   await db('report_job').whereNull('owner_token').update({owner_token:'synthetic-metadata'});await db.raw('alter table report_job modify owner_token varchar(64) not null');await assert.rejects(()=>migration.up(db),/nullability/);await db.raw('alter table report_job modify owner_token varchar(64) null');
   await db.schema.dropTable('report_artifact');await db.raw('alter table report_record add column extra_identity varchar(5) null default null, add unique key uk_extra_identity(extra_identity)');await db.raw("alter table report_record alter column extra_identity set default 'fixed'");await assert.rejects(()=>migration.up(db),/unique constraint/);assert.equal(await db.schema.hasTable('report_artifact'),false);await db.raw('alter table report_record drop column extra_identity');
   await db.raw('alter table report_record add column unknown_required varchar(5) not null');await assert.rejects(()=>migration.up(db),/mandatory/);assert.equal(await db.schema.hasTable('report_artifact'),false);await db.raw('alter table report_record drop column unknown_required');await migration.up(db);
   await db('platform_role_permission').where({role_code:'readonly',permission_code:'report.download'}).delete();await migration.up(db);assert.equal((await db('platform_role_permission').where({role_code:'readonly',permission_code:'report.download'})).length,0);
  });
  // Actual frozen synthetic artifacts only, with complete production renderer.
  const output='../.superpowers/sdd/2026-10-09-abcd-delivery-plan/d3-artifact-qa';await mkdir(output,{recursive:true});
  for(const format of ['docx','xlsx'] as const){const a=await service.createReport(input('qa-'+format,{format}),ctx);await service.generateReport(a.reportId);const b=await service.authorizeReportDownload(a.reportId,ctx);await writeFile(output+'/statistics-draft-v1.'+format,b.bytes);console.log('D3_QA',format,b.bytes.length,b.hash);}
 }finally{if(close)await close();await db.destroy();}
});

test('D3 fix1 actual pre-DDL generated columns and inherited concurrent lock order',{skip:!enabled||!fix1||busyFix},async t=>{
 for(const [key,value] of Object.entries({GQXQ_DB_NAME:'gqxq_d3_contract_test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'3306'}))assert.equal(process.env[key],value);
 const samples=['docx','xlsx'].map(f=>'../.superpowers/sdd/2026-10-09-abcd-delivery-plan/d3-artifact-qa/statistics-draft-v1.'+f);
 const sampleHashes=await Promise.all(samples.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_d3_contract_test',timezone:'+08:00'}});
 const migration=require('../migrations/20261009170000__report_artifacts.js');let close:(()=>Promise<void>)|undefined;
 try{
  for(const field of ['report_title','d3_report_id'])await t.test('generated '+field+' refuses before any DDL',async()=>{
   await prepareReportFixture(db);
   if(field==='report_title')await db.raw("alter table report_record modify report_title varchar(255) generated always as ('generated title') stored");
   else await db.raw('alter table report_record add d3_report_id varchar(64) generated always as (null) stored, add unique key uk_generated_d3_id(d3_report_id)');
   const [metadata]=await db.raw('show full columns from report_record');assert.match(metadata.find((r:any)=>r.Field===field).Extra,/GENERATED/);
   let error:unknown;try{await migration.up(db);}catch(e){error=e;}
   const created=[];for(const name of ['statistics_snapshot','report_scope_proof','report_job','report_artifact'])if(await db.schema.hasTable(name))created.push(name);
   console.log('D3_FIX1_GENERATED',field,'newTables='+created.join(','),'refused='+Boolean(error));
   assert.deepEqual(created,[],'incompatible generated insert target must refuse before any owned DDL');
   if(field==='report_title')assert.equal(await db.schema.hasColumn('report_record','d3_report_id'),false);
   assert.match(String(error),/generated.*report_record\.(report_title|d3_report_id)/i);
  });
  await t.test('actual report read concurrent with B3 supplied-Tx validation, household master absent',async()=>{
   await prepareReportFixture(db);await migration.up(db);
   const {pool}=await import('../src/db/pool');close=()=>pool.end();const service=await import('../src/services/reportService');const {serviceGridService}=await import('../src/services/serviceGridService');
   await db('app_user').insert({user_id:'synthetic',username:'synthetic',password_hash:'synthetic',real_name:'Synthetic',roles:JSON.stringify(['admin']),status:1,scope_rules:JSON.stringify([{kind:'all'}]),scope_version:1,must_change_password:0,account_type:'internal'});
   await db('platform_role_permission').where({role_code:'admin',permission_code:'enterprise.read'}).delete();
   await db('enterprise').insert({enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',status:'enabled',version:1,district_code:'D1'});
   await db('admin_grid').insert({code:'A1',name:'合成行政网格',district_code:'D1',version:1});
   await db('enterprise_household_version').insert({enterprise_code:'E1',version:1,households:200,valid_from:'2025-01-01',operator_id:'synthetic',created_at:new Date()});
   const coverage={code:'G1',serviceGridCode:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:[],version:'1',validFrom:'2025-01-01',validTo:null,geometry:null,coordinateSystem:null,geometrySources:[],coverageState:'maintained'};
   await db('service_grid').insert({grid_code:'G1',grid_name:'合成服务网格',business_type:'water',version:1,import_state:'published'});
   await db('grid_enterprise').insert({grid_code:'G1',enterprise_code:'E1'});await db('service_grid_admin').insert({grid_code:'G1',version:1,admin_grid_code:'A1'});
   await db('service_grid_revision').insert({grid_code:'G1',version:1,valid_from:'2025-01-01',snapshot:JSON.stringify(coverage),operator_id:'synthetic',created_at:new Date()});
   await db('complaint').insert({complaint_id:'C1',complaint_no:'NO-C1',received_at:'2026-09-10 08:00:00',source_reported_at:'2026-09-10 08:00:00',business_type:'water',enterprise_code:'E1',district_code:'D1',edit_version:1});
   const permissionCodes=(await db('platform_role_permission').where('role_code','admin')).map(p=>String(p.permission_code));
   const ctx={userId:'synthetic',userName:'Synthetic',clientIp:null,permissionCodes,access:{userId:'synthetic',roles:['admin'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false}};
   const report=await service.createReport({requestId:'fix1-concurrent',templateCode:'statistics-draft',templateVersion:'v1',format:'docx',query:{dataset:'ledger',projection:'current',periodKind:'month',from:'2026-09-01',to:'2026-09-30',comparisonPolicyId:'candidate-calendar-v1',enterpriseCode:'E1'}},ctx);
   const snapshot=JSON.parse((await db('statistics_snapshot').where('snapshot_id',report.snapshotId).first()).snapshot_bytes.toString());
   assert.deepEqual(snapshot.statistics.masterScopeFacts,[]);assert.equal(snapshot.statistics.coverageEvidence[0].coverage.enterpriseCode,'E1');assert.match(snapshot.statistics.householdEvidence[0].reason,/无企业主数据查询权限/);
   const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
   const writerParents=deferred<void>(),continueWriter=deferred<void>(),reportPoint=deferred<'grid-held'|'parent-attempt'>(),continueReport=deferred<void>();
   const writer=await pool.getConnection();await writer.query('set transaction isolation level read committed');await writer.query('set session innodb_lock_wait_timeout=5');await writer.beginTransaction();
   const writerQuery=writer.query.bind(writer);writer.query=(async(sql:any,args:any)=>{if(typeof sql==='string'&&sql.includes('from service_grid g')&&sql.endsWith(' for update')){writerParents.resolve();await continueWriter.promise;}return writerQuery(sql,args);}) as any;
   const write=serviceGridService.validateInTx(writer,{code:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:[],validFrom:'2025-01-01',validTo:null,expectedVersion:1},ctx).then(async v=>{await writer.commit();return v;},async e=>{await writer.rollback();throw e;});
   // Capture rejections immediately, so genuine deadlock errors are never unhandled.
   const writerResult=write.then(()=>({ok:true,code:''}),e=>({ok:false,code:String(e.code??e.message)}));
   const originalGet=pool.getConnection.bind(pool);let reportConnection:any;
   try{
    await writerParents.promise;
    pool.getConnection=(async()=>{const c=await originalGet();reportConnection=c;const query=c.query.bind(c);c.query=(async(sql:any,args:any)=>{
     if(typeof sql==='string'&&/from enterprise where enterprise_code=\? for share$/.test(sql))reportPoint.resolve('parent-attempt');
     const result=await query(sql,args);
     if(typeof sql==='string'&&sql.includes('from service_grid where grid_code=? for share')){reportPoint.resolve('grid-held');await continueReport.promise;}
     return result;
    }) as any;return c;}) as any;
    const read=service.getReport(report.reportId,ctx).then(()=>({ok:true,code:''}),e=>({ok:false,code:String(e.code??e.message)}));
    const point=await Promise.race([reportPoint.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('current lock checkpoint timeout')),5000))]);
    continueWriter.resolve();continueReport.resolve();
    const results=await Promise.all([writerResult,read]);console.log('D3_FIX1_CONCURRENCY',point,JSON.stringify(results));
    assert.ok(results.every(r=>r.ok),'actual B3/report transactions must complete without ER_LOCK_DEADLOCK');
   }finally{
    continueWriter.resolve();continueReport.resolve();pool.getConnection=originalGet;
    await writerResult;writer.query=writerQuery as any;await writer.rollback();writer.release();
    // Interception belongs only to this leased connection, never to the pool.
    if(reportConnection)delete reportConnection.query;
   }
  });
 }finally{
  if(close)await close();await db.destroy();
  const after=await Promise.all(samples.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));assert.deepEqual(after,sampleHashes);console.log('D3_FIX1_QA_UNCHANGED',JSON.stringify(after));
 }
});

test('D3 complaint NOWAIT actual assignment cycle and busy finalization',{skip:!enabled||!fix1||!busyFix},async t=>{
 for(const [key,value] of Object.entries({GQXQ_DB_NAME:'gqxq_d3_contract_test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'3306'}))assert.equal(process.env[key],value);
 const samples=['docx','xlsx'].map(f=>'../.superpowers/sdd/2026-10-09-abcd-delivery-plan/d3-artifact-qa/statistics-draft-v1.'+f);
 const hashes=await Promise.all(samples.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_d3_contract_test',timezone:'+08:00'}});
 let close:(()=>Promise<void>)|undefined;
 try{
  await prepareReportFixture(db);
  await db.schema.dropTableIfExists('complaint_assignment');
  await db.schema.dropTableIfExists('complaint_disposition');
  await require('../migrations/20260917100600__m6_g2_dispatch_and_assignment.js').up(db);
  await require('../migrations/20261009170000__report_artifacts.js').up(db);
  const {pool}=await import('../src/db/pool');close=()=>pool.end();const service=await import('../src/services/reportService');const {assignEnterprise}=await import('../src/services/assignmentService');const {runWithAccessContext}=await import('../src/auth/accessScope');
  await db('app_user').insert({user_id:'synthetic',username:'synthetic',password_hash:'synthetic',real_name:'Synthetic',roles:JSON.stringify(['admin']),status:1,scope_rules:JSON.stringify([{kind:'all'}]),scope_version:1,must_change_password:0,account_type:'internal'});
  await db('app_user').insert({user_id:'outside',username:'outside',password_hash:'synthetic',real_name:'Outside',roles:JSON.stringify(['admin']),status:1,scope_rules:JSON.stringify([{kind:'restricted',enterpriseCodes:['E2'],districtCodes:[]}]),scope_version:1,must_change_password:0,account_type:'internal'});
  await db('enterprise').insert({enterprise_code:'E1',enterprise_name:'合成企业',business_type:'water',status:'enabled',version:1,district_code:'D1'});
  await db('complaint').insert({complaint_id:'C1',complaint_no:'NO-C1',received_at:'2026-09-10 08:00:00',source_reported_at:'2026-09-10 08:00:00',business_type:'water',enterprise_code:'E1',enterprise_name:'合成企业',district_code:'D1',edit_version:1});
  await db('analysis_record').insert({analysis_id:'A-C1',complaint_id:'C1',confirmed_at:'2026-09-10 08:00:00'});await db('report_todo').insert({todo_id:'T-C1',analysis_id:'A-C1',complaint_id:'C1',status:'pending'});
  const permissionCodes=(await db('platform_role_permission').where('role_code','admin')).map(p=>String(p.permission_code));
  const ctx={userId:'synthetic',userName:'Synthetic',clientIp:null,permissionCodes,access:{userId:'synthetic',roles:['admin'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false}};
  for(const mode of ['read','generate'] as const)await t.test('actual assignment/report '+mode+' busy rolls back and recovers',async()=>{
   await db('report_todo').where('todo_id','T-C1').update({status:'pending',report_id:null});
   const report=await service.createReport({requestId:'busy-'+mode,templateCode:'statistics-draft',templateVersion:'v1',format:'docx',todoIds:['T-C1'],query:{dataset:'analysis',projection:'current',periodKind:'month',from:'2026-09-01',to:'2026-09-30',comparisonPolicyId:'candidate-calendar-v1',enterpriseCode:'E1'}},ctx);
   const frozen=(await db('statistics_snapshot').where('snapshot_id',report.snapshotId).first()).snapshot_bytes;
   const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
   const complaintHeld=deferred(),enterpriseHeld=deferred(),releaseAssignment=deferred(),assignmentAttempt=deferred(),releaseReport=deferred();
   const originalGet=pool.getConnection.bind(pool),connections:any[]=[];let reportCheckpoint=false;
   pool.getConnection=(async()=>{const c=await originalGet();connections.push(c);const query=c.query.bind(c);c.query=(async(sql:any,args:any)=>{
    if(typeof sql==='string'&&sql.includes('from enterprise e where e.enterprise_code=? for update')){
     complaintHeld.resolve();await releaseAssignment.promise;assignmentAttempt.resolve();
    }
    const result=await query(sql,args);
    if(reportCheckpoint&&typeof sql==='string'&&sql==='select enterprise_code,district_code from enterprise where enterprise_code=? for share'){
     enterpriseHeld.resolve();await releaseReport.promise;
    }
    return result;
   }) as any;return c;}) as any;
   let assignmentResult:Promise<{ok:boolean;code:string}>|undefined,reportResult:Promise<{ok:boolean;code:string;status:number}>|undefined;
   try{
    assignmentResult=runWithAccessContext(ctx.access,()=>assignEnterprise('C1',{enterpriseCode:'E1',enterpriseName:'合成企业',reason:'synthetic concurrent proof'},ctx)).then(()=>({ok:true,code:''}),e=>({ok:false,code:String(e.code??e.errorCode??e.message)}));
    await complaintHeld.promise;
    // A guessed ID outside full frozen scope must not reveal busy/existence.
    await assert.rejects(()=>service.getReport(report.reportId,{...ctx,userId:'outside'}),(e:any)=>e.errorCode==='NOT_FOUND'&&e.status===404);
    reportCheckpoint=true;
    reportResult=(mode==='read'?service.getReport(report.reportId,ctx):service.generateReport(report.reportId)).then(()=>({ok:true,code:'',status:0}),e=>({ok:false,code:String(e.errorCode??e.code??e.message),status:Number(e.status)}));
    await enterpriseHeld.promise;releaseAssignment.resolve();await assignmentAttempt.promise;releaseReport.resolve();
    const [assignment,outcome]=await Promise.all([assignmentResult,reportResult]);
    const job=await db('report_job').where('report_id',report.reportId).first(),artifacts=await db('report_artifact').where('report_id',report.reportId),todo=await db('report_todo').where('todo_id','T-C1').first();
    console.log('D3_FIX1_BUSY',mode,JSON.stringify({assignment,outcome,state:job.state,reason:job.failure_reason,artifacts:artifacts.length,todo:todo.status}));
    assert.ok(assignment.ok,'actual assignment must complete without ER_LOCK_DEADLOCK');
    if(mode==='read'){assert.equal(outcome.code,'REPORT_BUSY');assert.equal(outcome.status,409);}
    else{assert.ok(outcome.ok);assert.equal(job.state,'failed');assert.equal(job.failure_reason,'REPORT_BUSY');}
    assert.equal(artifacts.length,0);assert.equal(todo.status,'pending');assert.equal(todo.report_id,null);
   }finally{
    releaseAssignment.resolve();releaseReport.resolve();pool.getConnection=originalGet;
    await Promise.all([assignmentResult,reportResult]);for(const c of connections)delete c.query;
   }
   // Contention is gone: fresh read and explicit same-snapshot retry both work.
   assert.equal((await service.getReport(report.reportId,ctx)).reportId,report.reportId);
   if(mode==='generate'){
    await service.retryReport(report.reportId,ctx);await service.generateReport(report.reportId);
    assert.equal((await service.getReport(report.reportId,ctx)).state,'succeeded');assert.equal((await db('report_todo').where('todo_id','T-C1').first()).report_id,report.reportId);
    assert.deepEqual((await db('statistics_snapshot').where('snapshot_id',report.snapshotId).first()).snapshot_bytes,frozen);
   }
  });
 }finally{
  if(close)await close();await db.destroy();const after=await Promise.all(samples.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));assert.deepEqual(after,hashes);console.log('D3_FIX1_QA_UNCHANGED',JSON.stringify(after));
 }
});
