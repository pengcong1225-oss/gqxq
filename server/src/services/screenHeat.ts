import {evaluateHeat,TENDER_HEAT_POLICY,TENDER_HEAT_POLICY_ID} from '../domain/heatRule';
import {SIMULATED_HEAT_COEFFICIENTS} from '../domain/simulatedYichangGrid';
import {dayCount} from '../domain/statisticsQuery';
import type {buildScreen} from '../domain/screen';
import type {TenderDataset} from '../types/tenderSupport';
import type {ScreenSection,ScreenHeat,ScreenHeatRuleRef} from '../types/screen';
import {pool} from '../db/pool';
import {rowsIn} from '../repositories/serviceGridRepo';
import {heatJson} from '../repositories/heatRuleRepo';
/** 可注入的已发布热力规则读取器：默认走只读 SQL，单测可注入假数据源覆盖分支。 */
export type PublishedHeatRuleReader=(to:string)=>Promise<ScreenHeatRuleRef[]>;
const shanghaiDay=(v:unknown)=>v instanceof Date?v.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):String(v??'').slice(0,10);
/**
 * 正式模式读取已发布热力规则（只读）：按查询结束日对每个分类取最近一条生效版本
 * （heat_rule_published.effective_from<=to），并核对 heat_policy_version 是否有对应政策版本。
 * 读不到任何规则即返回空数组，不伪造系数/几何。
 */
async function readPublishedHeatRules(to:string):Promise<ScreenHeatRuleRef[]>{
 const published=await rowsIn(pool,'select category_key,version_id,effective_from,content from heat_rule_published where effective_from<=? order by category_key,effective_from desc',[to]);
 const policies=await rowsIn(pool,'select policy_id,policy_version from heat_policy_version');
 const policyKeys=new Set(policies.map(r=>String(r.policy_id)+'|'+String(r.policy_version)));
 const seen=new Set<string>();const rules:ScreenHeatRuleRef[]=[];
 for(const row of published){
  const categoryKey=String(row.category_key);if(seen.has(categoryKey))continue;seen.add(categoryKey);
  let content:any=null;try{content=heatJson<any>(row.content);}catch{content=null;}
  const rule=content?.rule??{};
  const policyId=typeof rule.policyId==='string'?rule.policyId:null;
  const policyVersion=Number.isSafeInteger(rule.policyVersion)?Number(rule.policyVersion):null;
  rules.push({categoryKey,ruleVersion:typeof rule.version==='string'?rule.version:String(row.version_id),policyId,policyVersion,policyPublished:!!policyId&&policyVersion!==null&&policyKeys.has(policyId+'|'+policyVersion),effectiveFrom:shanghaiDay(row.effective_from)});
 }
 return rules;
}
export async function screenHeat(result:ReturnType<typeof buildScreen>,dataset:TenderDataset|null,permissions:readonly string[],readRules:PublishedHeatRuleReader=readPublishedHeatRules):Promise<ScreenSection<ScreenHeat>>{
 const empty:ScreenHeat={days:null,thresholds:null,coefficients:null,policyId:null,ruleVersion:null,rules:[],grids:[]};
 if(!permissions.includes('grid.read')||!permissions.includes('heatmap.read'))return {state:'unavailable',reason:'缺少网格或热力权限',data:empty};
 if(result.mode==='simulation'&&dataset){
  const days=dayCount(result.window.from,result.window.to),coefficients=[...SIMULATED_HEAT_COEFFICIENTS],version='simulation-only';
  const thresholds=coefficients.map(c=>Number((Number(c)*days).toFixed(2)));
  const grids=dataset.grids.map(g=>{const count=result.details.filter(r=>r.adminGridCode===g.id).length;
   return {code:g.id,count,...evaluateHeat({count,days,rule:{version,coefficients},policy:TENDER_HEAT_POLICY})};});
  return {state:'available',reason:'仅模拟样本，非正式热力',data:{days,thresholds,coefficients,policyId:TENDER_HEAT_POLICY_ID,ruleVersion:version,rules:[],grids}};
 }
 if(result.mode!=='simulation'){
  let rules:ScreenHeatRuleRef[];
  try{rules=await readRules(result.window.to);}catch{return {state:'unavailable',reason:'读取已发布热力规则失败，正式热力不可计算',data:empty};}
  if(!rules.length)return {state:'unavailable',reason:'无已发布热力规则',data:empty};
  const single=rules.length===1?rules[0]:null;
  const data:ScreenHeat={days:dayCount(result.window.from,result.window.to),thresholds:null,coefficients:null,policyId:single?.policyId??null,ruleVersion:single?.ruleVersion??null,rules,grids:[]};
  if(!rules.some(rule=>rule.policyPublished))return {state:'unavailable',reason:'已取到已发布热力规则版本，但缺少已确认政策版本，正式热力不可计算',data};
  return {state:'partial',reason:'规则版本已取到，但缺行政网格边界/服务网格几何，正式热力不可计算',data};
 }
 return {state:'unavailable',reason:'正式空间资源及发布规则尚未核验',data:empty};
}