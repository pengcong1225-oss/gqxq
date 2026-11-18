import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
test('comparison requires two or three distinct grids and highlights ties; seasonal windows cross year',async()=>{
 assert.ok(existsSync(new URL('../src/domain/businessAssessment.ts',import.meta.url)),'assessment domain implemented');const d=await import('../src/domain/businessAssessment');
 assert.throws(()=>d.compareAdminGrids(['A'],[]));assert.throws(()=>d.compareAdminGrids(['A','A'],[]));assert.throws(()=>d.compareAdminGrids(['A','B','C','D'],[]));
 const row={complaintId:'1',adminGridCode:'A',majorCode:'W',dictionaryVersion:'5'};const result=d.compareAdminGrids(['A','B'],[row,{...row,complaintId:'2',adminGridCode:'B'},row]);assert.deepEqual(result.categories[0].highest,['A','B']);assert.equal(result.totals.A,1);
 assert.deepEqual(d.seasonRange(2025,11,1),{from:'2025-11-01',to:'2026-01-31'});assert.deepEqual(d.seasonRange(2024,2,2),{from:'2024-02-01',to:'2024-02-29'});
 assert.equal(d.samePeriodYear('2024-02-29',2023),'2023-02-28');assert.equal(d.samePeriodYear('2024-12-01',2023),'2023-12-01');
});
test('top categories distinguish dictionary versions and stable ties',async()=>{const d=await import('../src/domain/businessAssessment');const rows=[{complaintId:'a',majorCode:'B',dictionaryVersion:'1'},{complaintId:'b',majorCode:'A',dictionaryVersion:'1'},{complaintId:'c',majorCode:'A',dictionaryVersion:'2'}];assert.deepEqual(d.topCategories(rows,3).map(r=>[r.code,r.dictionaryVersion,r.count]),[['A','1',1],['A','2',1],['B','1',1]]);});


import {alertCandidates,plannedUtilityEvidence} from '../src/domain/businessAlerts';
import {parseBusinessRule} from '../src/services/businessRuleService';
import {evaluateBusinessAlertsIn,authorizedAlerts} from '../src/services/businessAlertService';
import {matchRule} from '../src/auth/rolePolicy';
import type {BusinessEventContext} from '../src/types/businessEvents';
import type {Tx} from '../src/db/tx';
const actor:BusinessEventContext={userId:'u',permissionCodes:['statistics.read','dashboard.read','alert.handle','alert.read','shutdown.read'],access:{userId:'u',roles:['handler'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false}};
const rule={ruleId:'gas-rule',kind:'alert',expectedVersion:0,name:'正式燃气分类预警',businessType:'gas',dictionaryVersion:'1',majorCodes:['pressure'],minorCodes:[],effectiveFrom:'2020-01-01',effectiveTo:'2030-12-31',scene:'gas_three_piece',startMonth:null,endMonth:null,threshold:2,windowDays:10,definitionBasis:'已确认安装分类定义',definitionConfirmed:true,enabled:true};
const fact=(id:string)=>({complaintId:id,enterpriseCode:'E1',districtCode:'D1',adminGridCode:'G1',businessType:'gas',businessAt:'2026-11-09T04:00:00Z'});
test('alert identities are stable, deduplicate facts and separate rule versions and grid ownership',()=>{
 const rows=[fact('1'),fact('1'),fact('2'),{...fact('3'),enterpriseCode:'E2'}, {...fact('4'),adminGridCode:null}];
 const first=alertCandidates({ruleId:'R',version:1,threshold:2,scope:'grid'},rows,'2026-11-01','2026-11-10');
 assert.equal(first.length,1);assert.equal(first[0].quantity,2);assert.deepEqual(first[0].complaintIds,['1','2']);
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:2,scope:'grid'},[...rows].reverse(),'2026-11-01','2026-11-10')[0].alertId,first[0].alertId);
 assert.notEqual(alertCandidates({ruleId:'R',version:2,threshold:2,scope:'grid'},rows,'2026-11-01','2026-11-10')[0].alertId,first[0].alertId);
});
function planned(){return {syncStatus:'mapped',issues:[],source:{dataMode:'real',kind:'gas-stops',fields:{nature:'planned'},sourceApplicationNo:'PU-1',revision:'v1',status:'11',approvalStatus:'APPROVED'},events:[{id:'U1',mode:'real',kind:'shutdown',sourceSystem:'public-utility',businessType:'gas',enterpriseId:'E1',districtCode:'D1',gridIds:['G1'],startsAt:'2026-11-09T00:00:00Z',endsAt:'2026-11-10T00:00:00Z',approvalStatus:'approved',revision:2}]} as any;}
test('planned shutdown uses current utility real evidence only, with explicit nature and approved matching ownership/time',()=>{
 const source=planned();assert.equal(plannedUtilityEvidence([fact('1')],[source]).length,1);
 for(const change of [(s:any)=>s.source.fields.nature=undefined,(s:any)=>s.source.dataMode='simulation',(s:any)=>s.events[0].approvalStatus='pending',(s:any)=>s.source.status='cancelled',(s:any)=>s.events[0].enterpriseId='E2',(s:any)=>s.events[0].gridIds=['G2'],(s:any)=>s.events[0].startsAt='2026-11-10T00:00:00Z']){const changed=planned();change(changed);assert.deepEqual(plannedUtilityEvidence([fact('1')],[changed]),[]);}
 assert.deepEqual(plannedUtilityEvidence([fact('1')],[source])[0],{complaintId:'1',eventId:'U1',sourceApplicationNo:'PU-1',sourceRevision:'v1',eventRevision:2});
});
test('published rule input requires formal mapping, confirmed gas definition, bounded thresholds and excludes old worker kind',()=>{
 assert.equal(parseBusinessRule(rule).scene,'gas_three_piece');
 for(const patch of [{kind:'restoration'},{majorCodes:[],minorCodes:[]},{definitionConfirmed:false},{businessType:'water'},{threshold:0},{windowDays:367},{effectiveTo:'2019-01-01'}])assert.throws(()=>parseBusinessRule({...rule,...patch}));
});
function dbFixture(incomplete=false){const saved=new Map<string,unknown[]>();const queried:string[]=[];const db={query:async(sql:string,params:unknown[]=[])=>{queried.push(sql);
 if(sql.includes('from business_rule_version'))return [params[0]==='alert'?[{content:{...rule,scope:incomplete?'grid':'city'},version:1}]:[],[]];
 if(sql.includes(' from complaint c')){assert.match(sql,/c.enterprise_code in \(\?\)/);return [[1,2].map(id=>({id,complaint_id:String(id),complaint_no:'C'+id,business_type:'gas',complaint_type:'complaint',source_system:'宜接就办',source_id:'S'+id,source_event_status:'completed',source_synced_at:'2026-11-10T00:00:00Z',source_reported_at:'2026-11-09T04:00:00Z',enterprise_code:'E1',district_code:'D1',admin_grid_code:incomplete?null:'G1',major_category_code:'pressure',category_dictionary_version:'1',edit_version:1})),[]];}
 return [[],[]];},execute:async(sql:string,params:unknown[]=[])=>{if(sql.startsWith('insert ignore into business_alert')){const existed=saved.has(String(params[0]));if(!existed)saved.set(String(params[0]),params);return [{affectedRows:existed?0:1},[]];}return [{affectedRows:1},[]];}} as unknown as Tx;return {db,saved,queried};}
