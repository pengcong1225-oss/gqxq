import test from 'node:test';
import assert from 'node:assert/strict';
import {ALERT_MULTIPLIER_SUGGESTIONS,alertSeasonMonths,computeAlertBaseline,expectedAlertThreshold,freezeBusinessRuleBaseline,isValidAlertMultiplier,normalizeBaselineMonths} from '../src/domain/alertBaseline';
import {alertBaselineRange,parseAlertBaselineQuery,parseBusinessRule,publishedRules} from '../src/services/businessRuleService';
import {shanghaiToday} from '../src/domain/statisticsQuery';
import {matchRule} from '../src/auth/rolePolicy';
import type {Tx} from '../src/db/tx';

const days=(from:string,to:string)=>{const list:string[]=[];for(let t=Date.parse(from+'T00:00:00Z');t<=Date.parse(to+'T00:00:00Z');t+=86400000)list.push(new Date(t).toISOString().slice(0,10));return list;};
const hasFieldError=(fn:()=>unknown,message:string)=>{try{fn();return false;}catch(error){const fields=(error as {fieldErrors?:{field:string;message:string}[]}).fieldErrors;return Array.isArray(fields)&&fields.some(item=>item.message===message);}};
const ruleContent={ruleId:'gas-rule',kind:'alert' as const,expectedVersion:0,name:'正式燃气分类预警',businessType:'gas' as const,dictionaryVersion:'1',majorCodes:['pressure'],minorCodes:[] as string[],effectiveFrom:'2020-01-01',effectiveTo:'2030-12-31',scene:'gas_three_piece' as const,startMonth:null,endMonth:null,threshold:133,windowDays:7,definitionBasis:'已确认安装分类定义',definitionConfirmed:true,enabled:true};
const baseline={avgPerDay:12.6286,windowBase:88.4,baseDays:730,daysFrom:'2024-11-19',daysTo:'2026-11-17'};

test('baseline averages over calendar days and only counts in-season months for seasonal scenes',()=>{
 const counts=new Map<string,number>([['2025-01-05',1],['2025-01-06',2],['2025-02-01',0],['2025-07-01',99],['2025-12-01',3]]);
 const sample=['2025-01-05','2025-01-06','2025-02-01','2025-07-01','2025-12-01'];
 const winter=computeAlertBaseline({dailyCounts:counts,days:sample,windowDays:7,months:[11,12,1,2,3]});
 assert.deepEqual(winter,{avgPerDay:1.5,windowBase:10.5,baseDays:4,daysFrom:'2025-01-05',daysTo:'2025-12-01'});
 const allYear=computeAlertBaseline({dailyCounts:counts,days:sample,windowDays:7});
 assert.equal(allYear.baseDays,5);assert.equal(allYear.avgPerDay,21);assert.equal(allYear.daysFrom,'2025-01-05');assert.equal(allYear.daysTo,'2025-12-01');
 // 无数据日按 0 件，不因缺记录而抬高日均
 const sparse=computeAlertBaseline({dailyCounts:new Map([['2025-01-05',2]]),days:['2025-01-05','2025-01-06','2025-01-07'],windowDays:3});
 assert.deepEqual(sparse,{avgPerDay:0.6667,windowBase:2,baseDays:3,daysFrom:'2025-01-05',daysTo:'2025-01-07'});
});

test('zero data and empty/duplicate/unsorted date sets are deterministic',()=>{
 const empty=computeAlertBaseline({dailyCounts:new Map(),days:['2026-01-01','2026-01-02'],windowDays:7});
 assert.deepEqual(empty,{avgPerDay:0,windowBase:0,baseDays:2,daysFrom:'2026-01-01',daysTo:'2026-01-02'});
 assert.equal(expectedAlertThreshold(empty.windowBase,1.5),0);
 const boundary=computeAlertBaseline({dailyCounts:new Map([['2026-01-02',4],['2025-12-31',99]]),days:['2026-01-02','2026-01-01','2026-01-02'],windowDays:1});
 assert.deepEqual(boundary,{avgPerDay:2,windowBase:2,baseDays:2,daysFrom:'2026-01-01',daysTo:'2026-01-02'});
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:[],windowDays:7}),/基线日期集为空/);
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:['2026-13-01'],windowDays:7}),/基线日期无效/);
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:['2026/01/01'],windowDays:7}),/YYYY-MM-DD/);
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:['2026-01-01'],windowDays:0}),/窗口天数/);
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:['2026-01-01'],windowDays:367}),/窗口天数/);
 assert.throws(()=>computeAlertBaseline({dailyCounts:new Map(),days:['2026-01-01'],windowDays:7,months:[7]}),/保障季基线日期集为空/);
});

