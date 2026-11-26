import test from 'node:test';
import assert from 'node:assert/strict';
import {alertCandidates,alertScopeMissingFields,resolveAlertScope,alertScopeOfCodes} from '../src/domain/businessAlerts';
import {parseBusinessRule,publishedRules} from '../src/services/businessRuleService';
import {evaluateBusinessAlertsIn,authorizedAlerts} from '../src/services/businessAlertService';
import type {BusinessEventContext} from '../src/types/businessEvents';
import type {Tx} from '../src/db/tx';
const fact=(id:string,enterpriseCode:string|null='E1',districtCode:string|null='D1',adminGridCode:string|null='G1')=>({complaintId:id,enterpriseCode,districtCode,adminGridCode});
const ruleContent={ruleId:'gas-rule',kind:'alert' as const,expectedVersion:0,name:'正式燃气分类预警',businessType:'gas' as const,dictionaryVersion:'1',majorCodes:['pressure'],minorCodes:[] as string[],effectiveFrom:'2020-01-01',effectiveTo:'2030-12-31',scene:'gas_three_piece' as const,startMonth:null,endMonth:null,threshold:2,windowDays:10,definitionBasis:'已确认安装分类定义',definitionConfirmed:true,enabled:true};
const actor:BusinessEventContext={userId:'u',permissionCodes:['statistics.read','dashboard.read','alert.handle','alert.read','shutdown.read'],access:{userId:'u',roles:['handler'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false}};
const cityActor: BusinessEventContext = { ...actor, access: { ...actor.access, rules: [{ kind: 'all' }] } };

test('city scope aggregates across grids and enterprises with NULL codes and scoped identity',()=>{
 const rows=[fact('1','E1','D1','G1'),fact('2','E2','D2','G2'),fact('3','E1','D2','G3')];
 const city=alertCandidates({ruleId:'R',version:1,threshold:3,scope:'city'},rows,'2026-11-01','2026-11-07');
 assert.equal(city.length,1);assert.equal(city[0].scope,'city');assert.equal(city[0].quantity,3);
 assert.deepEqual([city[0].enterpriseCode,city[0].districtCode,city[0].adminGridCode],[null,null,null]);
 // 全市口径跨网格/跨企业只有一组，网格口径仍是每组各计 1、不达阈值
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:3,scope:'grid'},rows,'2026-11-01','2026-11-07').length,0);
 // alert_id 含 scope，不同 scope 不得撞 id
 const districtOne=alertCandidates({ruleId:'R',version:1,threshold:1,scope:'district'},rows,'2026-11-01','2026-11-07').find(c=>c.districtCode==='D1');
 assert.ok(districtOne);assert.notEqual(districtOne.alertId,city[0].alertId);
});

test('district and enterprise scopes group by their own key and NULL the other codes',()=>{
 const rows=[fact('1','E1','D1','G1'),fact('2','E2','D1','G2'),fact('3','E1','D2','G3')];
 const district=alertCandidates({ruleId:'R',version:1,threshold:2,scope:'district'},rows,'2026-11-01','2026-11-07');
 assert.equal(district.length,1);assert.equal(district[0].districtCode,'D1');assert.equal(district[0].quantity,2);
 assert.deepEqual([district[0].enterpriseCode,district[0].adminGridCode],[null,null]);
 const enterprise=alertCandidates({ruleId:'R',version:1,threshold:2,scope:'enterprise'},rows,'2026-11-01','2026-11-07');
 assert.equal(enterprise.length,1);assert.equal(enterprise[0].enterpriseCode,'E1');assert.equal(enterprise[0].quantity,2);
 assert.deepEqual([enterprise[0].districtCode,enterprise[0].adminGridCode],[null,null]);
 assert.notEqual(district[0].alertId,enterprise[0].alertId);
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:1,scope:'grid'},rows,'2026-11-01','2026-11-07').length,3);
});

test('threshold is inclusive: exactly threshold triggers and one below does not',()=>{
 const rows=[fact('1'),fact('2')];
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:2,scope:'city'},rows,'2026-11-01','2026-11-07').length,1);
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:3,scope:'city'},rows,'2026-11-01','2026-11-07').length,0);
 assert.equal(alertCandidates({ruleId:'R',version:1,threshold:null,scope:'city'},rows,'2026-11-01','2026-11-07').length,0);
});

