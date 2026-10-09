import {z} from 'zod';
import {AppError} from '../http/errors';
import type {AccessContext} from '../auth/accessScope';
import type {StatisticsQuery,ComparisonPeriod,PeriodKind} from '../types/statistics';
export const STATISTICS_POLICY=Object.freeze({id:'candidate-calendar-v1',version:1,status:'candidate' as const,label:'候选统计政策（待业务确认）'});
const DAY=86400000;
export const shanghaiToday=(clock:()=>Date=()=>new Date())=>clock().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export function normalizeShanghaiDay(value:string):string {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1000-01-01'||value>'9999-12-31')throw AppError.validation('日期须为有效 YYYY-MM-DD');
 const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.valueOf())||d.toISOString().slice(0,10)!==value)throw AppError.validation('日期无效');return value;
}
export function addDays(value:string,n:number):string{return new Date(new Date(value+'T00:00:00Z').valueOf()+n*DAY).toISOString().slice(0,10);}
export function dayCount(from:string,to:string):number{return (Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY+1;}
const code=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const bucket=z.object({dimension:z.enum(['business','category','enterprise','district','grid']),code:code.nullable(),level:z.enum(['major','minor']).optional(),dictionaryVersion:z.string().regex(/^[1-9]\d*$/).nullable().optional()}).strict().superRefine((b,c)=>{
 if(b.dimension==='category'&&(!b.level||b.dictionaryVersion===undefined))c.addIssue({code:'custom',message:'分类桶须提供级别及字典版本（未知须显式 null）'});
 if(b.dimension!=='category'&&(b.level!==undefined||b.dictionaryVersion!==undefined))c.addIssue({code:'custom',message:'非分类桶不能带分类属性'});
});
const schema=z.object({dataset:z.enum(['ledger','analysis']),projection:z.enum(['current','entry_snapshot']),periodKind:z.enum(['month','quarter','year','custom']),from:z.string(),to:z.string(),comparisonPolicyId:z.literal('candidate-calendar-v1'),businessType:code.optional(),majorCode:code.optional(),minorCode:code.optional(),enterpriseCode:code.optional(),districtCode:code.optional(),serviceGridCode:code.optional(),bucket:bucket.optional()}).strict();
function calendarBounds(from:string,kind:Exclude<PeriodKind,'custom'>,offset=0):{from:string;to:string}{
 const year=Number(from.slice(0,4)),month=Number(from.slice(5,7))-1;const months=kind==='year'?12:kind==='quarter'?3:1;
 const start=new Date(Date.UTC(year,kind==='year'?0:kind==='quarter'?Math.floor(month/3)*3:month,1));start.setUTCMonth(start.getUTCMonth()+offset*months);
 const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+months);end.setUTCDate(0);return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
}
export function normalizeStatisticsQuery(raw:Record<string,unknown>,_access:AccessContext,clock:()=>Date=()=>new Date()):StatisticsQuery {
 const input={...raw};if(typeof input.bucket==='string'){try{input.bucket=JSON.parse(input.bucket);}catch{throw AppError.validation('分桶筛选无效');}}
 const p=schema.safeParse(input);if(!p.success)throw AppError.validation('统计查询参数无效',p.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));
 const q=p.data;normalizeShanghaiDay(q.from);normalizeShanghaiDay(q.to);
 if(q.to<q.from||q.to>shanghaiToday(clock)||dayCount(q.from,q.to)>3660)throw AppError.validation('日期须正序、不晚于上海今日，最多3660日');
 if(q.dataset==='ledger'&&q.projection!=='current')throw AppError.validation('诉求总账仅支持当前有效视图');
 if(q.periodKind!=='custom'){const b=calendarBounds(q.from,q.periodKind);if(q.from!==b.from||q.to>b.to)throw AppError.validation('日历期间必须从期初开始，结束于本期间内的明确日期');}
 return q;
}
export function toShanghaiHalfOpenRange(q:{from:string;to:string}){return {start:new Date(q.from+'T00:00:00+08:00').toISOString(),end:new Date(addDays(q.to,1)+'T00:00:00+08:00').toISOString()};}
function previousYear(day:string){const year=Number(day.slice(0,4))-1;const prefix=String(year).padStart(4,'0')+day.slice(4);return day.slice(5)==='02-29'?String(year).padStart(4,'0')+'-02-28':prefix;}
export function resolveComparisonPeriods(q:StatisticsQuery):ComparisonPeriod[]{
 const currentDays=dayCount(q.from,q.to);
 return (['yoy','mom'] as const).map(kind=>{
  const label=kind==='yoy'?'同比':q.periodKind==='quarter'?'环比（上季度）':'环比';
  if(kind==='mom'&&q.periodKind==='year')return {kind,label,from:null,to:null,currentDays,baselineDays:null,truncated:false,reason:'年度环比未定义'};
  let from:string,to:string,truncated=false;
  if(q.periodKind==='custom'){
   from=kind==='yoy'?previousYear(q.from):addDays(q.from,-currentDays);to=kind==='yoy'?previousYear(q.to):addDays(q.from,-1);
  }else{
   const current=calendarBounds(q.from,q.periodKind);const b=kind==='yoy'?calendarBounds(previousYear(q.from),q.periodKind):calendarBounds(q.from,q.periodKind,-1);
   from=b.from;const requested=addDays(b.from,currentDays-1);to=q.to===current.to?b.to:requested>b.to?b.to:requested;truncated=q.to!==current.to&&requested>b.to;
  }
  return {kind,label,from,to,currentDays,baselineDays:dayCount(from,to),truncated,reason:null};
 });
}
export function computePeriodChange(current:number,baseline:number,partial=false):{changePercent:number|null;reason:string|null}{
 if(partial)return {changePercent:null,reason:'存在业务日期未知的记录，比较不完整'};
 if(baseline===0)return {changePercent:null,reason:'基期为零'};
 return {changePercent:Math.round((current-baseline)/baseline*10000)/100,reason:null};
}