test('threshold is ceil(windowBase × multiplier) with binary-float tolerance',()=>{
 assert.equal(expectedAlertThreshold(10,1.5),15);
 assert.equal(expectedAlertThreshold(88.4,1.5),133);
 assert.equal(expectedAlertThreshold(88.8,1.5),134);
 assert.equal(expectedAlertThreshold(3.3333,3),10);
 assert.equal(expectedAlertThreshold(20,1),20);
 assert.equal(expectedAlertThreshold(0,5),0);
 assert.equal(expectedAlertThreshold(13.333333,1.5),20);
 for(const invalid of [0.99,5.01,1.234,Number.NaN,Number.POSITIVE_INFINITY])assert.equal(isValidAlertMultiplier(invalid),false);
 for(const valid of [1,1.5,2.25,5])assert.equal(isValidAlertMultiplier(valid),true);
 assert.throws(()=>expectedAlertThreshold(10,1.234),/倍数/);
 assert.deepEqual([...ALERT_MULTIPLIER_SUGGESTIONS],[1,1.1,1.2,1.5,2]);
});

test('season months wrap across year boundary and normalize deterministically',()=>{
 assert.deepEqual(alertSeasonMonths(11,3),[11,12,1,2,3]);
 assert.deepEqual(alertSeasonMonths(6,9),[6,7,8,9]);
 assert.deepEqual(alertSeasonMonths(12,12),[12]);
 assert.throws(()=>alertSeasonMonths(0,3),/月份无效/);assert.throws(()=>alertSeasonMonths(1,13),/月份无效/);
 assert.deepEqual(normalizeBaselineMonths([2,1,2]),[1,2]);
 assert.equal(normalizeBaselineMonths(null),null);assert.equal(normalizeBaselineMonths([]),null);
});

test('saving freezes the server baseline and rejects a threshold that is not ceil(base×multiplier)',()=>{
 const rule={kind:'alert',multiplier:1.5,threshold:133};
 const frozen=freezeBusinessRuleBaseline(rule,baseline);
 assert.equal(frozen.baseline?.windowBase,88.4);assert.equal(frozen.threshold,133);
 assert.throws(()=>freezeBusinessRuleBaseline({kind:'alert',multiplier:1.5,threshold:134},baseline),/请先重算基线/);
 assert.throws(()=>freezeBusinessRuleBaseline({kind:'alert',multiplier:1.5,threshold:132},baseline),/请先重算基线/);
 assert.throws(()=>freezeBusinessRuleBaseline({kind:'alert',multiplier:2,threshold:null},baseline),/请先重算基线/);
 assert.throws(()=>freezeBusinessRuleBaseline({kind:'alert',multiplier:1.5,threshold:133},null),/缺少基线快照/);
 // 历史规则（无倍数）不写基线；保障季规则不允许倍数
 assert.deepEqual(freezeBusinessRuleBaseline({kind:'alert',multiplier:null,threshold:133},baseline),{kind:'alert',multiplier:null,threshold:133,baseline:null});
 assert.deepEqual(freezeBusinessRuleBaseline({kind:'seasonal',multiplier:1.5,threshold:null},baseline).baseline,null);
 assert.equal(freezeBusinessRuleBaseline({kind:'alert',multiplier:2,threshold:177},baseline).baseline?.windowBase,88.4);
});

