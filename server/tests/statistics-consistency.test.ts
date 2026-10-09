import assert from 'node:assert/strict';
import test from 'node:test';
let api:any;
test.before(async()=>{try{api=await import('../src/domain/statisticsQuery');}catch{} });
test.beforeEach(()=>assert.equal(typeof api?.normalizeStatisticsQuery,'function','D1 normalized query is missing'));
const access={userId:'synthetic',roles:['custom'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false};
const clock=()=>new Date('2026-10-09T16:00:00Z');
const raw=(extra:any={})=>({dataset:'ledger',projection:'current',periodKind:'month',from:'2026-09-01',to:'2026-09-30',comparisonPolicyId:'candidate-calendar-v1',...extra});
const query=(extra:any={})=>{assert.equal(typeof api?.normalizeStatisticsQuery,'function','D1 normalized query is missing');return api.normalizeStatisticsQuery(raw(extra),access,clock);};
test('strict explicit dataset/projection/calendar policy with Shanghai half-open endpoints',()=>{
 const q=query();assert.equal(q.dataset,'ledger');assert.deepEqual(api.toShanghaiHalfOpenRange(q),{start:'2026-08-31T16:00:00.000Z',end:'2026-09-30T16:00:00.000Z'});
 for(const extra of [{dataset:undefined},{projection:undefined},{periodKind:undefined},{dataset:'all'},{projection:'entry_snapshot'},{comparisonPolicyId:'approved'},{from:'2026-02-30'},{from:'2026-09-02'},{to:'2026-10-11'},{from:['2026-09-01']},{from:'2026-10-01',to:'2026-09-01'}])assert.throws(()=>query(extra));
 assert.equal(api.STATISTICS_POLICY.status,'candidate');assert.match(api.STATISTICS_POLICY.label,/待业务确认/);assert.throws(()=>query({status:'approved'}));
});
test('monthly full period baselines and finite 10/8/5 changes',()=>{
 const periods=api.resolveComparisonPeriods(query());assert.deepEqual(periods.map((p:any)=>[p.kind,p.from,p.to]),[['yoy','2025-09-01','2025-09-30'],['mom','2026-08-01','2026-08-31']]);
 assert.equal(api.computePeriodChange(10,8).changePercent,25);assert.equal(api.computePeriodChange(10,5).changePercent,100);assert.deepEqual(api.computePeriodChange(0,0),{changePercent:null,reason:'基期为零'});
 assert.equal(api.computePeriodChange(10,0,true).reason,'存在业务日期未知的记录，比较不完整');
});
test('partial March baseline truncates at February end and discloses actual day counts',()=>{
 const q=query({from:'2026-03-01',to:'2026-03-30'});const mom=api.resolveComparisonPeriods(q)[1];assert.equal(mom.to,'2026-02-28');assert.equal(mom.currentDays,30);assert.equal(mom.baselineDays,28);assert.equal(mom.truncated,true);
});
test('quarter and year calendar semantics are explicit',()=>{
 const quarter=api.resolveComparisonPeriods(query({periodKind:'quarter',from:'2026-07-01',to:'2026-09-30'}));assert.deepEqual(quarter.map((p:any)=>[p.from,p.to]),[['2025-07-01','2025-09-30'],['2026-04-01','2026-06-30']]);assert.match(quarter[1].label,/上季度/);
 const year=api.resolveComparisonPeriods(query({periodKind:'year',from:'2025-01-01',to:'2025-12-31'}));assert.equal(year[1].from,null);assert.equal(year[1].reason,'年度环比未定义');
});
test('custom leap-day endpoint clamp and cross-year equal-length mom are visible',()=>{
 const p=api.resolveComparisonPeriods(query({periodKind:'custom',from:'2024-02-29',to:'2024-03-01'}));assert.deepEqual([p[0].from,p[0].to,p[0].currentDays,p[0].baselineDays],['2023-02-28','2023-03-01',2,2]);
 const q=api.resolveComparisonPeriods(query({periodKind:'custom',from:'2026-01-01',to:'2026-01-02'}));assert.deepEqual([q[1].from,q[1].to],['2025-12-30','2025-12-31']);
 assert.throws(()=>query({periodKind:'custom',from:'2000-01-01',to:'2026-01-01'}));
});
test('structured unknown/versioned bucket filter survives query serialization',()=>{
 const q=query({bucket:JSON.stringify({dimension:'category',code:null,level:'minor',dictionaryVersion:null})});assert.deepEqual(q.bucket,{dimension:'category',code:null,level:'minor',dictionaryVersion:null});
 assert.deepEqual(api.normalizeStatisticsQuery({...q,bucket:JSON.stringify(q.bucket)},access,clock),q);assert.throws(()=>query({bucket:JSON.stringify({dimension:'category',code:'fee'})}));
});
test('coverage resource guards reject before fetching/truncating JSON and malformed geometry remains unknown',async()=>{
 const {readStatisticsCoverage,coverageVertexCount}=await import('../src/repositories/statisticsRepo');const {createCoveragePointMatcher}=await import('../src/services/locationValidationService');
 const ranges=[{from:'2026-09-01',to:'2026-09-30'}];const demands=[{enterpriseCode:'E1',businessType:'water',dates:['2026-09-10']}];let calls=0;
 const fake=(metadata:any[])=>({query:async()=>{calls++;return [metadata,[]];}});
 await assert.rejects(()=>readStatisticsCoverage(fake([]) as any,access as any,Array.from({length:201},(_,i)=>({...demands[0],enterpriseCode:'E'+i})),ranges),/超过200/);assert.equal(calls,0);
 await assert.rejects(()=>readStatisticsCoverage(fake(Array.from({length:1001},()=>({snapshot_bytes:1}))) as any,access as any,demands,ranges),/超过1000/);assert.equal(calls,1);
 await assert.rejects(()=>readStatisticsCoverage(fake([{snapshot_bytes:4*1024*1024+1}]) as any,access as any,demands,ranges),/超过4MiB/);assert.equal(calls,2);
 const siblingMetadata=Array.from({length:1000},(_,i)=>({grid_code:'G1',version:i+1,snapshot_bytes:1,valid_from:'2020-01-01',valid_to:null,population_enterprise:'E1',population_business:'water'}));
 await assert.rejects(()=>readStatisticsCoverage(fake(siblingMetadata) as any,access as any,[{...demands[0],dates:Array.from({length:2001},(_,i)=>api.addDays('2021-01-01',i))}],ranges),/最高覆盖版本日期选择超过2000000/);assert.equal(calls,3,'winner work is rejected before fetching JSON');
 const bad:any={coordinateSystem:'WGS84',geometrySources:['synthetic'],adminGridCodes:['A'],geometry:{features:[{geometry:null}]}};assert.equal(coverageVertexCount(bad),0);assert.equal(createCoveragePointMatcher(bad)([1,1]),false);
});
