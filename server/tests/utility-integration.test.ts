import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mapUtilityFeed,feedTime,utilityPolygonsOverlap,type UtilityFeedItem,type FeedReferences} from '../src/domain/utilityFeed';
import {utilityGcj02ToWgs84,utilityWgs84ToGcj02} from '../src/domain/utilityCoordinates';
import {pool} from '../src/db/pool';
import {env} from '../src/config/env';
import {simulatedSupportData} from '../src/domain/tenderSupportData';
import {syncUtilityFeedMode,deliverUtilityTimeout,utilitySystemContext} from '../src/services/utilityIntegrationService';
import {utilityList,utilityTimeouts,utilityComplaints} from '../src/services/utilityService';

const ring=[[111.27,30.70],[111.29,30.70],[111.29,30.72],[111.27,30.72],[111.27,30.70]];
const refs:FeedReferences={enterprises:[{id:'W',name:'水务公司',businessType:'water'}],grids:[{id:'G',name:'网格一',districtCode:'D',geometry:{type:'Polygon',coordinates:[ring]},coordinateSystem:'WGS84',geometrySource:'权威边界'}],mappings:[]};
const source:UtilityFeedItem={feedId:2,sourceApplicationNo:'PU-report-1',sourceKind:'native',sourceId:'1',kind:'water-stops',dataMode:'real',revision:'one',status:'11',fields:{companyName:'水务公司',tingshuiDate:'2026-11-09 08:00',fugongDate:'2026-11-09 10:00',tingshuiRange:[{name:'网格一'}]},approvalTraces:[{action:'APPROVE',operator:'审批员',time:'2026-11-08 10:00',opinion:'同意'}],changedAt:'2026-11-09T10:00:00+08:00'};

test('feed classification, source approval provenance, Shanghai times and remapping revisions',()=>{
 const mapped=mapUtilityFeed(source,'real',refs);assert.equal(mapped.syncStatus,'mapped');assert.equal(mapped.events[0].sourceSystem,'public-utility');assert.equal(mapped.events[0].startsAt,'2026-11-09T00:00:00.000Z');
 assert.equal(mapUtilityFeed({...source,dataMode:'simulation'},'real',refs).events.length,0);
 assert.equal(mapUtilityFeed({...source,approvalTraces:[]},'real',refs).events.length,0);
 assert.equal(mapUtilityFeed({...source,fields:{...source.fields,companyName:'未知单位'}},'real',refs).syncStatus,'pending_mapping');
 const update=mapUtilityFeed({...source,revision:'two'},'real',refs);assert.notEqual(mapped.events[0].revision,update.events[0].revision);
 const returned={...source,approvalStatus:'RETURNED'};
 assert.equal(mapUtilityFeed(returned,'real',refs).syncStatus,'pending_mapping','an earlier approval cannot substantiate a return');
 assert.equal(mapUtilityFeed({...returned,approvalTraces:[...source.approvalTraces,{action:'RETURN',operator:'退回人',time:'2026-11-08 11:00'}]},'real',refs).events[0].approvalStatus,'rejected');
 assert.equal(mapUtilityFeed({...source,approvalTraces:[...source.approvalTraces,{action:'RETURN',operator:'历史退回人',time:'2026-11-08 09:00'}]},'real',refs).events[0]?.approvedBy,'审批员','native engine and report traces are concatenated, not globally time-ordered');
 const simulationSubject=mapUtilityFeed({...source,dataMode:'simulation',enterprise:{subjectId:910081006,organizationCode:'ACTUAL-ORG',name:'真实单位名'},fields:{...source.fields,companyName:'真实单位名'}},'simulation',{...refs,mappings:[{sourceDepartmentCode:'910081006',enterpriseCode:'W'}]});assert.equal(simulationSubject.syncStatus,'mapped','numeric subject id mapping must remain effective when organizationCode is present');
 assert.equal(mapUtilityFeed({...source,sourceKind:'legacy',approvalStatus:'1'},'real',refs).events[0].approvalStatus,'approved','legacy migration numeric status cannot override explicit raw business11 and real approvaltrace');
 assert.equal(mapUtilityFeed({...source,sourceKind:'legacy',approvalStatus:'3',approvalTraces:[{action:'1',operator:'旧审批人',time:'2026-11-08 10:00'}]},'real',refs).syncStatus,'pending_mapping','unknown numeric trace action cannot be invented as approval');
 assert.equal(mapUtilityFeed({...source,approvalTraces:[{action:'审核通过',operator:'填报审批人',time:'2026-11-08 10:00'}]},'real',refs).events[0]?.approvedBy,'填报审批人');
 assert.equal(mapUtilityFeed({...source,approvalTraces:[{action:'PROPOSED_APPROVE',operator:'待决审批人',time:'2026-11-08 10:00'}]},'real',refs).syncStatus,'pending_mapping');
 assert.equal(mapUtilityFeed({...source,sourceKind:'legacy',approvalStatus:'WITHDRAWN'},'real',refs).events[0]?.approvalStatus,'pending');
 assert.equal(feedTime('bad'),null);assert.equal(feedTime('2026-02-30 08:00'),null);
});

