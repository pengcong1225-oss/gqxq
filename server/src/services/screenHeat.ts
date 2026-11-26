import {buildSpatialScopeSql, canAccessSpatialMaster} from '../auth/gridScope';
import type {AccessContext} from '../auth/accessScope';
import {evaluateHeat, policyFingerprint, TENDER_HEAT_POLICY, TENDER_HEAT_POLICY_ID, validateCoefficients, validateConfirmation} from '../domain/heatRule';
import {SIMULATED_HEAT_COEFFICIENTS} from '../domain/simulatedYichangGrid';
import {dayCount} from '../domain/statisticsQuery';
import type {buildScreen, ScreenQuery} from '../domain/screen';
import type {TenderDataset} from '../types/tenderSupport';
import type {ScreenSection, ScreenHeat, ScreenHeatRuleRef} from '../types/screen';
import {rowsIn} from '../repositories/serviceGridRepo';
import {heatCategoryKey, heatJson, readPublishedHeat} from '../repositories/heatRuleRepo';
import type {SqlExecutor} from '../repositories/userRepo';
import {validateGeometry} from './serviceGridService';
import {CATEGORY_TYPE} from './categoryService';
import {readDictionaryItems} from './dictService';
import type {FrozenHeatRule} from './heatRuleService';
import type {ScreenEvidenceItem} from './screenEvidence';

const thresholdsFor=(coefficients:readonly string[],days:number)=>coefficients.map(c=>Number((Number(c)*days).toFixed(2)));
type Options={query:ScreenQuery;access:AccessContext;db:SqlExecutor;details?:Map<string,ScreenEvidenceItem[]>};

async function readRule(db:SqlExecutor,key:string,to:string) {
 const row=await readPublishedHeat(db,key,to);
 if(!row)return null;
 const frozen=heatJson<FrozenHeatRule>(row.content);
 const {rule,policy,confirmation}=frozen;
 const ref:ScreenHeatRuleRef={categoryKey:key,ruleVersion:String(row.version_id),policyId:rule.policyId,policyVersion:rule.policyVersion,policyPublished:false,effectiveFrom:rule.effectiveFrom};
 const appliedKey=heatCategoryKey(rule.category.majorCode,rule.category.minorCode);
 if(frozen.formatVersion!==1||rule.version!==ref.ruleVersion||appliedKey!==key||
    !validateConfirmation(confirmation,rule.policyVersion,policy))return {frozen,ref};
 validateCoefficients(rule.coefficients);
 const [published]=await rowsIn(db,'select fingerprint from heat_policy_version where policy_id=? and policy_version=?',[rule.policyId,rule.policyVersion]);
 ref.policyPublished=published?.fingerprint===policyFingerprint(policy);
 return {frozen,ref};
}

async function readGrids({db,query,access}:Options) {
 const scope=buildSpatialScopeSql(access,'audit_ag.district_code');
 const conditions=[scope.sql,'audit_ag.code<>audit_ag.district_code','audit_ag.geometry is not null','audit_ag.coordinate_system=\'WGS84\''];
 const params=scope.params;
 if(query.districtCode){conditions.push('audit_ag.district_code=?');params.push(query.districtCode);}
 if(query.adminGridCode){conditions.push('audit_ag.code=?');params.push(query.adminGridCode);}
 return rowsIn(db,'select code,name,district_code,version,geometry,coordinate_system,geometry_source from admin_grid audit_ag where '+conditions.join(' and ')+' order by code',params);
}

function visibleZero(access:AccessContext,district:string,query:ScreenQuery) {
 return !query.enterpriseCode&&!query.communityCode&&access.rules.some(r=>r.kind==='all'||!r.enterpriseCodes.length&&r.districtCodes.includes(district));
}

/** Map the exact scoped ledger slice by its recorded administrative grid and district. */
async function mapGrids(rows:ScreenEvidenceItem[], options:Options, days:number, selected:FrozenHeatRule|null) {
 const {query,access,db,details}=options;
 const rowsByGrid=new Map<string,ScreenEvidenceItem[]>();
 for(const row of rows){
  const list=rowsByGrid.get(row.adminGridCode)??[];
  list.push(row);
  rowsByGrid.set(row.adminGridCode,list);
 }
 const grids:ScreenHeat['grids']=[];
 const mappedCommunities=new Map<string,string>();
 const matched=new Map<string,ScreenEvidenceItem[]>();
 for(const grid of await readGrids(options)){
  const {code,name,district_code:district,geometry_source:source}=grid;
  if(typeof code!=='string'||typeof district!=='string'||code===district||!canAccessSpatialMaster(access,district)||
    grid.coordinate_system!=='WGS84'||typeof source!=='string'||!source.trim()||
    /模拟|演示|测试|示例|近似|推导|栅格|未知|不明|待|未确认|未核验|未核实|无来源|\b(osm|unknown|test|tbd|n\/a)\b|voronoi|buffer|simulation|demo|approx|unverified|pending/i.test(source))continue;
  const members=(rowsByGrid.get(code)??[]).filter(row=>row.districtCode===district);
  if(!members.length&&!visibleZero(access,district,query))continue;
  let geometry;
  try{geometry=validateGeometry(heatJson(grid.geometry));}catch{continue;}
  if(!geometry)continue;
  for(const row of members)if(row.communityCode!=='__missing__')mappedCommunities.set(row.communityCode,code);
  matched.set(code,members);
  grids.push({code,name:String(name),geometry,geometrySource:source,geometryVersion:String(grid.version),communities:[],
   count:members.length,...evaluateHeat({count:members.length,days,rule:selected?.rule??null,policy:selected?.policy})});
 }
 const communitiesByGrid=new Map<string,Set<string>>();
 const communityCodes=[...mappedCommunities.keys()];
 for(let offset=0;offset<communityCodes.length;offset+=500){
  const batch=communityCodes.slice(offset,offset+500);
  const communities=await rowsIn(db,'select code,name,admin_grid_code from community where code in ('+batch.map(()=>'?').join(',')+') order by name,code',batch);
  for(const {code,name,admin_grid_code:gridCode} of communities){
   if(typeof gridCode!=='string'||typeof name!=='string'||mappedCommunities.get(String(code))!==gridCode)continue;
   const names=communitiesByGrid.get(gridCode)??new Set<string>();
   names.add(name);
   communitiesByGrid.set(gridCode,names);
  }
 }
 for(const grid of grids){
  grid.communities=[...(communitiesByGrid.get(grid.code)??[])];
  details?.set(grid.code,matched.get(grid.code)!);
 }
 return grids;
}

