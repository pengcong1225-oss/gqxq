import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateTenderStatistics,tenderCaptureRange} from '../src/domain/tenderStatistics';
import {assertStatisticsPermission,type StatisticsCapture} from '../src/services/statisticsService';
import {captureTenderStatisticsIn,tenderCommunityPage} from '../src/services/tenderStatisticsService';
import type {SqlExecutor} from '../src/repositories/userRepo';
import type {AccessContext} from '../src/auth/accessScope';
import {matchRule,isAllowed} from '../src/auth/rolePolicy';
import type {StatisticsComplaint,StatisticsQuery} from '../src/types/statistics';
const query:StatisticsQuery={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:'candidate-calendar-v1'};
function row(id:string,businessType:string,day:string,time='2026-11-10T04:00:00.000Z'):StatisticsComplaint{return {id:Number(id),complaintId:id,complaintNo:id,title:null,businessType,complaintType:'complaint',majorCode:'pressure',minorCode:null,dictionaryVersion:'1',districtCode:'420502',districtName:'西陵区',enterpriseCode:'E1',enterpriseName:'企业一',longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null,adminGridCode:null,communityCode:null,sourceReportedAt:time,receivedAt:time,editVersion:1,enteredAt:null,analysisId:null,businessAt:time,businessDay:day,timeSource:'source_reported_at',timeReason:null,grids:[],locationReason:null,snapshotReason:null};}
function capture(rows:StatisticsComplaint[],q=query):StatisticsCapture{return {rows,summary:{query:q,total:rows.length,partial:false,dateFilterUnavailableCount:0,sourceTimeFallbackCount:0,dimensions:[{dimension:'category',code:'pressure',level:'major',dictionaryVersion:'1',name:'压力问题',count:rows.length}],rates:[],dataCutoffAt:'2026-11-10T05:00:00Z',comparisons:[]} as any} as StatisticsCapture;}
test('real authorized facts stay separated by business, calendar periods and selected detail scope',()=>{
 const selected=[row('1','water','2026-11-10'),row('2','gas','2026-11-09')];
 const historical=[...selected,row('3','water','2026-01-01'),row('4','water','2025-11-10'),row('5','water','2026-10-09'),row('6','lpg','2026-11-10')];
 const result=aggregateTenderStatistics(capture(selected),capture(historical),query.to);
 assert.equal(result.services.find(s=>s.businessType==='water')!.total,1);
 assert.equal(result.services.find(s=>s.businessType==='gas')!.periods.find(p=>p.key==='yesterday')!.total,1);
 const year=result.services[0].periods.find(p=>p.key==='year')!;
 assert.equal(year.total,3);assert.equal(year.comparisons.find(c=>c.kind==='yoy')!.baselineCount,1);
 assert.equal(year.comparisons.find(c=>c.kind==='mom')!.changePercent,200);
 assert.equal(result.services[0].categories[0].name,'压力问题');
 assert.equal(result.services[0].query.from,query.from);
 assert.equal(result.services[0].query.businessType,'water');
 assert.equal(result.dynamics.hours[12].water,1);
 assert.equal(result.dynamics.months.reduce((n,p)=>n+p.water+p.gas,0),2);
 assert.equal(result.dynamics.unavailable.length,3);
});
test('tender annual period-on-period is explicitly prior-year cumulative: 10 versus 8 is 25 percent',()=>{
 const current=Array.from({length:10},(_,i)=>row(String(i+1),'water','2026-11-10'));
 const prior=Array.from({length:8},(_,i)=>row(String(i+101),'water','2025-11-10'));
 const r=aggregateTenderStatistics(capture(current),capture([...current,...prior]),query.to);
 const annual=r.services[0].periods[0].comparisons.find(c=>c.kind==='mom')!;
 assert.equal(annual.baselineCount,8);assert.equal(annual.changePercent,25);
 assert.match(annual.label,/上年同期累计/);assert.match(annual.reason!,/年度环比按上年同期累计比较/);
});
test('only reliable community codes rank; date/time missing facts never become invented values',()=>{
 const rows=[row('1','water','2026-11-10'),row('2','water','2026-11-10')];
 rows[0].communityCode='C1';rows[1].businessAt=null;
 const r=aggregateTenderStatistics(capture(rows),capture(rows),query.to);
 assert.equal(r.services[0].communities.length,1);assert.equal(r.services[0].communities[0].count,1);
 assert.equal(r.services[0].communityUnavailableCount,1);
 assert.equal(r.dynamics.hours.reduce((n,p)=>n+p.water,0),1);
 assert.equal(r.dynamics.missingTimeCount,1);
 assert.equal(r.dynamics.unavailable.some(m=>m.key==='duration'),true);
});
test('business filter is retained in cards and all detail queries; empty selected range does not acquire old records',()=>{
 const q={...query,businessType:'water'};const selected=capture([],q),extended=capture([row('1','water','2026-01-01')],q);
 const r=aggregateTenderStatistics(selected,extended,query.to);
 assert.equal(r.services[0].total,0);assert.equal(r.services.length,1);
 assert.equal(r.services[0].periods[0].total,1);
 assert.equal(r.services[0].periods[0].query.businessType,'water');
 assert.equal(r.dynamics.months.every(m=>m.water===0&&m.gas===0),true);
});
test('overall calendar periods retain authorized lpg facts while incompatible service sections are omitted',()=>{
 const q={...query,businessType:'lpg'},rows=[row('1','lpg','2026-11-10')];
 const result=aggregateTenderStatistics(capture(rows,q),capture(rows,q),query.to);
 assert.equal(result.total,1);assert.equal(result.periods[0].total,1);assert.equal(result.services.length,0);
 assert.equal(result.periods[0].query.businessType,'lpg');
});
test('capture extension includes prior year and prior quarter without future or query mutation',()=>{
 const q={...query,from:'2020-01-01'};const range=tenderCaptureRange(q);
 assert.equal(range.from,'2020-01-01');assert.equal(range.to,query.to);
 assert.equal(q.from,'2020-01-01');
 const early={...query,from:'2026-01-01',to:'2026-01-02'};
 assert.equal(tenderCaptureRange(early).from,'2025-01-01');
 assert.equal(tenderCaptureRange({...early,to:'2026-01-01'}).from,'2024-12-31');
});
test('new read endpoints are registered with exact capabilities and default deny remains active',()=>{
 for(const path of ['/statistics/tender','/statistics/tender/community-complaints']){
  assert.equal(matchRule('GET',path)?.permissionCode,'statistics.read');
  assert.equal(isAllowed({id:'u',username:'u',roles:['readonly'],permissionCodes:[]},'GET',path).allowed,false);
 }
 for(const path of ['/heatmap/administrative-data','/heatmap/administrative-complaints'])assert.equal(matchRule('GET',path)?.permissionCode,'heatmap.read');
 assert.equal(matchRule('POST','/statistics/tender'),null);
});
test('new statistics uses existing dataset and detail permissions instead of bypassing access',()=>{
 assert.throws(()=>assertStatisticsPermission(query,['dashboard.read']),/权限|Forbidden|forbidden/i);
 assert.throws(()=>assertStatisticsPermission({...query,dataset:'analysis'},['statistics.read','dashboard.read']));
 assert.throws(()=>assertStatisticsPermission(query,['statistics.read','dashboard.read'],true));
 assert.doesNotThrow(()=>assertStatisticsPermission(query,['statistics.read','dashboard.read']));
});
test('community details match the exact persisted code and preserve selected date/business scope',()=>{
 const rows=[row('1','water','2026-11-10'),row('2','water','2026-11-10'),row('3','gas','2026-11-10')];
 rows[0].communityCode='C1';rows[1].communityCode='C10';rows[2].communityCode='C1';
 const result=tenderCommunityPage(capture(rows.filter(r=>r.businessType==='water'),{...query,businessType:'water'}),'C1',1,10);
 assert.equal(result.total,1);assert.equal(result.content[0].complaintId,'1');assert.equal(result.query.businessType,'water');
 assert.equal(tenderCommunityPage(capture(rows),'unknown',1,10).total,0);
});
test('demo counts are explicit and a type absent this year retains the real prior-year baseline',()=>{
 const a=row('DEMO-20261110-1','gas','2026-11-10'),b=row('2','gas','2025-11-10');b.majorCode='old';
 const result=aggregateTenderStatistics(capture([a]),capture([a,b]),query.to);
 assert.equal(result.demoCount,1);assert.equal(result.extendedDemoCount,1);
 const gas=result.services.find(s=>s.businessType==='gas')!;
 assert.equal(gas.periods[0].demoCount,1);
 const old=gas.periods[0].types.find(t=>t.bucket.code==='old')!;
 assert.equal(old.count,0);assert.equal(old.comparisons.find(c=>c.kind==='yoy')!.baselineCount,1);
 assert.equal(old.comparisons.find(c=>c.kind==='yoy')!.changePercent,-100);
});
test('service captures only selected and extended windows under the same authorized scope',async()=>{
 const access:AccessContext={userId:'u1',roles:['readonly'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false};
 const calls:{sql:string;values:unknown[]}[]=[];
 const db:SqlExecutor={query:async(sql,values=[])=>{
  calls.push({sql,values});
  if(!sql.includes(' from complaint c'))return [[],[]];
  return [[{id:1,complaint_id:'1',complaint_no:'C1',business_type:'water',complaint_type:'complaint',enterprise_code:'E1',source_reported_at:new Date('2026-11-10T04:00:00Z'),received_at:new Date('2026-11-10T04:00:00Z'),edit_version:1}],[]];
 }};
 await assert.rejects(()=>captureTenderStatisticsIn(db,query,access,['dashboard.read']));assert.equal(calls.length,0);
 const result=await captureTenderStatisticsIn(db,query,access,['statistics.read','dashboard.read']);
 const captures=calls.filter(c=>c.sql.includes(' from complaint c'));
 assert.equal(captures.length,2);
 for(const {sql,values} of captures){
  assert.match(sql,/c\.enterprise_code in \(\?\)/);
  assert.match(sql,/c\.source_reported_at >= \? and c\.source_reported_at < \?/);
  assert.equal(values.length,(sql.match(/\?/g)??[]).length);
 }
 assert.deepEqual(captures.map(({values})=>values),[
  ['E1',new Date('2026-10-31T16:00:00Z'),new Date('2026-11-10T16:00:00Z')],
  ['E1',new Date('2024-12-31T16:00:00Z'),new Date('2026-11-10T16:00:00Z')],
 ]);
 assert.equal(result.services[0].total,1);assert.equal(result.services[1].total,0);
 assert.equal(result.services[0].enterpriseRates[0].value,null);
 assert.match(result.services[0].enterpriseRates[0].reason!,/权限/);
});