test('rule schema accepts multiplier 1.00–5.00 with two decimals and keeps legacy rules valid',()=>{
 const parsed=parseBusinessRule({...ruleContent,multiplier:1.5,baseline});
 assert.equal(parsed.multiplier,1.5);assert.equal(parsed.baseline?.windowBase,88.4);
 const legacy=parseBusinessRule(ruleContent);assert.equal(legacy.multiplier,null);assert.equal(legacy.baseline,null);
 assert.equal(parseBusinessRule({...ruleContent,multiplier:1.25}).multiplier,1.25);
 for(const invalid of [0.99,5.01,1.234,-1,6])assert.throws(()=>parseBusinessRule({...ruleContent,multiplier:invalid}));
 assert.ok(hasFieldError(()=>parseBusinessRule({...ruleContent,multiplier:1.5,baseline:{...baseline,daysFrom:'2026-11-17',daysTo:'2024-11-19'}}),'基线日期区间无效'));
 assert.ok(hasFieldError(()=>parseBusinessRule({...ruleContent,multiplier:null,baseline}),'配置基线必须同时配置倍数'));
 assert.ok(hasFieldError(()=>parseBusinessRule({...ruleContent,kind:'seasonal',multiplier:1.5,startMonth:11,endMonth:3,threshold:null,windowDays:null}),'仅预警规则可配置倍数与基线'));
});

test('baseline preview query is strict and normalizes optional fields',()=>{
 const parsed=parseAlertBaselineQuery({businessType:'gas',minorCodes:['g01','g02'],windowDays:7});
 assert.deepEqual(parsed,{businessType:'gas',minorCodes:['g01','g02'],majorCodes:[],dictionaryVersion:null,windowDays:7,scene:null,from:null,to:null});
 assert.equal(parseAlertBaselineQuery({businessType:'water',minorCodes:[],majorCodes:['w'],windowDays:3,dictionaryVersion:'20',scene:'winter',from:'2025-01-01',to:'2025-12-31'}).dictionaryVersion,'20');
 assert.throws(()=>parseAlertBaselineQuery({businessType:'electric',minorCodes:['g01'],windowDays:7}),/基线参数无效/);
 assert.throws(()=>parseAlertBaselineQuery({businessType:'gas',windowDays:7}),/基线参数无效/);
 assert.ok(hasFieldError(()=>parseAlertBaselineQuery({businessType:'gas',minorCodes:[],windowDays:7}),'须选择正式分类'));
 assert.throws(()=>parseAlertBaselineQuery({businessType:'gas',minorCodes:['g01'],windowDays:0}),/基线参数无效/);
 assert.throws(()=>parseAlertBaselineQuery({businessType:'gas',minorCodes:['g01'],windowDays:7,extra:1}),/基线参数无效/);
 assert.ok(hasFieldError(()=>parseAlertBaselineQuery({businessType:'gas',minorCodes:['g01'],windowDays:7,from:'2026-01-02',to:'2026-01-01'}),'基线起始日期不能晚于截止日期'));
});

test('baseline range defaults to the last two years ending today and rejects future endpoints',()=>{
 const today=shanghaiToday();
 const range=alertBaselineRange();
 assert.equal(range.to,today);assert.equal(range.from,new Date(Date.parse(today+'T00:00:00Z')-729*86400000).toISOString().slice(0,10));
 assert.deepEqual(alertBaselineRange('2025-01-01','2025-12-31'),{from:'2025-01-01',to:'2025-12-31'});
 assert.throws(()=>alertBaselineRange('2026-01-01','2999-01-01'),/不能晚于今天/);
 assert.throws(()=>alertBaselineRange('2026-01-02','2026-01-01'),/起始日期不能晚于截止日期/);
 assert.throws(()=>alertBaselineRange('1990-01-01','2026-01-01'),/不得超过 4000 天/);
});

test('published rules without multiplier/baseline still decode and route policy registers the preview endpoint',async()=>{
 const db={query:async()=>[[{content:JSON.stringify(ruleContent),version:4}],[]]} as unknown as Pick<Tx,'query'>;
 const [rule]=await publishedRules(db,'alert');
 assert.equal(rule.multiplier,null);assert.equal(rule.baseline,null);
 const dbNew={query:async()=>[[{content:JSON.stringify({...ruleContent,multiplier:1.5,baseline}),version:5}],[]]} as unknown as Pick<Tx,'query'>;
 const [current]=await publishedRules(dbNew,'alert');
 assert.equal(current.multiplier,1.5);assert.equal(current.baseline?.baseDays,730);
 assert.equal(matchRule('POST','/business-rules/baseline')?.permissionCode,'business.rules.manage');
 assert.equal(matchRule('POST','/business-rules/baseline')?.roles.includes('admin'),true);
 assert.equal(matchRule('GET','/business-rules/baseline'),null);
 assert.equal(matchRule('POST','/business-rules/R/publish')?.permissionCode,'business.rules.manage');
});