test('completeness requires scope-specific fields and missing fields are reported per row',()=>{
 const full={complaintId:'1',enterpriseCode:'E1',districtCode:'D1',adminGridCode:'G1',timeSource:'source_reported_at' as const,majorCode:'pressure',minorCode:null,dictionaryVersion:'20'};
 assert.deepEqual(alertScopeMissingFields(full,'city'),[]);
 assert.deepEqual(alertScopeMissingFields({...full,timeSource:'received_fallback' as const},'city'),['timeSource']);
 assert.deepEqual(alertScopeMissingFields({...full,majorCode:null,minorCode:null},'city'),['major/minor']);
 assert.deepEqual(alertScopeMissingFields({...full,majorCode:null,minorCode:'g01'},'city'),[]);
 assert.deepEqual(alertScopeMissingFields({...full,dictionaryVersion:null},'city'),['dictionaryVersion']);
 assert.deepEqual(alertScopeMissingFields({...full,districtCode:null},'city'),[]);
 assert.deepEqual(alertScopeMissingFields({...full,districtCode:null},'district'),['districtCode']);
 assert.deepEqual(alertScopeMissingFields({...full,enterpriseCode:null},'enterprise'),['enterpriseCode']);
 assert.deepEqual(alertScopeMissingFields({...full,districtCode:null},'enterprise'),[]);
 assert.deepEqual(alertScopeMissingFields({...full,adminGridCode:null},'grid'),['adminGridCode']);
 assert.deepEqual(alertScopeMissingFields({...full,districtCode:null,enterpriseCode:null,adminGridCode:null},'grid'),['districtCode','enterpriseCode','adminGridCode']);
});

test('legacy rule content without scope reads as city and publishedRules does not throw',async()=>{
 assert.equal(resolveAlertScope(undefined),'city');assert.equal(resolveAlertScope(null),'city');assert.equal(resolveAlertScope('bogus'),'city');assert.equal(resolveAlertScope('grid'),'grid');
 assert.equal(parseBusinessRule(ruleContent).scope,'city');
 assert.throws(()=>parseBusinessRule({...ruleContent,scope:'province'}));
 const db={query:async()=>[[{content:JSON.stringify(ruleContent),version:4}],[]]} as unknown as Pick<Tx,'query'>;
 const [rule]=await publishedRules(db,'alert');
 assert.equal(rule.scope,'city');assert.equal(rule.version,4);
 assert.equal(alertScopeOfCodes(null,null,null),'city');assert.equal(alertScopeOfCodes('E1',null,null),'enterprise');
 assert.equal(alertScopeOfCodes(null,'D1',null),'district');assert.equal(alertScopeOfCodes('E1','D1','G1'),'grid');
});

test('authorizedAlerts handles city alert rows whose ownership codes are NULL',async()=>{
 const evidence={scope:'city',scene:'gas_three_piece',ruleName:'r',definitionBasis:'b',dictionaryVersion:'1',complaintIds:['1'],facts:[],dataCutoffAt:'2026-11-10T00:00:00Z'};
 const db={query:async(sql:string)=>sql.includes('from business_alert')?[[{alert_id:'A',rule_id:'R',rule_version:1,window_from:'2026-11-04',window_to:'2026-11-10',enterprise_code:null,district_code:null,admin_grid_code:null,quantity:1,threshold_value:7,state:'open',evidence,created_at:'2026-11-10T00:00:00Z'}],[]]:[[{complaint_id:'1'}],[]]} as unknown as Tx;
 const allActor:BusinessEventContext={...actor,access:{...actor.access,rules:[{kind:'all'}]}};
 const rows=await authorizedAlerts(db,allActor);
 assert.equal(rows.length,1);assert.equal(rows[0].evidence.scope,'city');
 // 受限授权按所有权过滤不可见全域统计，但不得因 NULL 三码抛错或误判
 assert.deepEqual(await authorizedAlerts(db,actor),[]);
 const evidenceNullDb={query:async(sql:string)=>sql.includes('from business_alert')?[[{alert_id:'B',rule_id:'R',rule_version:1,window_from:'2026-11-04',window_to:'2026-11-10',enterprise_code:null,district_code:null,admin_grid_code:null,quantity:1,threshold_value:7,state:'open',evidence:null,created_at:'2026-11-10T00:00:00Z'}],[]]:[[],[]]} as unknown as Tx;
 assert.deepEqual(await authorizedAlerts(evidenceNullDb,allActor),[]);
});

function fixture(options:{scope?:string;grids:(string|null)[];enterprises?:(string|null)[];districts?:(string|null)[];category?:string}){
 const saved=new Map<string,unknown[]>();
 const rule:Record<string,unknown>={...ruleContent};if(options.scope!==undefined)rule.scope=options.scope;
 const rows=options.grids.map((grid,index)=>({id:index+1,complaint_id:String(index+1),complaint_no:'C'+(index+1),business_type:'gas',complaint_type:'complaint',source_system:'宜接就办',source_id:'S'+(index+1),source_event_status:'completed',source_synced_at:'2026-11-10T00:00:00Z',source_reported_at:'2026-11-09T04:00:00Z',enterprise_code:options.enterprises?.[index]??'E1',district_code:options.districts?.[index]??'D1',admin_grid_code:grid,major_category_code:options.category??'pressure',category_dictionary_version:'1',edit_version:1}));
 const db={query:async(sql:string,params:unknown[]=[])=>{
  if(sql.includes('from business_rule_version'))return [params[0]==='alert'?[{content:rule,version:1}]:[],[]];
  if(sql.includes(' from complaint c'))return [rows,[]];
  return [[],[]];
 },execute:async(sql:string,params:unknown[]=[])=>{
  if(sql.startsWith('insert ignore into business_alert')){const key=String(params[0]),existed=saved.has(key);if(!existed)saved.set(key,params);return [{affectedRows:existed?0:1},[]];}
  return [{affectedRows:1},[]];
 }} as unknown as Tx;
 return {db,saved};
}

