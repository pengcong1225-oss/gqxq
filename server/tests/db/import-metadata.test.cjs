const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),knex=require('knex');
test('optional enterprise/grid import metadata preview and commit',{skip:process.env.GQXQ_ISOLATED_MIGRATION_TEST!=='1'},async()=>{
 const connection={host:'127.0.0.1',port:13317,user:'root',password:''};const admin=knex({client:'mysql2',connection,pool:{min:0,max:1}});let db,closePool;
 try{
  const [[s]]=await admin.raw('select @@port port,@@datadir datadir');assert.equal(Number(s.port),13317);assert.match(String(s.datadir).replaceAll('\\','/'),/gqxq-merge-mysql-20261111\/data\/$/);
  const database='gqxq_merge_import_'+process.pid+'_test';await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);db=knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1},migrations:{directory:path.join(__dirname,'../../migrations'),disableTransactions:true}});
  await db.raw(fs.readFileSync(path.join(__dirname,'../fixtures/external-baseline-ddl.sql'),'utf8'));await db.migrate.latest();
  for(const key of Object.keys(process.env))if(key.startsWith('GQXQ_')||key.startsWith('DOTENV_CONFIG_'))delete process.env[key];Object.assign(process.env,{DOTENV_CONFIG_PATH:path.join(__dirname,'__absent_env__'),NODE_ENV:'test',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'13317',GQXQ_DB_USER:'root',GQXQ_DB_PASSWORD:'',GQXQ_DB_NAME:database,GQXQ_JWT_SECRET:'synthetic-import-test-key-1234567890123456',GQXQ_PU_DELIVERY_WORKER_ENABLED:'false'});
  const {masterDataImportService:service}=require('../../src/services/masterDataImportService');const {parseImportFile,TEMPLATE_FIELDS}=require('../../src/services/masterDataImportParser');closePool=require('../../src/db/pool').closePool;
  await db('app_user').insert({user_id:'synthetic-import',username:'synthetic-import',password_hash:'not-a-real-login-hash',real_name:'Synthetic',roles:JSON.stringify(['admin']),permissions:'[]',status:1,scope_rules:JSON.stringify([{kind:'all'}]),scope_version:1});
  await db('dict_type').insert({dict_type:'business_type',dict_name:'Synthetic business type',status:'enabled',version:1,published:1});await db('dict_item').insert({item_id:'synthetic-water',dict_type:'business_type',item_value:'water',item_label:'Synthetic water',status:'enabled',version:1,published:1});
  const ctx={userId:'synthetic-import',userName:'Synthetic',clientIp:null,permissionCodes:['masterdata.import','enterprise.manage','grid.manage'],access:{userId:'synthetic-import',roles:['admin'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false}};
  const file=(values)=>({name:'synthetic.csv',bytes:Buffer.from([['templateVersion',...Object.keys(values)],['b4-v1',...Object.values(values)]].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n'))});
  let serial=0;
  const preview=async(kind,values)=>{const p=await service.previewImport(file(values),kind,ctx);return {p,batch:await service.getBatch(p.batchId,ctx)};};
  const commit=async(kind,values)=>{const {p,batch}=await preview(kind,values);assert.equal(p.canCommit,true,JSON.stringify(batch.details));const result=await service.commitImport({batchId:p.batchId,previewVersion:p.previewVersion,requestId:'synthetic-'+(++serial)},ctx);assert.equal(result.state,'succeeded',JSON.stringify(result));return {p,batch,result};};
  const enterprise={enterpriseCode:'E-SYN',enterpriseName:'Synthetic enterprise',businessType:'water',status:'enabled'};
  let r=await commit('enterprise',{...enterprise,displayOnScreen:'true',screenName:'Synthetic screen'});assert.equal(r.result.created,1);assert.equal(r.batch.details[0].after.displayOnScreen,true);
  r=await commit('enterprise',{...enterprise,displayOnScreen:'false',screenName:'Updated screen'});assert.equal(r.p.counts.update,1);assert.equal(r.result.updated,1);
  r=await commit('enterprise',enterprise);assert.equal(r.result.unchanged,1);let saved=await db('enterprise').where('enterprise_code','E-SYN').first();assert.equal(saved.display_on_screen,0);assert.equal(saved.screen_name,'Updated screen');
  for(const bad of [{displayOnScreen:'yes'},{screenName:'x'.repeat(129)}]){const {p}=await preview('enterprise',{...enterprise,...bad});assert.equal(p.canCommit,false);assert.equal(p.counts.error,1);}
  r=await commit('enterprise',{...enterprise,displayOnScreen:'',screenName:''});saved=await db('enterprise').where('enterprise_code','E-SYN').first();assert.equal(saved.display_on_screen,null);assert.equal(saved.screen_name,null);
  // PU-owned identity fields remain controlled by the existing enterprise service.
  await db('pu_enterprise_binding').insert({source_system:'public-utility',source_kind:'synthetic',source_id:'SYN',business_type:'water',enterprise_code:'E-SYN',source_enterprise_id:'SYN',gqxq_subject_code:'SYN',source_revision:'1',account_readiness:'{}',source_payload:JSON.stringify({ownedFields:['enterpriseName','businessType','status'],status:'enabled'}),updated_at:new Date()});
  const blocked=await preview('enterprise',{...enterprise,enterpriseName:'Forbidden overwrite',screenName:'Safe metadata'});assert.equal(blocked.p.canCommit,false);assert.match(blocked.batch.details[0].errors[0].message,/填报系统维护/);
  r=await commit('enterprise',{...enterprise,screenName:'Safe metadata'});assert.equal(r.result.updated,1);
  const grid={code:'G-SYN',name:'Synthetic grid',enterpriseCode:'E-SYN',businessType:'water'};
  r=await commit('service_grid',{...grid,managerName:'Synthetic manager',managerPhone:'000123'});assert.equal(r.result.created,1);assert.equal(r.batch.details[0].after.managerPhone,'000123');
  r=await commit('service_grid',{...grid,managerName:'Updated manager',managerPhone:'000456'});assert.equal(r.p.counts.update,1);assert.equal(r.result.updated,1);
  r=await commit('service_grid',grid);assert.equal(r.result.unchanged,1);saved=await db('service_grid').where('grid_code','G-SYN').first();assert.equal(saved.manager_name,'Updated manager');assert.equal(saved.manager_phone,'000456');
  const invalid=await preview('service_grid',{...grid,managerPhone:'x'.repeat(65)});assert.equal(invalid.p.canCommit,false);
  await commit('service_grid',{...grid,managerName:'',managerPhone:''});saved=await db('service_grid').where('grid_code','G-SYN').first();assert.equal(saved.manager_name,null);assert.equal(saved.manager_phone,null);
  for(const state of ['published','legacy']){await db('service_grid').where('grid_code','G-SYN').update({import_state:state});const rejected=await preview('service_grid',{...grid,managerName:'Forbidden historical rewrite'});assert.equal(rejected.p.canCommit,false);assert.match(rejected.batch.details[0].errors[0].message,/受控网格维护/);assert.equal((await db('service_grid').where('grid_code','G-SYN').first()).manager_name,null);}
  const {prepareCimPreview,prepareCimBoundaryImport,cimPreviewDigest}=require('../../src/services/cimBoundaryImportService');
  const gridCode='42050201010103';
  await db('admin_grid').insert({code:gridCode,name:'合成东岸03网格',district_code:'420502',version:1});
  const importCimBoundary=async(administrativeCommunityName)=>{
   const points=[[111.28,30.7],[111.29,30.7],[111.29,30.71],[111.28,30.71],[111.28,30.7]].map(([x,y])=>({x,y}));
   const source=prepareCimPreview('community-grid',[{ID:42,fieldNames:['NAME','BM','SSSQ'],
    fieldValues:['合成东岸03网格',gridCode,administrativeCommunityName],geometry:{type:'REGION',parts:[5],partTopo:[1],points}}]);
   const converted={...source,metadata:{...source.metadata,srid:4326,sourceSha256:cimPreviewDigest(source),accuracyMeters:0.2,operation:'Synthetic measured control'}};
   const bytes=await prepareCimBoundaryImport(source,converted,'合成授权文书');
   const draft=await service.previewImport({name:'grid_boundary.geojson',bytes},'grid_boundary',ctx);
   const batch=await service.getBatch(draft.batchId,ctx);
   assert.equal(draft.canCommit,true,JSON.stringify(batch.details));
   assert.equal(batch.details[0].after.administrativeCommunityName,administrativeCommunityName||null);
   const applied=await service.commitImport({batchId:draft.batchId,previewVersion:draft.previewVersion,requestId:'synthetic-'+(++serial)},ctx);
   assert.equal(applied.state,'succeeded',JSON.stringify(applied));
   assert.equal((await db('admin_grid').where({code:gridCode}).first()).administrative_community_name,administrativeCommunityName||null);
   return applied;
  };
  assert.equal((await importCimBoundary('合成东岸居委会')).updated,1);
  assert.equal((await importCimBoundary('合成东岸居委会')).unchanged,1);
  assert.equal((await importCimBoundary('')).updated,1);
  // Parse the distributed CSV and XLSX artifacts, not just an in-memory header.
  for(const kind of ['enterprise','service_grid'])for(const ext of ['csv','xlsx']){const bytes=fs.readFileSync(path.join(__dirname,'../../templates/imports',kind+'.'+ext));const parsed=await parseImportFile({name:kind+'.'+ext,bytes},kind);for(const key of kind==='enterprise'?['displayOnScreen','screenName']:['managerName','managerPhone']){assert.ok(TEMPLATE_FIELDS[kind].includes(key));assert.ok(key in parsed.rows[0].values);}}
  console.log('IMPORT METADATA DB VERIFIED',database);
 }finally{if(closePool)await closePool();if(db)await db.destroy();await admin.destroy();}
});
