import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import knexFactory from 'knex';
import express from 'express';
import request from 'supertest';
const require=createRequire(import.meta.url);
const enabled=process.env.GQXQ_C1_COMPONENT_DB==='gqxq_c1_contract_test';
test('C1 real SQL component on declared legacy fixture, not canonical baseline',{skip:!enabled},async t=>{
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_c1_contract_test');
 const db=knexFactory({client:'mysql2',connection:{host:'127.0.0.1',port:3306,user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_c1_contract_test'}});
 let close:(()=>Promise<void>)|undefined;
 try{
  const [identity]=await db.raw('select database() as db');assert.equal(identity[0].db,'gqxq_c1_contract_test');
  for(const name of ['source_process_revision','source_process_stream','operation_audit_log','correction_item','dispatch_order','complaint_category_revision','dictionary_version','dictionary_code_registry','dict_type','dict_item','complaint'])await db.schema.dropTableIfExists(name);
  // Explicit minimal pre-M2 legacy fixture. This does not stand in for M0 historical verification.
  await db.raw(`create table complaint(id bigint unsigned auto_increment primary key,complaint_id varchar(64) not null unique,complaint_no varchar(64),source_system varchar(64),source_id varchar(128),title varchar(256),content text,business_type varchar(64),complaint_type varchar(64),urgency_level varchar(64),status varchar(64),is_sensitive tinyint,sensitive_keywords varchar(500),district_code varchar(64),district_name varchar(128),address varchar(500),corrected_address varchar(500),location_lng decimal(12,6),location_lat decimal(12,6),correction_status varchar(64),enterprise_code varchar(64),enterprise_name varchar(128),grid_code varchar(64),sync_status varchar(64),received_at datetime,closed_at datetime,created_at datetime,updated_at datetime,deleted tinyint default 0) engine=InnoDB default charset=utf8mb4`);
  await db.raw('create table dict_type(id bigint auto_increment primary key,dict_type varchar(64),dict_name varchar(128),status varchar(16)) engine=InnoDB');
  await db.raw('create table dict_item(id bigint auto_increment primary key,item_id varchar(64),dict_type varchar(64),item_value varchar(64),item_label varchar(128),status varchar(16)) engine=InnoDB');
  await db.raw('create table dispatch_order(id bigint auto_increment primary key,assignment_id varchar(64),complaint_id varchar(64),active_complaint_id varchar(64) unique,status varchar(64)) engine=InnoDB');
  await db.raw('create table correction_item(id bigint auto_increment primary key,correction_id varchar(64),complaint_id varchar(64),assignment_id varchar(64),field_name varchar(64),field_label varchar(64),old_value text,new_value text,basis varchar(500),status varchar(64),confirmer_id varchar(64),confirmer_name varchar(64),confirmed_at datetime,created_at datetime) engine=InnoDB');
  await db.raw('create table operation_audit_log(id bigint auto_increment primary key,audit_id varchar(64),user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  for(const file of ['20260917100200__m2_complaint_g1_columns.js','20260917100400__m4_correction_confidence.js','20260917101100__m11_complaint_overtime_flag.js','20261009010000__effective_field_protection.js','20261009070000__dictionary_governance_categories.js'])await require('../migrations/'+file).up(db);
  for(let i=1;i<=7;i++)await db('complaint').insert({complaint_id:'C'+i,complaint_no:'LOCAL'+i,source_system:'synthetic',source_id:i===1?'公文!%_':'SOURCE'+i,title:'Synthetic',address:i===1?'B':null,enterprise_code:i===7?'OUTSIDE':'E1',district_code:'D1',received_at:'2026-10-09 08:00:00',source_fields:i===1?JSON.stringify({address:'A',_receivedAt:'2026-10-09T00:00:00Z'}):null});
  const {pool}=await import('../src/db/pool');close=()=>pool.end();
  const {runWithAccessContext}=await import('../src/auth/accessScope');
  const all={userId:'synthetic',roles:['custom'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
  const limited={...all,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:[]}]};
  await t.test('confirmed columnless disposal displays saved decision rather than source old value',async()=>runWithAccessContext(all,async()=>{
   await db('correction_item').insert({correction_id:'COR1',complaint_id:'C1',field_name:'disposal_result',old_value:JSON.stringify({result:'OLD',token:'SECRET'}),new_value:JSON.stringify({result:'NEW',token:'SECRET'}),status:'confirmed'});
   const {listByComplaint}=await import('../src/repositories/correctionRepo');const items=await listByComplaint(pool,'C1');assert.equal(items[0].effectiveValue,JSON.stringify({result:'NEW'}));assert.equal(items[0].oldValue,JSON.stringify({result:'OLD'}));
  }));
  await t.test('source-only escaped search and tied-date pages execute actual current-scope SQL',async()=>runWithAccessContext(limited,async()=>{
   const {listComplaints}=await import('../src/services/complaintService');
   assert.deepEqual((await listComplaints({keyword:'公文!%_'})).content.map(r=>r.complaintId),['C1']);
   const pages=await Promise.all([1,2,3].map(page=>listComplaints({page:String(page),size:'2'})));assert.deepEqual(pages.flatMap(p=>p.content.map(r=>r.complaintId)),['C6','C5','C4','C3','C2','C1']);assert.ok(pages.every(p=>p.total===6));
  }));
  assert.equal(existsSync(new URL('../migrations/20261009110000__source_process_history.js',import.meta.url)),true,'C1 real incremental migration missing');
  await require('../migrations/20261009110000__source_process_history.js').up(db);
  await require('../migrations/20261009110000__source_process_history.js').up(db);
  const service=await import('../src/services/sourceProcessService');
  const node=(extra:any={})=>({sourceSystem:'synthetic',sourceId:'公文!%_',nodeId:'N1',sourceSequence:1,sourceVersion:'v1',occurredAt:'2026-10-01T00:00:00Z',stage:'受理',department:'Synthetic department',contactName:'Synthetic contact',opinion:'第一行\n第二行',...extra});
  const batch=(nodes:any[],extra:any={})=>({nodes,nextCursor:null,complete:true,cutoffAt:'2026-10-02T00:00:00Z',...extra});
  await t.test('unavailable read is truthful and cross-object/soft-delete direct APIs deny',async()=>{
   const {sourceProcessesRouter}=await import('../src/routes/sourceProcesses');const {enforceRolePolicy}=await import('../src/middleware/requireRole');
   const app=express();app.use((req,_res,next)=>{(req as any).user={id:'u',username:'u',roles:['custom'],permissionCodes:[]};next();});app.use(enforceRolePolicy(),sourceProcessesRouter);app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status??500).json({code:err.code}));
   assert.equal((await request(app).get('/complaints/C1/source-processes')).status,403);
   assert.equal((await db('operation_audit_log').where({action:'ACCESS_DENIED',user_id:'u'})).length,1);
   await runWithAccessContext(limited,async()=>{const result=await service.getSourceProcesses('C1');assert.equal(result.state,'unavailable');assert.equal(result.complete,false);assert.deepEqual(result.nodes,[]);await assert.rejects(()=>service.getSourceProcesses('C7'),{status:404});});
   await db('complaint').where('complaint_id','C7').update({deleted:1});await runWithAccessContext(all,()=>assert.rejects(()=>service.getSourceProcesses('C7'),{status:404}));
  });
  await t.test('complete pages store revisions and only then advance watermark; replay zero additions',async()=>runWithAccessContext(all,async()=>{
   const cursors:Array<string|undefined>=[];
   await service.syncSourceProcesses('C1',{fetch:async(_id,cursor)=>{cursors.push(cursor);return cursor?batch([node({nodeId:'N2',sourceSequence:2}),node({nodeId:'N3',sourceSequence:null,occurredAt:null})]):batch([node()],{nextCursor:'opaque-page',complete:false});}});
   assert.deepEqual(cursors,[undefined,'opaque-page']);let result=await service.getSourceProcesses('C1');assert.equal(result.complete,true);assert.equal(result.cutoffAt,'2026-10-02T00:00:00.000Z');assert.deepEqual(result.nodes.map(n=>n.nodeId),['N1','N2','N3']);assert.deepEqual(result.missingTimeNodeIds,['N3']);assert.equal(result.revisions.length,3);
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node()])});result=await service.getSourceProcesses('C1');assert.equal(result.revisions.length,3);
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({sourceVersion:'v2',opinion:'REVISED'})])});result=await service.getSourceProcesses('C1');assert.equal(result.nodes[0].opinion,'REVISED');assert.deepEqual(result.revisions.filter(n=>n.nodeId==='N1').map(n=>n.sourceVersion),['v1','v2']);
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node()])});assert.equal((await service.getSourceProcesses('C1')).nodes[0].opinion,'REVISED','older known replay must not change current revision');
  }));
  await t.test('interrupted, partial, conflicting, cursor-loop and mixed-cutoff batches preserve old nodes/watermark',async()=>runWithAccessContext(all,async()=>{
   await service.syncSourceProcesses('C1',{fetch:async(_id,cursor)=>{if(cursor)throw Error('SECRET remote error');return batch([node({nodeId:'NEW'})],{nextCursor:'next',complete:false,cutoffAt:'2026-10-03T00:00:00Z'});}});
   let result=await service.getSourceProcesses('C1');assert.equal(result.state,'error');assert.equal(result.cutoffAt,'2026-10-02T00:00:00.000Z');assert.equal(result.nodes.length,3);assert.equal(JSON.stringify(result).includes('SECRET'),false);
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'PARTIAL'})],{complete:false,cutoffAt:'2026-10-04T00:00:00Z'})});result=await service.getSourceProcesses('C1');assert.equal(result.state,'partial');assert.equal(result.cutoffAt,'2026-10-02T00:00:00.000Z');assert.equal(result.nodes.length,4);
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'ROLLBACK'}),node({opinion:'SAME_VERSION_DIFFERENT'})],{cutoffAt:'2026-10-05T00:00:00Z'})});result=await service.getSourceProcesses('C1');assert.equal(result.state,'error');assert.equal(result.nodes.length,4);assert.equal(result.revisions.length,5);assert.equal(result.cutoffAt,'2026-10-02T00:00:00.000Z');
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node()],{nextCursor:'repeat',complete:false})});assert.equal((await service.getSourceProcesses('C1')).state,'error');
   await service.syncSourceProcesses('C1',{fetch:async(_id,cursor)=>cursor?batch([node()],{cutoffAt:'2026-10-06T00:00:00Z'}):batch([node()],{nextCursor:'n',complete:false})});assert.equal((await service.getSourceProcesses('C1')).state,'error');
  }));
  await t.test('null versions never allow a fabricated revision, concurrent batch cannot overwrite newer watermark',async()=>runWithAccessContext(all,async()=>{
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'NO_VERSION',sourceVersion:null})])});
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'NO_VERSION',sourceVersion:null,opinion:'different'})])});assert.equal((await service.getSourceProcesses('C1')).state,'error');
   let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
   const slow=service.syncSourceProcesses('C1',{fetch:async()=>{entered();await gate;return batch([node({nodeId:'STALE'})],{cutoffAt:'2026-10-07T00:00:00Z'});}});await started;
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'WINNER'})],{cutoffAt:'2026-10-08T00:00:00Z'})});release();await assert.rejects(()=>slow,{status:409});const result=await service.getSourceProcesses('C1');assert.equal(result.cutoffAt,'2026-10-08T00:00:00.000Z');assert.equal(result.nodes.some(n=>n.nodeId==='STALE'),false);
  }));
  await t.test('scope is rechecked after adapter fetch before persistence',async()=>runWithAccessContext(limited,async()=>{
   await assert.rejects(()=>service.syncSourceProcesses('C1',{fetch:async()=>{await db('complaint').where('complaint_id','C1').update({enterprise_code:'OUTSIDE'});return batch([node({nodeId:'DENIED'})]);}}),{status:404});assert.equal((await db('source_process_revision').where('node_id','DENIED')).length,0);
   await assert.rejects(()=>service.getSourceProcesses('C1'),{status:404});await db('complaint').where('complaint_id','C1').update({enterprise_code:'E1'});
  }));
  await t.test('four synthetic sources reconcile separate identities without local timeline facts',async()=>runWithAccessContext(all,async()=>{
   for(let i=2;i<=5;i++){
    const system='synthetic-source-'+i;await db('complaint').where('complaint_id','C'+i).update({source_system:system});
    const n=node({sourceSystem:system,sourceId:'SOURCE'+i,nodeId:'SAME-NODE-ID',opinion:'SOURCE-'+i});
    await service.syncSourceProcesses('C'+i,{fetch:async()=>batch([n])});const result=await service.getSourceProcesses('LOCAL'+i);
    assert.deepEqual(result.nodes.map(r=>[r.sourceSystem,r.sourceId,r.nodeId,r.opinion]),[[system,'SOURCE'+i,'SAME-NODE-ID','SOURCE-'+i]]);
   }
   assert.equal((await service.getSourceProcesses('C1')).nodes.some(n=>n.nodeId==='SAME-NODE-ID'),false);
  }));
  await t.test('typed unavailable adapter preserves prior source history without claiming complete sync',async()=>runWithAccessContext(all,async()=>{
   const {UnavailableSourceProcessAdapter}=await import('../src/domain/sourceProcess');const before=await service.getSourceProcesses('C1');
   const result=await service.syncSourceProcesses('C1',new UnavailableSourceProcessAdapter());assert.equal(result.state,'unavailable');assert.equal(result.complete,false);assert.deepEqual(result.nodes,before.nodes);assert.equal(result.cutoffAt,before.cutoffAt);
  }));
  await t.test('metadata and nodes are one SQL snapshot when another batch commits during the read',async()=>runWithAccessContext(all,async()=>{
   await service.syncSourceProcesses('C1',{fetch:async()=>batch([],{cutoffAt:'2026-10-08T00:00:00Z'})});
   const original=pool.query;
   pool.query=(async(...args:any[])=>{
    const rows=await (original as any).apply(pool,args);
    if(String(args[0]).includes('source_process_stream')){
     pool.query=original;
     await service.syncSourceProcesses('C1',{fetch:async()=>batch([node({nodeId:'READ-RACE-PARTIAL'})],{complete:false})});
    }
    return rows;
   }) as typeof pool.query;
   try{const result=await service.getSourceProcesses('C1');assert.equal(result.nodes.some(n=>n.nodeId==='READ-RACE-PARTIAL'),!result.complete,'complete metadata must not claim a later partial node batch');}
   finally{pool.query=original;}
  }));
 }finally{if(close)await close();await db.destroy();}
});