test('restricted evaluation cannot persist a city alert or a district group it only partly sees', async () => {
 const city = fixture({ scope: 'city', grids: ['G1', 'G1'] });
 const district = fixture({ scope: 'district', grids: ['G1', 'G1'] });
 for (const scenario of [city, district]) {
  const denied = await evaluateBusinessAlertsIn(scenario.db, '2026-11-10', actor);
  assert.equal(denied.created, 0);
  assert.equal(denied.statuses[0].status, 'insufficient');
  assert.match(String(denied.statuses[0].reason), /权限/);
  assert.equal(scenario.saved.size, 0);
  const allowed = await evaluateBusinessAlertsIn(scenario.db, '2026-11-10', cityActor);
  assert.equal(allowed.created, 1);
  assert.equal(scenario.saved.size, 1);
 }
 const enterprise = fixture({ scope: 'enterprise', grids: ['G1', 'G1'] });
 assert.equal((await evaluateBusinessAlertsIn(enterprise.db, '2026-11-10', actor)).created, 1);
});

test('legacy city-scope evaluation aggregates all grids and persists NULL ownership codes',async()=>{
 const {db,saved}=fixture({grids:['G1','G2']});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',cityActor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(result.created,1);assert.equal(result.statuses.length,1);
 assert.equal(status.scope,'city');assert.equal(status.status,'triggered');
 assert.equal(status.eligibleCount,2);assert.equal(status.incompleteCount,0);assert.equal(status.count,2);
 const params=[...saved.values()][0];
 assert.deepEqual([params[5],params[6],params[7]],[null,null,null]);
 assert.equal((JSON.parse(params[11] as string) as Record<string,unknown>).scope,'city');
});

test('incomplete rows do not poison the window: grid scope triggers on eligible rows and reports counts',async()=>{
 const {db,saved}=fixture({scope:'grid',grids:['G1','G1',null]});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',actor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(result.created,1);
 assert.equal(status.scope,'grid');assert.equal(status.status,'triggered');
 assert.equal(status.eligibleCount,2);assert.equal(status.incompleteCount,1);
 assert.match(String(status.reason),/可判定 2 件 \/ 缺字段 1 件/);
 const params=[...saved.values()][0];
 assert.deepEqual([params[5],params[6],params[7]],['E1','D1','G1']);
});

test('scope without any eligible row is insufficient and says coverage is insufficient',async()=>{
 const {db,saved}=fixture({scope:'grid',grids:[null,null]});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',actor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(result.created,0);assert.equal(saved.size,0);
 assert.equal(status.status,'insufficient');assert.equal(status.eligibleCount,0);assert.equal(status.incompleteCount,2);
 assert.match(String(status.reason),/可判定 0 件 \/ 缺字段 2 件/);
 assert.match(String(status.reason),/覆盖不足/);
});

test('district scope aggregates by district and persists only the district code',async()=>{
 const {db,saved}=fixture({scope:'district',grids:['G1','G2'],enterprises:['E1','E2'],districts:['D1','D1']});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',cityActor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(result.created,1);assert.equal(status.scope,'district');assert.equal(status.eligibleCount,2);
 const params=[...saved.values()][0];
 assert.deepEqual([params[5],params[6],params[7]],[null,'D1',null]);
});

test('zero matching records is insufficient and says no hit instead of reporting normal',async()=>{
 const {db}=fixture({scope:'city',grids:['G1'],category:'other'});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',cityActor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(status.status,'insufficient');assert.equal(status.eligibleCount,0);assert.equal(status.incompleteCount,0);
 assert.match(String(status.reason),/可判定 0 件 \/ 缺字段 0 件/);
 assert.match(String(status.reason),/无命中/);
});

test('below-threshold evaluation reports eligible/incomplete counts instead of silence',async()=>{
 const {db}=fixture({scope:'city',grids:['G1']});
 const result=await evaluateBusinessAlertsIn(db,'2026-11-10',cityActor);
 const status:Record<string,unknown>=result.statuses[0] as Record<string,unknown>;
 assert.equal(status.status,'below_threshold');assert.equal(status.eligibleCount,1);assert.equal(status.incompleteCount,0);
 assert.match(String(status.reason),/可判定 1 件 \/ 缺字段 0 件/);
 assert.match(String(status.reason),/未达阈值/);
});
