import type {StatisticsCapture} from '../services/statisticsService';
import type {StatisticsComplaint,StatisticsQuery,DimensionBucket,PeriodComparison} from '../types/statistics';
import type {TenderPeriod,TenderStatisticsResult,TenderServiceStatistics,TenderSeriesPoint} from '../types/tenderStatistics';
import {addDays,resolveComparisonPeriods,computePeriodChange} from './statisticsQuery';
const shanghaiHour=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'});

/** The extended capture uses the same authorization and projection, never raw source JSON. */
export function tenderCaptureRange(q:StatisticsQuery):{from:string;to:string}{
 const priorYear=String(Number(q.to.slice(0,4))-1).padStart(4,'0')+'-01-01';
 const yesterday=addDays(q.to,-1),yesterdayPriorYear=String(Number(yesterday.slice(0,4))-1).padStart(4,'0')+yesterday.slice(4);
 const earliest=priorYear<yesterdayPriorYear?priorYear:yesterdayPriorYear;
 return {from:q.from<earliest?q.from:earliest,to:q.to};
}
const inRange=(rows:StatisticsComplaint[],from:string,to:string)=>rows.filter(r=>r.businessDay!==null&&r.businessDay>=from&&r.businessDay<=to);
const categoryKey=(r:{majorCode:string|null;dictionaryVersion:string|null})=>JSON.stringify([r.majorCode,r.dictionaryVersion]);
const bucketKey=(r:DimensionBucket)=>JSON.stringify([r.code,r.dictionaryVersion??null]);
function group(rows:StatisticsComplaint[],dimension:'category'|'district',names:Map<string,string>):DimensionBucket[]{
 const buckets=new Map<string,DimensionBucket>();
 for(const r of rows){
  const code=dimension==='category'?r.majorCode:r.districtCode,key=dimension==='category'?categoryKey(r):String(code);
  const b=buckets.get(key)??{dimension,code,name:dimension==='category'?names.get(key)??(code?'分类 '+code:'待分类'):r.districtName??code??'区划未知',count:0,...(dimension==='category'?{level:'major' as const,dictionaryVersion:r.dictionaryVersion}:{})};
  b.count++;buckets.set(key,b);
 }
 return [...buckets.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}
function monthKeys(from:string,to:string):string[]{
 const result:string[]=[];let month=from.slice(0,7);
 while(month<=to.slice(0,7)){result.push(month);const d=new Date(month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,7);}
 return result;
}
function monthlyQuery(q:StatisticsQuery,month:string):StatisticsQuery{
 const d=new Date(month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(0);
 return {...q,periodKind:'custom',from:month+'-01'<q.from?q.from:month+'-01',to:d.toISOString().slice(0,10)>q.to?q.to:d.toISOString().slice(0,10)};
}
function periodQueries(q:StatisticsQuery,anchor:string):{key:TenderPeriod['key'];label:string;query:StatisticsQuery}[]{
 const month=Number(anchor.slice(5,7)),year=anchor.slice(0,4);
 return [
  {key:'year',label:'年度诉求量',query:{...q,periodKind:'year',from:year+'-01-01',to:anchor}},
  {key:'quarter',label:'本季度诉求量',query:{...q,periodKind:'quarter',from:year+'-'+String(Math.floor((month-1)/3)*3+1).padStart(2,'0')+'-01',to:anchor}},
  {key:'month',label:'本月诉求量',query:{...q,periodKind:'month',from:anchor.slice(0,7)+'-01',to:anchor}},
  {key:'yesterday',label:'昨日诉求量',query:{...q,periodKind:'custom',from:addDays(anchor,-1),to:addDays(anchor,-1)}}
 ];
}
function compare(rows:StatisticsComplaint[],q:StatisticsQuery,current:number,partial:boolean,predicate?:(r:StatisticsComplaint)=>boolean):PeriodComparison[]{
 return resolveComparisonPeriods(q,{annualMom:true}).map(p=>{
  if(!p.from||!p.to)return {...p,currentCount:current,baselineCount:null,changePercent:null};
  const baseline=inRange(rows,p.from,p.to).filter(r=>!predicate||predicate(r)).length;
  const change=computePeriodChange(current,baseline,partial);
  return {...p,currentCount:current,baselineCount:baseline,...change,reason:change.reason??p.reason};
 });
}
function aggregatePeriods(q:StatisticsQuery,all:StatisticsComplaint[],anchorDate:string,names:Map<string,string>,partial:boolean):TenderPeriod[]{
 return periodQueries(q,anchorDate).map(p=>{
  const current=inRange(all,p.query.from,p.query.to),comparisons=compare(all,p.query,current.length,partial);
  const comparisonRows=comparisons.flatMap(c=>c.from&&c.to?inRange(all,c.from,c.to):[]);
  const types=group([...current,...comparisonRows],'category',names).map(b=>{
   const count=current.filter(r=>categoryKey(r)===bucketKey(b)).length,bucket={...b,count};
   return {bucket,count,comparisons:compare(all,p.query,count,partial,r=>categoryKey(r)===bucketKey(bucket))};
  });
  return {...p,total:current.length,demoCount:current.filter(r=>r.complaintId.startsWith('DEMO-20261110')).length,comparisons,types};
 });
}
/** Pure and reusable by fixed reports. Caller must supply ONLY already-authorized capture facts. */
export function aggregateTenderStatistics(selected:StatisticsCapture,extended:StatisticsCapture,anchorDate=selected.summary.query.to,communityNames:ReadonlyMap<string,string>=new Map()):TenderStatisticsResult {
 const q=selected.summary.query,names=new Map<string,string>();
 for(const d of [...extended.summary.dimensions,...selected.summary.dimensions])if(d.dimension==='category'&&d.level==='major')names.set(bucketKey(d),d.name);
 const partial=selected.summary.partial||extended.summary.partial;
 const services:TenderServiceStatistics[]=(['water','gas'] as const).filter(b=>!q.businessType||q.businessType===b).map(businessType=>{
  const serviceQuery={...q,businessType},rows=selected.rows.filter(r=>r.businessType===businessType),all=extended.rows.filter(r=>r.businessType===businessType);
  const periods=aggregatePeriods(serviceQuery,all,anchorDate,names,extended.summary.partial);
  const enterprise=new Map<string,{count:number;name:string}>();
  for(const r of rows)if(r.enterpriseCode){const e=enterprise.get(r.enterpriseCode)??{count:0,name:r.enterpriseName??r.enterpriseCode};e.count++;enterprise.set(r.enterpriseCode,e);}
  const community=new Map<string,number>();for(const r of rows)if(r.communityCode)community.set(r.communityCode,1+(community.get(r.communityCode)??0));
  return {businessType,title:businessType==='water'?'供水服务':'供气服务',query:serviceQuery,total:rows.length,periods,categories:group(rows,'category',names),districts:group(rows,'district',names),
   enterpriseRates:selected.summary.rates.filter(r=>enterprise.has(r.enterpriseCode)).map(r=>({...r,...enterprise.get(r.enterpriseCode)!,value:r.reason||r.households===null||r.households===0?null:enterprise.get(r.enterpriseCode)!.count/r.households*10000})),
   months:monthKeys(q.from,q.to).map(key=>({key,count:rows.filter(r=>r.businessDay?.startsWith(key)).length,query:monthlyQuery(serviceQuery,key)})),
   communities:[...community].map(([code,count])=>({code,name:communityNames.get(code)??code,count})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)).slice(0,10),communityUnavailableCount:rows.filter(r=>!r.communityCode).length,sourceTimeFallbackCount:rows.filter(r=>r.timeSource==='received_fallback').length};
 });
 const points=(keys:string[],labels=keys):TenderSeriesPoint[]=>keys.map((key,i)=>({key,label:labels[i],water:0,gas:0}));
 const hours=points(Array.from({length:24},(_,i)=>String(i)),Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00'));
 const months=points(monthKeys(q.from,q.to)),weekdays=points(['1','2','3','4','5','6','0'],['周一','周二','周三','周四','周五','周六','周日']);
 let missingTimeCount=0;
 for(const row of selected.rows){
  if(row.businessType!=='water'&&row.businessType!=='gas')continue;const business=row.businessType;
  const m=months.find(p=>p.key===row.businessDay?.slice(0,7));if(m)m[business]++;
  if(row.businessDay){const weekday=new Date(row.businessDay+'T00:00:00Z').getUTCDay();const w=weekdays.find(p=>p.key===String(weekday));if(w)w[business]++;}
  if(!row.businessAt||!Number.isFinite(Date.parse(row.businessAt))){missingTimeCount++;continue;}
  const hour=Number(shanghaiHour.format(new Date(row.businessAt)));
  if(hours[hour])hours[hour][business]++;else missingTimeCount++;
 }
 return {satisfactionRate:selected.summary.satisfactionRate,timeBasis:selected.summary.timeBasis,policy:selected.summary.policy,excludedByReason:selected.summary.excludedByReason,query:q,anchorDate,dataCutoffAt:selected.summary.dataCutoffAt,total:selected.summary.total,periods:aggregatePeriods(q,extended.rows,anchorDate,names,extended.summary.partial),services,partial,dateFilterUnavailableCount:Math.max(selected.summary.dateFilterUnavailableCount,extended.summary.dateFilterUnavailableCount),sourceTimeFallbackCount:selected.summary.sourceTimeFallbackCount,demoCount:selected.rows.filter(r=>r.complaintId.startsWith('DEMO-20261110')).length,extendedDemoCount:extended.rows.filter(r=>r.complaintId.startsWith('DEMO-20261110')).length,
  dynamics:{hours,months,weekdays,missingTimeCount,unavailable:[
   ...(selected.summary.satisfactionRate?.policyId?[]:[{key:'satisfaction',title:'满意与不满意诉求占比',reason:'尚未提供经确认的有效评价及来源优先依据，不能将未评价视为不满意。'}]),
   {key:'dissatisfactionBusiness',title:'供水供气不满意诉求占比',reason:'需先确认有效不满意评价样本，再按供水、供气分别计算。'},
   {key:'duration',title:'24 / 48 / 72 / 超过72小时处理统计',reason:'统计事实未提供有效实际办理完成时间；平台闭环时间不能代替来源办理时长，亦无法计算各时长组满意度。'}
  ]}};
}