export async function screenHeat(result:ReturnType<typeof buildScreen>,dataset:TenderDataset|null,permissions:readonly string[],options?:Options):Promise<ScreenSection<ScreenHeat>>{
 const data:ScreenHeat={days:null,thresholds:null,coefficients:null,policyId:null,ruleVersion:null,rules:[],grids:[],categories:[],unmappedCount:null};
 const unavailable=(reason:string):ScreenSection<ScreenHeat>=>({state:'unavailable',reason,data});
 if(!permissions.includes('grid.read')||!permissions.includes('heatmap.read'))return unavailable('缺少网格或热力权限');
 const days=dayCount(result.window.from,result.window.to);
 data.days=days;
 if(result.mode==='simulation'&&dataset){
  const coefficients=[...SIMULATED_HEAT_COEFFICIENTS],version='simulation-only';
  const grids=dataset.grids.map(g=>{const count=result.details.filter(r=>r.adminGridCode===g.id).length;
   return {code:g.id,count,...evaluateHeat({count,days,rule:{version,coefficients},policy:TENDER_HEAT_POLICY})};});
  return {state:'available',reason:'仅模拟样本，非正式热力',data:{...data,thresholds:thresholdsFor(coefficients,days),coefficients,policyId:TENDER_HEAT_POLICY_ID,ruleVersion:version,grids}};
 }
 if(!options)return unavailable('正式热力查询上下文不可用');
 const {db,query}=options;
 let selected:FrozenHeatRule|null=null;
 let ruleReason:string|null=null;
 let categoryIndustry:string|null=null;
 try{
  const items=await readDictionaryItems(db,CATEGORY_TYPE);
  const published=items.filter(i=>i.published&&i.status==='enabled');
  data.categories=published.filter(i=>!i.parentCode||published.some(parent=>parent.code===i.parentCode&&!parent.parentCode))
   .map(i=>({code:i.code,name:i.label,parentCode:i.parentCode}));
  const item=data.categories.find(i=>i.code===query.categoryCode);
  const major=item?.parentCode??item?.code;
  categoryIndustry=major==='water_service'?'water':major==='gas_service'?'gas':null;
  if(!item)ruleReason=query.categoryCode?'所选诉求分类缺少有效字典映射':'请选择诉求大类或小类';
  else if(categoryIndustry&&query.businessType&&query.businessType!==categoryIndustry){
   ruleReason='所选诉求分类与当前行业不匹配';
  }
  else {
   const exact=await readRule(db,heatCategoryKey(item.parentCode??item.code,item.parentCode?item.code:null),query.to);
   const fallback=!exact&&item.parentCode?await readRule(db,heatCategoryKey(item.parentCode,null),query.to):null;
   const candidate=exact??(fallback?.frozen.policy?.classFallback==='minor_then_major'?fallback:null);
   if(candidate){
    data.rules=[candidate.ref];
    data.ruleVersion=candidate.ref.ruleVersion;
    data.policyId=candidate.ref.policyId;
   }
   if(!candidate)ruleReason='所选分类截至统计结束日无已发布热力规则';
   else if(!candidate.ref.policyPublished)ruleReason='已发布热力规则缺少可核验的确认政策版本';
   else {
    selected=candidate.frozen;
    data.coefficients=selected.rule.coefficients;
    data.thresholds=thresholdsFor(data.coefficients,days);
   }
  }
 }catch{
  ruleReason='读取已发布热力规则失败';
 }
 let geometryReason:string|null=null;
 try{
  const demands=result.details.filter(row=>(row.businessType==='water'||row.businessType==='gas')&&(!categoryIndustry||row.businessType===categoryIndustry));
  data.grids=await mapGrids(demands,options,days,selected);
  data.unmappedCount=demands.length-data.grids.reduce((sum,g)=>sum+g.count,0);
  if(!data.grids.length)geometryReason='当前范围缺少可核验的正式行政网格面';
  else if(data.unmappedCount)geometryReason=`${data.unmappedCount} 件诉求缺少可核验的正式行政网格关联`;
 }catch{
  geometryReason='读取正式行政网格关系失败';
 }
 const reason=[ruleReason,geometryReason].filter(Boolean).join('；');
 if(ruleReason||!data.grids.length)return unavailable(reason);
 return {state:geometryReason?'partial':'available',reason:reason||null,data};
}
