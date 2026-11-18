import {AppError} from '../http/errors';
import {normalizeShanghaiDay} from './statisticsQuery';
interface CategoryRow {complaintId:string;majorCode:string|null;minorCode?:string|null;dictionaryVersion:string|null}
interface GridRow extends CategoryRow {adminGridCode:string|null}
const unique=<T extends {complaintId:string}>(rows:T[])=>[...new Map(rows.map(r=>[r.complaintId,r])).values()];
/** 分类口径：major=大类（gas_service/water_service），minor=诉求小类（g01…/w01…，缺失回退大类） */
export type CategoryLevel='major'|'minor';
const categoryCodeOf=(r:CategoryRow,level:CategoryLevel):string|null=>(level==='minor'?(r.minorCode??r.majorCode):r.majorCode)??null;
export function topCategories(rows:CategoryRow[],limit:number,level:CategoryLevel='major'){const buckets=new Map<string,{code:string;dictionaryVersion:string;count:number}>();for(const r of unique(rows)){const code=categoryCodeOf(r,level);if(!code||!r.dictionaryVersion)continue;const key=JSON.stringify([code,r.dictionaryVersion]),b=buckets.get(key)??{code,dictionaryVersion:r.dictionaryVersion,count:0};b.count++;buckets.set(key,b);}return [...buckets.values()].sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)||a.dictionaryVersion.localeCompare(b.dictionaryVersion)).slice(0,limit);}
export function compareAdminGrids(codes:string[],input:GridRow[],level:CategoryLevel='major'){
  if(codes.length<2||codes.length>3||new Set(codes).size!==codes.length)throw AppError.validation('请选择2至3个不同的行政网格');
  if(level!=='major'&&level!=='minor')throw AppError.validation('分类层级无效');
  const rows=unique(input);
  const totals=Object.fromEntries(codes.map(c=>[c,rows.filter(r=>r.adminGridCode===c).length]));
  const selected=rows.filter(r=>r.adminGridCode!==null&&codes.includes(r.adminGridCode));
  // 标书 1.2.8「按诉求类型对比」：minor = 19 个小类（g01…/w01…），major 仅两个大类，保留兼容
  const categories=topCategories(selected,10000,level).map(b=>{const counts=Object.fromEntries(codes.map(c=>[c,selected.filter(r=>r.adminGridCode===c&&categoryCodeOf(r,level)===b.code&&r.dictionaryVersion===b.dictionaryVersion).length]));const max=Math.max(...Object.values(counts));return {...b,counts,highest:codes.filter(c=>counts[c]===max)};});
  return {totals,categories,unlocatedCount:rows.filter(r=>!r.adminGridCode).length,categoryLevel:level};
}
export function samePeriodYear(day:string,year:number){normalizeShanghaiDay(day);if(year<1000||year>9999)throw AppError.validation('年份无效');const value=String(year)+day.slice(4);if(day.slice(5)==='02-29'&&new Date(value+'T00:00:00Z').getUTCMonth()!==1)return year+'-02-28';return value;}
export function seasonRange(year:number,startMonth:number,endMonth:number){if(!Number.isInteger(year)||year<1001||year>9998||![startMonth,endMonth].every(m=>Number.isInteger(m)&&m>=1&&m<=12))throw AppError.validation('保障季年份或月份无效');const endYear=endMonth<startMonth?year+1:year;return {from:`${year}-${String(startMonth).padStart(2,'0')}-01`,to:new Date(Date.UTC(endYear,endMonth,0)).toISOString().slice(0,10)};}
