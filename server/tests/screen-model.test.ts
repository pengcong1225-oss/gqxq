import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildScreen,compareGrids} from '../src/domain/screen';
const access:any={userId:'u',roles:['readonly'],scopeVersion:1,canReadSource:false,rules:[{kind:'restricted',enterpriseCodes:[],districtCodes:['A']}]};
const fact=(overrides:any={})=>({source_system:'宜接就办',source_id:'1',complaint_id:'C1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date('2026-11-02T00:00:00Z'),received_at:null,admin_grid_code:null,major_category_code:null,...overrides});
test('正式统计排除模拟、重复来源及越权，不拼接专题历史',()=>{
 const r=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact(),fact({complaint_id:'C2'}),fact({source_system:'DEMO-20261110',source_id:'2'}),fact({source_id:'3',district_code:'B'})],[],null);
 assert.equal(r.summary.total,1);assert.equal(r.quality.duplicates,1);assert.equal(r.summary.householdRate.value,null);assert.equal(r.layers.cim.state,'unconfigured');assert.equal(r.summary.unlocated,1);
});
test('模拟模式不读取真实记录并有明确标记',()=>{
 const r=buildScreen({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,[fact()],[],null);
 assert.equal(r.mode,'simulation');assert.equal(r.summary.total,0);
});
test('事件按账号范围与时间过滤，不能将未关联历史视为主账',()=>{
 const event={id:'e',mode:'real',kind:'shutdown',enterpriseId:'E',districtCode:'B',businessType:'water',startsAt:'2026-11-01T00:00:00+08:00',endsAt:'2026-11-08T00:00:00+08:00',gridIds:[]};
 const r=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact()],[event],null);
 assert.equal(r.events.length,0);assert.equal(r.details.length,1);assert.match(r.unavailable.history,/不纳入/);
});
import {simulatedSupportData} from '../src/domain/tenderSupportData';
test('模拟统计复用样本并计算评价、时长与季节研判',()=>{
 const all={...access,rules:[{kind:'all' as const}]};const data=simulatedSupportData('2026-11-10');
 const r=buildScreen({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},all,[],[],data);
 const demo=r.demonstration as any;assert.ok(r.summary.total>0);assert.ok(demo.evaluation.evaluatedCount>0);assert.equal(demo.duration.length,4);assert.equal(demo.seasons.length,2);assert.equal(demo.warnings.length,4);assert.equal(r.periods.month.count,r.summary.total);
});
test('未知时间与无来源主键的真实记录不伪造统计',()=>{
 const r=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact({source_id:null}),fact({source_id:'2',source_reported_at:null})],[],null);
 assert.equal(r.summary.total,0);assert.equal(r.quality.missingDate,1);assert.equal(r.quality.missingSourceKey,1);
});
test('网格比较按分类生成矩阵，并保留并列最高值',()=>{
 const result=compareGrids([{adminGridCode:'A',categoryCode:'x'},{adminGridCode:'B',categoryCode:'x'},{adminGridCode:'B',categoryCode:'y'}],['A','B']);
 assert.deepEqual(result.rows.find(r=>r.categoryCode==='x')?.values.map(v=>v.maximum),[true,true]);assert.deepEqual(result.rows.find(r=>r.categoryCode==='y')?.values.map(v=>v.count),[0,1]);
});
test('年度卡明细包含同快照内早于选择窗口的记录',()=>{
 const q={mode:'real' as const,from:'2026-11-01',to:'2026-11-10'};const r=buildScreen(q,access,[fact(),fact({complaint_id:'C2',source_id:'2',source_reported_at:new Date('2026-02-01T00:00:00Z')})],[],null);
 assert.equal(r.periods.year.count,2);assert.equal(r.periodDetails.year.length,2);assert.equal(r.details.length,1);
});
test('全局网格、小区和未分类筛选对总计与下钻同时生效',()=>{
 const q:any={mode:'real',from:'2026-11-01',to:'2026-11-10',adminGridCode:'G',communityCode:'C',categoryCode:'__missing__'};
 const r=buildScreen(q,access,[fact({admin_grid_code:'G',community_code:'C'}),fact({source_id:'2',admin_grid_code:'H',community_code:'C'})],[],null);
 assert.equal(r.summary.total,1);assert.equal(r.charts.category[0].code,'__missing__');assert.equal(r.details[0].categoryCode,'__missing__');
});
import {normalizeScreen} from '../src/domain/screenNormalize';
test('正式和模拟功能段使用相同状态封套',()=>{
 const a=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact()],[],null);
 const b=buildScreen({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,[],[],simulatedSupportData('2026-11-10'));
 const real=normalizeScreen(a,null,[]),sim=normalizeScreen(b,simulatedSupportData('2026-11-10'),[]);
 for(const key of ['supply','dynamic','top3','warnings','research','spatial'] as const){assert.deepEqual(Object.keys(real[key]).sort(),['data','reason','state']);assert.deepEqual(Object.keys(sim[key]).sort(),['data','reason','state']);}
});
import {screenHouseholdEvidence} from '../src/services/screenHouseholds';
test('期末有效户数按真实企业授权记录计算，区域筛选不借用全企业分母',async()=>{
 const db:any={query:async(sql:string)=>sql.includes('from enterprise where')?[[{enterprise_code:'E',district_code:'A'}]]:[[{households:20000,valid_from:'2026-01-01',valid_to:null,version:1}]]};
 const all:any={...access,rules:[{kind:'all'}]};const q:any={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:'candidate-calendar-v1'};
 const v=await screenHouseholdEvidence(db,q,all,['enterprise.read'],[{enterpriseCode:'E',count:4}],false,false);assert.equal(v[0].value,2);
 const restricted=await screenHouseholdEvidence(db,q,all,['enterprise.read'],[{enterpriseCode:'E',count:4}],false,true);assert.equal(restricted[0].value,null);
});
test('未知区划、企业、网格、小区均具有可下钻的稳定编码',()=>{
 const r=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},{...access,rules:[{kind:'all'}]},[fact({district_code:null,enterprise_code:null,admin_grid_code:null,community_code:null})],[],null);
 const detail=r.details[0];for(const key of ['districtCode','enterpriseCode','adminGridCode','communityCode','categoryCode'] as const)assert.equal(detail[key],'__missing__');
});
test('动态趋势只计算水气业务，未知行业仍保留在总量',()=>{
 const q:any={mode:'real',from:'2026-11-01',to:'2026-11-10'};const r=buildScreen(q,access,[fact(),fact({source_id:'2',business_type:'unknown'})],[],null);const normalized=normalizeScreen(r,null,[]);
 assert.equal(r.summary.total,2);assert.equal(normalized.dynamic.data.hourly.reduce((n,x)=>n+x.count,0),1);
});
test('无效来源时间回退接收时间，小时与总数一致',()=>{
 const r=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact({source_reported_at:'invalid',received_at:new Date('2026-11-02T03:00:00Z')})],[],null);
 assert.equal(r.summary.total,1);assert.equal(r.charts.hourly[11].count,1);assert.equal(r.dynamicCharts.hourly[11].count,1);
});
test('模拟行业与指定企业筛选不泄漏其他企业候选',()=>{
 const q:any={mode:'simulation',from:'2026-11-01',to:'2026-11-10',businessType:'gas',enterpriseCode:'SIM-gas-0'};
 const r=buildScreen(q,{...access,rules:[{kind:'all'}]},[],[],simulatedSupportData('2026-11-10'));
 assert.ok(r.demonstration.enterpriseRates.length>0);assert.ok(r.demonstration.enterpriseRates.every((x:any)=>x.id==='SIM-gas-0'));
});