test('real alert service persists frozen trigger evidence, remains idempotent, and incomplete location cannot report normal',async()=>{
 const {db,saved,queried}=dbFixture();const a=await evaluateBusinessAlertsIn(db,'2026-11-10',actor);assert.equal(a.created,1);assert.equal(a.statuses[0].status,'triggered');
 const evidence=JSON.parse([...saved.values()][0][11] as string);assert.deepEqual(evidence.complaintIds,['1','2']);assert.equal(evidence.facts[0].editVersion,1);
 assert.equal((await evaluateBusinessAlertsIn(db,'2026-11-10',actor)).created,0);
 assert.equal(queried.some(sql=>sql.includes('shutdown_complaint_link')),false);
 const insufficient=await evaluateBusinessAlertsIn(dbFixture(true).db,'2026-11-10',actor);assert.equal(insufficient.created,0);assert.equal(insufficient.statuses[0].status,'insufficient');
 await assert.rejects(()=>evaluateBusinessAlertsIn(db,'2026-11-10',{...actor,permissionCodes:['alert.read']}));
});
test('saved alert disappears after any constituent complaint leaves current authorized scope',async()=>{
 let allowAll=false;const db={query:async(sql:string)=>sql.includes('from business_alert')?[[{enterprise_code:'E1',district_code:'D1',evidence:{complaintIds:['1','2']}}],[]]:[allowAll?[{complaint_id:'1'},{complaint_id:'2'}]:[{complaint_id:'1'}],[]]} as unknown as Tx;
 assert.deepEqual(await authorizedAlerts(db,actor),[]);allowAll=true;assert.equal((await authorizedAlerts(db,actor)).length,1);
 const locked={query:async(sql:string,...args:unknown[])=>{assert.match(sql,/for share$/);return db.query(sql,...args);}} as unknown as Tx;assert.equal((await authorizedAlerts(locked,actor,undefined,true)).length,1);
});
test('new feature routes have exact permissions and no legacy feedback worker route',()=>{
 assert.equal(matchRule('GET','/assessment/historical')?.permissionCode,'assessment.read');
 assert.equal(matchRule('POST','/business-rules/R/publish')?.permissionCode,'business.rules.manage');
 assert.equal(matchRule('POST','/business-alerts/evaluate')?.permissionCode,'alert.handle');
 assert.equal(matchRule('POST','/shutdown-feedback/recompute'),null);
});