test('geometry needs declared CRS, converts native GCJ02 objectpoints, respects holes and distinct boundaries',()=>{
 const raw=ring.map(([longitude,latitude])=>{const p=utilityWgs84ToGcj02(longitude,latitude);return {longitude:p[0],latitude:p[1]};});
 const spatial={...source,coordinateSystem:'GCJ02',fields:{...source.fields,tingshuiRange:JSON.stringify([{name:'空间范围',points:raw}])}};
 assert.equal(mapUtilityFeed(spatial,'real',refs).syncStatus,'mapped');
 assert.equal(mapUtilityFeed({...spatial,fields:{...spatial.fields,tingshuiRange:JSON.stringify(spatial.fields.tingshuiRange)}},'real',refs).syncStatus,'mapped');
 assert.equal(mapUtilityFeed({...spatial,coordinateSystem:null},'real',refs).syncStatus,'pending_mapping');
 const communityPoints=[{lng:111.28,lat:30.71,gridCode:'G'}];
 const invalid={...spatial,coordinateSystem:'WGS84',fields:{...source.fields,tingshuiRange:[{name:'空间范围',latLog:'111.27,30.70;111.29,30.72;111.29,30.70;111.27,30.72'}]}};
 const unmapped=mapUtilityFeed(invalid,'real',{...refs,communityPoints});
 assert.equal(unmapped.syncStatus,'pending_mapping');
 assert.ok(unmapped.events.every(event=>event.gridIds.length===0));
 assert.equal(mapUtilityFeed({...spatial,coordinateSystem:'BD09'},'real',{...refs,communityPoints}).syncStatus,'pending_mapping');
 const p=utilityGcj02ToWgs84(...utilityWgs84ToGcj02(111.28,30.71));assert.ok(Math.abs(p[0]-111.28)<1e-8&&Math.abs(p[1]-30.71)<1e-8);
 assert.equal(utilityPolygonsOverlap([[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[3,1],[3,3],[1,3],[1,1]]],[[[1.5,1.5],[2,1.5],[2,2],[1.5,2],[1.5,1.5]]]),false);
 assert.equal(utilityPolygonsOverlap([[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[1,0],[2,0],[2,1],[1,1],[1,0]]]),false);
 assert.equal(utilityPolygonsOverlap([[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[2,0],[3,0],[3,1],[2,1],[2,0]]]),false);
});

test('real timeout matching uses resolved formal categories and explicit 宜接就办 provenance',async()=>{
 const e=mapUtilityFeed({...source,fields:{...source.fields,relatedTypes:['水压问题']}},'real',refs).events[0];let checked=false;
 const query=test.mock.method(pool,'query',(async(sql:string,args:any[])=>{
  if(sql.includes('from dict_item')){assert.ok(args.includes('水压问题'));return [[{code:'w04',label:'水压问题'}],[]];}
  assert.ok(sql.includes('c.source_system=?'));assert.ok(args.includes('宜接就办'));
  assert.ok(sql.includes('c.major_category_code in'));assert.ok(sql.includes('c.minor_category_code in'));assert.ok(!sql.includes('c.complaint_type in'));assert.ok(args.includes('w04'));assert.ok(args.includes('G'));checked=true;
  return [[{id:'REAL-C',title:'真实诉求',majorCode:'water',minorCode:'w04',type:'w04',gridId:'G',occurredAt:new Date('2026-11-09T03:00:00.123Z')}],[]];
 }) as any);
 try{const rows=await utilityComplaints(e,utilitySystemContext,e.restoredAt!,new Date(Date.parse(e.restoredAt!)+86400000).toISOString(),true);assert.equal(checked,true);assert.equal(rows[0].type,'水压问题');assert.equal(rows[0].occurredAt,'2026-11-09T03:00:00.123Z');}finally{query.mock.restore();}
});

