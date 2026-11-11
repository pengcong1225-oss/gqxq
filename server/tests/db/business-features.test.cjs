const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),knex=require('knex'),express=require('express'),request=require('supertest');
test('real rule, alert and five-year assessment workflows on isolated MySQL',{skip:process.env.GQXQ_ISOLATED_MIGRATION_TEST!=='1'},async t=>{
 const connection={host:'127.0.0.1',port:13317,user:'root',password:''};const admin=knex({client:'mysql2',connection,pool:{min:0,max:1}});let db,closePool;
 try{
  const [[s]]=await admin.raw('select @@port port,@@datadir datadir');assert.equal(Number(s.port),13317);assert.match(String(s.datadir).replaceAll('\\','/'),/gqxq-merge-mysql-20261111\/data\/$/);
  const database='gqxq_merge_features_'+process.pid+'_test';await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);db=knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1},migrations:{directory:path.join(__dirname,'../../migrations'),disableTransactions:true}});
  await db.raw(fs.readFileSync(path.join(__dirname,'../fixtures/external-baseline-ddl.sql'),'utf8'));const [,applied]=await db.migrate.latest();assert.equal(applied.length,fs.readdirSync(path.join(__dirname,'../../migrations')).filter(f=>f.endsWith('.js')).length);
  for(const key of Object.keys(process.env))if(key.startsWith('GQXQ_')||key.startsWith('DOTENV_CONFIG_'))delete process.env[key];Object.assign(process.env,{DOTENV_CONFIG_PATH:path.join(__dirname,'__absent_env__'),NODE_ENV:'test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'13317',GQXQ_DB_USER:'root',GQXQ_DB_PASSWORD:'',GQXQ_DB_NAME:database,GQXQ_JWT_SECRET:'synthetic-feature-test-key-1234567890123456',GQXQ_PU_DELIVERY_WORKER_ENABLED:'false'});
  const rules=require('../../src/services/businessRuleService'),alerts=require('../../src/services/businessAlertService'),assess=require('../../src/services/businessAssessmentService');const {businessFeaturesRouter}=require('../../src/routes/businessFeatures');closePool=require('../../src/db/pool').closePool;
  const all=[{kind:'all'}],restricted=[{kind:'restricted',enterpriseCodes:[],districtCodes:['D2']}];
  const context=async(id,role,scope)=>{await db('app_user').insert({user_id:id,username:id,password_hash:'not-a-login-hash',real_name:'Synthetic',roles:JSON.stringify([role]),permissions:'[]',status:1,must_change_password:0,scope_rules:JSON.stringify(scope),scope_version:1});const permissions=(await db('platform_role_permission').where('role_code',role)).map(r=>r.permission_code);return {userId:id,userName:'Synthetic',clientIp:null,permissionCodes:permissions,access:{userId:id,roles:[role],scopeVersion:1,rules:scope,canReadSource:false}};};
  const owner=await context('feature-admin','admin',all),reader=await context('feature-readonly','readonly',all),outside=await context('feature-outside','handler',restricted);
  const noRead={...reader,permissionCodes:reader.permissionCodes.filter(p=>!['assessment.read','alert.read'].includes(p))};
  const app=express();app.use(express.json());app.use((req,res,next)=>{const ctx=req.get('x-actor')==='readonly'?reader:owner;req.user={id:ctx.userId,username:ctx.userName,permissionCodes:ctx.permissionCodes};req.accessContext=ctx.access;next();});app.use('/api',businessFeaturesRouter);app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message,errorCode:e.errorCode}));
  for(const [code,district] of [['AG1','D1'],['AG2','D1'],['AG3','D2']])await db('admin_grid').insert({code,name:'Synthetic '+code,district_code:district,version:1});
  const category={itemId:'category-synthetic',code:'syn-cat',label:'Synthetic category',parentCode:null,sort:0,status:'enabled',version:1,published:true};
  await db('dict_item').insert({item_id:category.itemId,dict_type:'complaint_category',item_value:category.code,item_label:category.label,parent_code:null,sort_order:0,status:'enabled',version:1,published:1});await db('dictionary_version').where({type_code:'complaint_category',version:1}).update({snapshot:JSON.stringify({type:{code:'complaint_category',version:1,published:true,status:'enabled'},items:[category]})});
  const base={expectedVersion:0,name:'Synthetic rule',businessType:'gas',dictionaryVersion:'1',majorCodes:['syn-cat'],minorCodes:[],effectiveFrom:'2020-01-01',effectiveTo:'2030-12-31',definitionBasis:'Synthetic explicitly confirmed definition',definitionConfirmed:true,enabled:true};
  const seasonal={...base,ruleId:'SYN-SEASON',kind:'seasonal',scene:'summer',startMonth:6,endMonth:8,threshold:null,windowDays:null};
  const alert={...base,ruleId:'SYN-ALERT',kind:'alert',scene:'gas_three_piece',startMonth:null,endMonth:null,threshold:2,windowDays:7};
  await t.test('rule save/publish uses real versions, authority and published category checks',async()=>{
   assert.equal((await request(app).post('/api/business-rules').send(alert)).status,200);assert.equal((await rules.listBusinessRules(owner))[0].publishedVersion,0);
   await assert.rejects(rules.saveBusinessRule(alert,owner),e=>e.status===409);assert.equal((await rules.publishBusinessRule(alert.ruleId,1,owner)).version,1);await assert.rejects(rules.publishBusinessRule(alert.ruleId,1,owner),e=>e.status===409);
   assert.equal((await rules.saveBusinessRule(seasonal,owner)).editVersion,1);await rules.publishBusinessRule(seasonal.ruleId,1,owner);
   await assert.rejects(rules.saveBusinessRule({...alert,ruleId:'READONLY'},reader),e=>e.status===403);await assert.rejects(rules.saveBusinessRule({...alert,ruleId:'OUTSIDE'},outside),e=>e.status===403);
   await rules.saveBusinessRule({...alert,ruleId:'BAD-CATEGORY',majorCodes:['missing']},owner);await assert.rejects(rules.publishBusinessRule('BAD-CATEGORY',1,owner),e=>e.status===400);
   assert.equal((await request(app).get('/api/business-rules').set('x-actor','readonly')).status,403);
  });
  const add=async(id,date,grid='AG1',enterprise='E1',district='D1')=>db('complaint').insert({complaint_id:id,complaint_no:'N-'+id,source_system:'宜接就办',source_id:'S-'+id,title:'Synthetic case',business_type:'gas',complaint_type:'complaint',urgency_level:'normal',enterprise_code:enterprise,district_code:district,admin_grid_code:grid,major_category_code:'syn-cat',category_dictionary_version:'1',source_event_status:'completed',source_synced_at:date+' 12:00:00',source_reported_at:date+' 10:00:00',received_at:date+' 11:00:00'});
  await add('SYN-C1','2026-06-15');await add('SYN-C2','2026-06-15');await add('SYN-H1','2025-06-15');await add('SYN-H2','2024-06-15','AG2');await add('SYN-OUT','2026-06-15','AG3','E2','D2');
  let alertId;
  await t.test('real alert calculation is idempotent; actions and evidence stay authorized',async()=>{
   const first=await alerts.evaluateBusinessAlerts('2026-06-15',owner);assert.equal(first.created,1,JSON.stringify(first));assert.equal(first.statuses.find(s=>s.ruleId==='SYN-ALERT').status,'triggered');assert.equal((await alerts.evaluateBusinessAlerts('2026-06-15',owner)).created,0);
   const listed=await alerts.listBusinessAlerts(owner);assert.equal(listed.length,1);alertId=listed[0].alertId;assert.equal(listed[0].quantity,2);assert.deepEqual(listed[0].complaintIds.sort(),['SYN-C1','SYN-C2']);
   assert.equal((await alerts.listBusinessAlerts({...owner,permissionCodes:owner.permissionCodes.filter(p=>p!=='complaint.read')}))[0].complaintIds,null);
   assert.equal((await request(app).get('/api/business-alerts')).status,200);assert.equal((await alerts.listBusinessAlerts(outside)).length,0);await assert.rejects(alerts.alertHistory(alertId,outside),e=>e.status===404);await assert.rejects(alerts.listBusinessAlerts(noRead),e=>e.status===403);
   await assert.rejects(alerts.actOnBusinessAlert(alertId,{action:'acknowledge',notes:'Read only'},reader),e=>e.status===403);await assert.rejects(alerts.actOnBusinessAlert(alertId,{action:'acknowledge',notes:'Out of scope'},outside),e=>e.status===404);
   assert.equal((await alerts.actOnBusinessAlert(alertId,{action:'acknowledge',notes:'Synthetic acknowledgement'},owner)).state,'acknowledged');assert.equal((await alerts.actOnBusinessAlert(alertId,{action:'resolve',notes:'Synthetic resolution'},owner)).state,'resolved');await assert.rejects(alerts.actOnBusinessAlert(alertId,{action:'resolve',notes:'Repeat'},owner),e=>e.status===409);
   const history=await alerts.alertHistory(alertId,owner);assert.equal(history.length,2);assert.deepEqual(history.map(h=>h.action),['acknowledge','resolve']);assert.ok(history.every(h=>h.user_id===owner.userId));
   await db('complaint').where('complaint_id','SYN-C1').update({deleted:1});assert.equal((await alerts.listBusinessAlerts(owner)).length,0);await db('complaint').where('complaint_id','SYN-C1').update({deleted:0});
  });
  await t.test('five seasons/history and grid comparison expose missing coverage and enforce scope',async()=>{
   const q={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-06-01',to:'2026-06-30',businessType:'gas'};
   const historical=await assess.historicalAssessment(q,reader);assert.equal(historical.years.length,5);assert.equal(historical.years[0].count,1);assert.equal(historical.years[1].count,1);assert.equal(historical.years[2].count,null);assert.equal(historical.years[2].status,'insufficient');assert.equal(historical.coverageStatus,'observed_records');assert.match(historical.coverageNote,/无记录不表示/);
   const seasonal=await assess.seasonalAssessment({scene:'summer',businessType:'gas',year:2026},reader);assert.equal(seasonal.seasons.length,5);assert.equal(seasonal.seasons[0].count,3);assert.equal(seasonal.seasons[3].count,null);assert.equal(seasonal.seasons[3].status,'insufficient');assert.ok(seasonal.previousMonths.some(m=>m.count===null&&m.status==='insufficient'));
   assert.equal((await assess.seasonalAssessment({scene:'winter',businessType:'gas',year:2025},reader)).status,'unconfigured');
   const comparison=await assess.compareGrids({...q,adminGridCodes:['AG1','AG2']},reader);assert.equal(comparison.totals.AG1,2);assert.equal(comparison.coverageStatus,'observed_records');assert.match(comparison.coverageNote,/无记录不表示/);assert.ok(comparison.details.every(d=>d.adminGridCode==='AG1'));
   await assert.rejects(assess.compareGrids({...q,adminGridCodes:['AG1','AG2']},outside),e=>e.status===404);await assert.rejects(assess.historicalAssessment(q,noRead),e=>e.status===403);
   const noDetails={...reader,permissionCodes:reader.permissionCodes.filter(p=>p!=='complaint.read')};assert.equal((await assess.historicalAssessment(q,noDetails)).years[0].details,null);assert.equal((await assess.compareGrids({...q,adminGridCodes:['AG1','AG2']},noDetails)).details,null);
   const incomplete=await alerts.evaluateBusinessAlerts('2023-06-15',owner);const empty=incomplete.statuses.find(s=>s.ruleId==='SYN-ALERT');assert.ok(empty.reason);assert.match(empty.reason,/完整覆盖未认证/);assert.equal(incomplete.created,0);
  });
  await t.test('alert evidence shared locks block concurrent complaint ownership changes',async()=>{
   const {withTransaction}=require('../../src/db/tx');let ready,release;const acquired=new Promise(resolve=>{ready=resolve;}),released=new Promise(resolve=>{release=resolve;});
   const holder=withTransaction(async tx=>{const visible=await alerts.authorizedAlerts(tx,owner,alertId,true);assert.equal(visible.length,1);ready();await released;});
   try{await Promise.race([acquired,holder]);await assert.rejects(db.transaction(async tx=>{await tx.raw('set session innodb_lock_wait_timeout=1');await tx('complaint').where('complaint_id','SYN-C1').update({enterprise_code:'CONCURRENT-CHANGE'});}),e=>e.code==='ER_LOCK_WAIT_TIMEOUT');}
   finally{release();await holder;}
   assert.equal((await db('complaint').where('complaint_id','SYN-C1').first()).enterprise_code,'E1');
  });
  await t.test('partial seasonal validity and grid-specific missing prior evidence remain null',async()=>{
   const original=await assess.seasonalAssessment({scene:'summer',businessType:'gas',year:2026},reader);assert.equal(original.top6.find(g=>g.code==='AG3').previousCount,null);assert.equal(original.top6.find(g=>g.code==='AG1').previousCount,1);
   await add('SYN-PARTIAL-SEASON','2025-06-25');
   const changed={...seasonal,expectedVersion:2,effectiveFrom:'2025-06-20'};assert.equal((await rules.saveBusinessRule(changed,owner)).editVersion,3);await rules.publishBusinessRule(seasonal.ruleId,3,owner);
   const partial=await assess.seasonalAssessment({scene:'summer',businessType:'gas',year:2026},reader);assert.equal(partial.seasons[1].count,null);assert.equal(partial.seasons[1].status,'outside_rule_period');const june=partial.previousMonths.find(m=>m.month==='2025-06');assert.equal(june.count,null);assert.equal(june.status,'outside_rule_period');
  });
  await t.test('scheduled real evaluator rechecks account/config and rolls back disabled work',async()=>{
   const {evaluateScheduledBusinessAlerts,businessAlertWorkerConfig}=require('../../src/services/businessAlertWorker');const {shanghaiToday}=require('../../src/domain/statisticsQuery');
   assert.equal(businessAlertWorkerConfig({}).enabled,false);
   await db('platform_role').insert({role_code:'feature-service',name:'Synthetic service role',enabled:1,built_in:0,version:1});
   const grants=['alert.handle','alert.read','statistics.read','dashboard.read'];for(const permission_code of grants)await db('platform_role_permission').insert({role_code:'feature-service',permission_code});
   const account=await context('feature-service-account','feature-service',all),config={enabled:true,userId:account.userId,intervalMs:60000};
   const today=shanghaiToday();await add('SYN-WORKER1',today,'AG3','E-WORKER','D2');await add('SYN-WORKER2',today,'AG3','E-WORKER','D2');
   const counts=async()=>({alerts:Number((await db('business_alert').count('* as n').first()).n),audits:Number((await db('operation_audit_log').count('* as n').first()).n)});
   const rejectUnchanged=async(read=()=>config)=>{const before=await counts();await assert.rejects(evaluateScheduledBusinessAlerts(config,read),e=>e.status===403);assert.deepEqual(await counts(),before);};
   const beforeDisabled=await counts();assert.equal(await evaluateScheduledBusinessAlerts({...config,enabled:false},()=>config),undefined);assert.deepEqual(await counts(),beforeDisabled);
   await rejectUnchanged(()=>({...config,enabled:false}));
   // First check and pre-insert check permit work; final check rejects after an
   // INSERT was attempted. The whole transaction, including its audit, rolls back.
   let reads=0;await rejectUnchanged(()=>({...config,enabled:++reads<=2}));assert.equal(reads,3);
   const first=await evaluateScheduledBusinessAlerts(config,()=>config);assert.equal(first.created,1);const second=await evaluateScheduledBusinessAlerts(config,()=>config);assert.equal(second.created,0);
   await db('app_user').where('user_id',account.userId).update({status:0});await rejectUnchanged();await db('app_user').where('user_id',account.userId).update({status:1});
   await db('app_user').where('user_id',account.userId).update({scope_rules:JSON.stringify(restricted),scope_version:2});await rejectUnchanged();await db('app_user').where('user_id',account.userId).update({scope_rules:JSON.stringify(all),scope_version:3});
   await db('platform_role_permission').where({role_code:'feature-service',permission_code:'alert.handle'}).del();await db('platform_authorization_state').where('id',1).increment('version',1);await rejectUnchanged();
  });
  await t.test('incomplete classification/location is not normal, and revoked write permission defeats stale context',async()=>{
   await db('complaint').where('complaint_id','SYN-C2').update({admin_grid_code:null});
   const result=await alerts.evaluateBusinessAlerts('2026-06-15',owner);assert.equal(result.statuses.find(s=>s.ruleId==='SYN-ALERT').status,'insufficient');assert.equal(result.created,0);
   await db('complaint').where('complaint_id','SYN-C2').update({admin_grid_code:'AG1'});
   await db('platform_role_permission').where({role_code:'admin',permission_code:'alert.handle'}).del();await db('platform_authorization_state').where('id',1).increment('version',1);
   await assert.rejects(alerts.evaluateBusinessAlerts('2026-06-15',owner),e=>e.status===403);
  });
  console.log('BUSINESS FEATURES TEST DATABASE',database);
 }finally{if(closePool)await closePool();if(db)await db.destroy();await admin.destroy();}
});