test('signed simulation feed upserts separate storage; persisted bytes survive failure retry and source revisions invalidate stale work',async()=>{
 const memory=new Map<string,{revision:number;content:any}>(),history:any[]=[];
 const query=async(sql:string,args:any[]=[])=>{
  if(sql.includes('from gqxq_tender_support_store')&&sql.includes('like ?'))return [[...memory.entries()].filter(([key])=>key.startsWith(args[0].slice(0,-1))).map(([,row])=>({content:JSON.stringify(row.content)})),[]];
  if(sql.includes('from gqxq_tender_support_store')){const row=memory.get(args[0]);return [row?[{revision:row.revision,content:JSON.stringify(row.content,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value)}]:[],[]];}
  if(sql.includes('from gqxq_tender_support_history'))return [history.filter(h=>h.key===args[0]).map(h=>({content:JSON.stringify(h.content)})),[]];
  throw Error('Unexpected query '+sql);
 };
 const execute=async(sql:string,args:any[])=>{
  if(sql.startsWith('insert ignore into gqxq_tender_support_store')){assert.ok(args[0].length<=40);assert.ok(args[1]);if(!memory.has(args[0]))memory.set(args[0],{revision:0,content:{}});}
  else if(sql.startsWith('update gqxq_tender_support_store'))memory.set(args[3],{revision:args[0],content:JSON.parse(args[1])});
  else if(sql.startsWith('insert into gqxq_tender_support_history'))history.unshift({key:args[0],content:JSON.parse(args[2])});
  else if(!sql.startsWith('insert into operation_audit_log'))throw Error('Unexpected execute '+sql);
  return [{affectedRows:1},[]];
 };
 const queryMock=test.mock.method(pool,'query',query as any),connMock=test.mock.method(pool,'getConnection',async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}}) as any);
 const pu=env.pu as any,old={...pu};pu.baseUrl='http://utility.test';pu.keyId='test';pu.secret='test-secret';pu.timeoutMs=1000;process.env.GQXQ_PU_UTILITY_SYNC_ENABLED='true';
 const data=simulatedSupportData('2026-11-10'),complaint=data.complaints.filter(c=>c.type==='水压问题'&&Date.parse(c.occurredAt)<Date.now()).at(-1)!;
 let item:UtilityFeedItem={...source,dataMode:'simulation',revision:'initial',fields:{companyName:data.enterprises.find(e=>e.id===complaint.enterpriseId)!.name,startsAt:new Date(Date.parse(complaint.occurredAt)-25*3600000).toISOString(),endsAt:new Date(Date.parse(complaint.occurredAt)-3600000).toISOString(),restoredAt:new Date(Date.parse(complaint.occurredAt)-3600000).toISOString(),tingshuiRange:[{name:data.grids.find(g=>g.id===complaint.gridId)!.name}]}};
 let receiptOutcome:'unavailable'|'wrong-mode'|'duplicate'='unavailable';const sends:string[]=[];
 let inFlightTaskId:string|undefined;
 const fetchMock=test.mock.method(globalThis,'fetch',async(url:any,init:any)=>{
  const text=Buffer.from(init.body).toString('utf8'),path=new URL(String(url)).pathname,headers=init.headers;
  const hash=createHash('sha256').update(Buffer.from(init.body)).digest('hex');
  const canonical=['v1','POST',path,headers['X-PU-Timestamp'],headers['X-PU-Nonce'],hash].join('\n');
  assert.equal(headers['X-PU-Signature'],createHmac('sha256','test-secret').update(canonical).digest('hex'));
  if(path.endsWith('/utility-feed'))return new Response(JSON.stringify({items:[item],nextAfterId:2,snapshotMaxId:2,hasMore:false,unclassifiedCount:3}));
  const payload=JSON.parse(text);assert.equal(payload.mode,'simulation');assert.equal(typeof payload.eventRevision,'string');assert.ok(payload.complaints.some((c:any)=>c.id===complaint.id));assert.ok([...memory.values()].some(row=>row.content.batches?.some((b:any)=>b.bodyText===text)),'request bytes must be committed before network IO');sends.push(text);
  if(sends.length===1)assert.equal((await deliverUtilityTimeout('simulation',inFlightTaskId!)).status,'pending','the written lease protects the same delivery during a concurrent retry');
  if(receiptOutcome==='unavailable')return new Response('{}',{status:503});
  return new Response(JSON.stringify({receiptId:7,deliveryId:payload.deliveryId,status:'duplicate',mode:receiptOutcome==='wrong-mode'?'real':'simulation'}));
 });
 try{
  await syncUtilityFeedMode('simulation');const listed=await utilityList('simulation','shutdown',utilitySystemContext);assert.equal(listed.integration.pendingMapping,0);assert.equal(listed.sourceRows.length,1);assert.ok(listed.events.some(e=>e.sourceSystem==='public-utility'));
  const limited=await utilityList('simulation','shutdown',{...utilitySystemContext,access:{...utilitySystemContext.access,rules:[{kind:'restricted',enterpriseCodes:[complaint.enterpriseId],districtCodes:[data.grids.find(g=>g.id===complaint.gridId)!.districtCode]}]}});assert.equal(limited.integration,undefined,'restricted application list must not expose global sync counts or errors');assert.deepEqual(limited.sourceRows,[]);
  const version=memory.get('utility-feed-simulation')!.revision;await syncUtilityFeedMode('simulation');assert.equal(memory.get('utility-feed-simulation')!.revision,version,'unchanged snapshots do not generate false revisions');
  assert.ok(!memory.has('utility-simulation')&&!memory.has('utility-real'),'feed cannot replace manual fixtures or real lane');
  const tasks=await utilityTimeouts('simulation',utilitySystemContext),task=tasks.items.find(i=>i.sourceSystem==='public-utility')!;assert.ok(task);
  inFlightTaskId=task.id;
  assert.equal((await deliverUtilityTimeout('simulation',task.id)).status,'failed');
  [...memory.values()].find(row=>row.content.batches)!.content.nextAttemptAt=null;receiptOutcome='wrong-mode';
  assert.equal((await deliverUtilityTimeout('simulation',task.id)).status,'failed');
  [...memory.values()].find(row=>row.content.batches)!.content.nextAttemptAt=null;receiptOutcome='duplicate';
  assert.equal((await deliverUtilityTimeout('simulation',task.id)).status,'sent');assert.equal(sends.length,3);assert.equal(new Set(sends).size,1);
  await deliverUtilityTimeout('simulation',task.id);assert.equal(sends.length,3,'accepted receipt prevents repeat sends');
  const latestOutbox=[...memory.values()].find(row=>row.content.batches)!;latestOutbox.content.item.status='failed';latestOutbox.content.nextAttemptAt=null;item={...item,revision:'changed',approvalStatus:'PENDING'};await syncUtilityFeedMode('simulation');
  assert.equal((await deliverUtilityTimeout('simulation',task.id)).status,'superseded');assert.equal(sends.length,3,'stale approvals cannot be retried');
  const simulatedVersion=memory.get('utility-feed-simulation')!.revision;
  item={...item,dataMode:'real'};
  await assert.rejects(syncUtilityFeedMode('simulation'),/来源契约无效/);
  assert.equal(memory.get('utility-feed-simulation')!.revision,simulatedVersion,'mixed-mode feed cannot replace a valid snapshot');
 }finally{queryMock.mock.restore();connMock.mock.restore();fetchMock.mock.restore();Object.assign(pu,old);delete process.env.GQXQ_PU_UTILITY_SYNC_ENABLED;}
});
