import {pool} from '../db/pool';
import {AppError} from '../http/errors';
import type {AccessContext} from '../auth/accessScope';
import {canAccessEnterprise} from '../auth/enterpriseScope';
import type {SqlExecutor} from '../repositories/userRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import {readStatisticsRows,readStatisticsCoverage,type CoverageEvidence} from '../repositories/statisticsRepo';
import {snapshotFactsFromComplaint,readStatisticsSnapshot,resolveBusinessTime,statisticsIso} from '../domain/statisticsFacts';
import {STATISTICS_POLICY,addDays,resolveComparisonPeriods,computePeriodChange} from '../domain/statisticsQuery';
import {coverageContainsWgs84Point} from './locationValidationService';
import {labelOf} from '../domain/enums';
import type {StatisticsQuery,StatisticsComplaint,StatisticsResult,DimensionBucket,BucketSelection,HouseholdEvidence,StatisticsPage} from '../types/statistics';
import {rowToListItem,type ComplaintRow} from '../repositories/complaintMapper';
export interface StatisticsCapture {
 version:1;summary:StatisticsResult;rows:StatisticsComplaint[];
 /** Actual facts for every counted/excluded current and comparison contribution. */
 periodFacts:{kind:'current'|'yoy'|'mom';from:string;to:string;rows:StatisticsComplaint[];excludedRows:{row:StatisticsComplaint;reason:string}[]}[];
 categoryEvidence:{code:string;dictionaryVersion:string;level:'major'|'minor';name:string;snapshot:unknown|null}[];
 coverageEvidence:CoverageEvidence[];householdEvidence:HouseholdEvidence[];
 scopeFacts:{complaintId:string;current:{enterpriseCode:string|null;districtCode:string|null};original:{enterpriseCode:string|null;districtCode:string|null}}[];
 /** Same read snapshot compatibility DTOs; no raw source JSON. */
 legacyListItems:ReturnType<typeof rowToListItem>[];legacyMetrics:{sensitive:number;closedInSystem:number;sourceClosed:number;sourceKnown:number};
}
const text=(v:unknown)=>v==null?null:String(v);
const json=(v:unknown):unknown=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return null;}};
export function assertStatisticsPermission(q:StatisticsQuery,permissions:readonly string[],detail=false,legacy=false):void {
 if((!legacy&&!permissions.includes('statistics.read'))||!permissions.includes(q.dataset==='ledger'?'dashboard.read':'analysis.read')||detail&&!permissions.includes('complaint.read'))throw AppError.forbidden();
}
function toFact(row:Record<string,unknown>,q:StatisticsQuery):StatisticsComplaint {
 let facts=snapshotFactsFromComplaint(row);let snapshotReason:string|null=null;
 if(q.projection==='entry_snapshot'){
  const entry=readStatisticsSnapshot(row.statistics_snapshot_version,row.statistics_snapshot);
  if(entry&&entry.complaintId===facts.complaintId)facts=entry;
  else{snapshotReason=row.statistics_snapshot==null?'旧入库记录未留存统计快照':'入库统计快照版本或内容不可用';facts={...facts,title:text(row.entry_title),businessType:text(row.entry_business_type),complaintType:text(row.entry_complaint_type),districtCode:text(row.entry_district_code),districtName:text(row.entry_district_name),enterpriseCode:text(row.entry_enterprise_code),enterpriseName:text(row.entry_enterprise_name),majorCode:null,minorCode:null,dictionaryVersion:null,sourceReportedAt:null,receivedAt:null,longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null,adminGridCode:null,communityCode:null,editVersion:0,enteredAt:statisticsIso(row.confirmed_at)};}
 }
 return {...facts,id:Number(row.id),analysisId:text(row.analysis_id),...resolveBusinessTime(facts),grids:[],locationReason:null,snapshotReason};
}
function scalarMatch(row:StatisticsComplaint,q:StatisticsQuery):boolean {
 return (['businessType','majorCode','minorCode','enterpriseCode','districtCode'] as const).every(k=>q[k]===undefined||row[k]===q[k]);
}
function bucketMatch(row:StatisticsComplaint,b:BucketSelection):boolean {
 switch(b.dimension){
  case 'business':return row.businessType===b.code;
  case 'enterprise':return row.enterpriseCode===b.code;
  case 'district':return row.districtCode===b.code;
  case 'grid':return b.code===null?row.grids.length===0:row.grids.includes(b.code);
  case 'category':return row[b.level==='major'?'majorCode':'minorCode']===b.code&&(row.dictionaryVersion??null)===b.dictionaryVersion;
 }
}
function select(rows:StatisticsComplaint[],q:StatisticsQuery){
 const excluded:Record<string,number>={};const excludedRows:{row:StatisticsComplaint;reason:string}[]=[];const increment=(reason:string,row:StatisticsComplaint)=>{excluded[reason]=(excluded[reason]??0)+1;excludedRows.push({row,reason});};let missingDates=0;
 const content=rows.filter(r=>{
  // Missing required category is counted separately only if other noncategory filters match.
  if(!(['businessType','enterpriseCode','districtCode'] as const).every(k=>q[k]===undefined||r[k]===q[k]))return false;
  if(!r.businessDay){missingDates++;increment(r.snapshotReason??'业务日期不可用',r);return false;}
  if(r.businessDay<q.from||r.businessDay>q.to)return false;
  if((q.majorCode!==undefined&&r.majorCode===null)||(q.minorCode!==undefined&&r.minorCode===null)){increment('正式分类筛选所需字段不可用',r);return false;}
  if(!scalarMatch(r,q))return false;
  if(q.serviceGridCode&&!r.grids.includes(q.serviceGridCode)){if(!r.grids.length)increment('网格筛选所需历史空间证据不可用',r);return false;}
  return !q.bucket||bucketMatch(r,q.bucket);
 });return {content,excluded,missingDates,excludedRows};
}
async function householdRate(db:SqlExecutor,q:StatisticsQuery,enterpriseCode:string,count:number,access:AccessContext,permissions:readonly string[],partial:boolean):Promise<HouseholdEvidence>{
 const evidence:HouseholdEvidence={enterpriseCode,at:q.to,households:null,validFrom:null,validTo:null,version:null,value:null,reason:null,label:'候选期末户数：完整企业服务人口，每万户所选类别事件数（待业务确认）'};
 if(!permissions.includes('enterprise.read'))return {...evidence,reason:'无企业主数据查询权限，户数不可用'};
 const enterprise=(await rowsIn(db,'select enterprise_code,district_code from enterprise where enterprise_code=?',[enterpriseCode]))[0];
 if(!enterprise||!canAccessEnterprise(access,{enterpriseCode,districtCode:text(enterprise.district_code)}))return {...evidence,reason:'企业主数据不在当前授权范围，户数不可用'};
 const whole=access.rules.some(r=>r.kind==='all'||!r.districtCodes.length&&r.enterpriseCodes.includes(enterpriseCode));
 if(!whole||q.districtCode||q.serviceGridCode||q.bucket?.dimension==='district'||q.bucket?.dimension==='grid')return {...evidence,reason:'当前范围或区划/网格筛选仅覆盖局部人口，不能使用整企业户数'};
 if(partial)return {...evidence,reason:'统计存在业务日期未知记录，人口指标不完整'};
 const h=(await rowsIn(db,'select households,valid_from,valid_to,version from enterprise_household_version where enterprise_code=? and valid_from<=? and (valid_to is null or valid_to>?) order by valid_from desc limit 1',[enterpriseCode,q.to,q.to]))[0];
 if(!h)return {...evidence,reason:'所选期末无有效历史户数区间'};
 const day=(v:unknown)=>v instanceof Date?v.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):String(v).slice(0,10);
 evidence.households=h.households==null?null:Number(h.households);evidence.validFrom=day(h.valid_from);evidence.validTo=h.valid_to==null?null:day(h.valid_to);evidence.version=String(h.version);
 evidence.reason=evidence.households===null?'历史户数未知':evidence.households===0?'历史户数为零':null;evidence.value=evidence.reason?null:count/evidence.households!*10000;return evidence;
}
/** All facts, names, periods and actual evidence are read through ONE supplied snapshot. */
export async function captureStatisticsIn(db:SqlExecutor,q:StatisticsQuery,access:AccessContext,permissions:readonly string[],clock:()=>Date=()=>new Date(),legacy=false):Promise<StatisticsCapture>{
 assertStatisticsPermission(q,permissions,false,legacy);
 const source=await readStatisticsRows(db,q,access);const rows=source.map(r=>toFact(r,q));
 const periods=resolveComparisonPeriods(q);const relevantRanges=[{from:q.from,to:q.to},...periods.filter(p=>p.from&&p.to).map(p=>({from:p.from!,to:p.to!}))];
 const relevant=rows.filter(r=>r.businessDay&&relevantRanges.some(p=>r.businessDay!>=p.from&&r.businessDay!<=p.to));
 const coverages=await readStatisticsCoverage(db,access,[...new Set(relevant.map(r=>r.businessDay!))]);
 for(const row of relevant){
  row.locationReason=row.longitude===null||row.latitude===null?'无成对坐标':row.coordinateSystem!=='WGS84'||!row.coordinateSource?'坐标系或来源未核实':null;
  if(!row.locationReason){row.grids=[...new Set(coverages.filter(({coverage:c})=>c.enterpriseCode===row.enterpriseCode&&c.businessType===row.businessType&&c.validFrom!==null&&c.validFrom<=row.businessDay!&&(c.validTo===null||c.validTo>row.businessDay!)&&coverageContainsWgs84Point(c,[row.longitude!,row.latitude!])).map(e=>e.coverage.code))].sort();if(!row.grids.length)row.locationReason='该业务日无可证明的授权覆盖边界匹配';}
 }
 const selected=select(rows,q);const periodFacts:StatisticsCapture['periodFacts']=[{kind:'current',from:q.from,to:q.to,rows:selected.content,excludedRows:selected.excludedRows}];
 const comparisons=periods.map(period=>{if(!period.from||!period.to)return {...period,currentCount:selected.content.length,baselineCount:null,changePercent:null};const baseline=select(rows,{...q,from:period.from,to:period.to});periodFacts.push({kind:period.kind,from:period.from,to:period.to,rows:baseline.content,excludedRows:baseline.excludedRows});return {...period,currentCount:selected.content.length,baselineCount:baseline.content.length,...computePeriodChange(selected.content.length,baseline.content.length,selected.missingDates>0||baseline.missingDates>0)};});
 const contributing=new Map(periodFacts.flatMap(p=>[...p.rows,...p.excludedRows.map(e=>e.row)]).map(r=>[r.complaintId,r]));
 const buckets=new Map<string,DimensionBucket>();const categoryEvidence:StatisticsCapture['categoryEvidence']=[];const dictionaries=new Map<string,unknown>();
 const versionIds=[...new Set([...contributing.values()].map(r=>r.dictionaryVersion).filter((s):s is string=>s!==null))];
 for(const version of versionIds){const result=await rowsIn(db,'select snapshot from dictionary_version where type_code=? and version=?',['complaint_category',version]);dictionaries.set(version,json(result[0]?.snapshot));}
 const categoryName=(code:string|null,version:string|null,level:'major'|'minor')=>{
  if(code===null)return '未知'+(level==='major'?'大类':'小类');const snapshot=version?dictionaries.get(version):null;const items=(snapshot as {items?:{code:string;label:string}[]}|null)?.items;
  const name=Array.isArray(items)?items.find(i=>i.code===code)?.label:null;const resolved=typeof name==='string'?name:code+'（字典版本名称不可用）';
  if(version&&!categoryEvidence.some(e=>e.code===code&&e.dictionaryVersion===version&&e.level===level))categoryEvidence.push({code,dictionaryVersion:version,level,name:resolved,snapshot:snapshot??null});return resolved;
 };
 const add=(b:BucketSelection,name:string)=>{const key=JSON.stringify(b);const current=buckets.get(key);if(current)current.count++;else buckets.set(key,{...b,name,count:1});};
 for(const row of selected.content){
  add({dimension:'business',code:row.businessType},row.businessType?labelOf('business_type',row.businessType):'未知业务');
  add({dimension:'enterprise',code:row.enterpriseCode},row.enterpriseName??row.enterpriseCode??'未知企业');add({dimension:'district',code:row.districtCode},row.districtName??row.districtCode??'未知区划');
  for(const level of ['major','minor'] as const){const code=row[level==='major'?'majorCode':'minorCode'];add({dimension:'category',code,level,dictionaryVersion:row.dictionaryVersion},categoryName(code,row.dictionaryVersion,level));}
  if(!row.grids.length)add({dimension:'grid',code:null},'未定位');else for(const code of row.grids)add({dimension:'grid',code},code);
 }
 // Resolve frozen category names for baseline/excluded contributors too, even though only current rows produce public buckets.
 for(const row of contributing.values())for(const level of ['major','minor'] as const)categoryName(row[level==='major'?'majorCode':'minorCode'],row.dictionaryVersion,level);
 const trend=[];for(let d=q.from;d<=q.to;d=addDays(d,1))trend.push({date:d,count:selected.content.filter(r=>r.businessDay===d).length});
 const enterpriseCodes=[...new Set(selected.content.map(r=>r.enterpriseCode).filter((s):s is string=>s!==null))];if(q.enterpriseCode&&!enterpriseCodes.includes(q.enterpriseCode))enterpriseCodes.push(q.enterpriseCode);
 const rates=[];for(const code of enterpriseCodes)rates.push(await householdRate(db,q,code,selected.content.filter(r=>r.enterpriseCode===code).length,access,permissions,selected.missingDates>0));
 const summary:StatisticsResult={query:q,policy:{...STATISTICS_POLICY},timezone:'Asia/Shanghai',timeBasis:'规范化来源填报时间优先；缺失或无效回落平台接收时间（候选口径，非认证来源时序）',total:selected.content.length,partial:selected.missingDates>0,dateFilterUnavailableCount:selected.missingDates,sourceTimeFallbackCount:selected.content.filter(r=>r.timeSource==='received_fallback').length,unlocatedCount:selected.content.filter(r=>!r.grids.length).length,multiGridCount:selected.content.filter(r=>r.grids.length>1).length,excludedByReason:selected.excluded,dimensions:[...buckets.values()].sort((a,b)=>b.count-a.count||JSON.stringify(a).localeCompare(JSON.stringify(b))),comparisons,dataCutoffAt:clock().toISOString(),projectionCapabilities:{businessDate:selected.missingDates?'部分入库记录未留存业务日期':null,category:q.projection==='entry_snapshot'&&rows.some(r=>r.snapshotReason)?'旧入库记录未留存正式分类快照':null,location:q.projection==='entry_snapshot'&&rows.some(r=>r.snapshotReason)?'旧入库记录未留存位置快照':null},trend,rates,overallRate:{value:null,reason:'总体未证明完整无重叠企业人口 cohort；请查看具备依据的企业指标'},satisfactionRate:{value:null,reason:'正式回访有效性与来源优先政策尚未业务确认'}};
 const selectedIds=new Set(selected.content.map(r=>r.complaintId));const matchingSource=source.filter(r=>selectedIds.has(String(r.complaint_id)));
 const legacyMetrics={sensitive:0,closedInSystem:0,sourceClosed:0,sourceKnown:0};for(const row of matchingSource){if(Number(row.is_sensitive)===1)legacyMetrics.sensitive++;if(Number(row.closed_in_system)===1)legacyMetrics.closedInSystem++;if(['completed','closed'].includes(String(row.source_event_status)))legacyMetrics.sourceClosed++;if(row.source_event_status!=null&&row.source_event_status!=='unknown')legacyMetrics.sourceKnown++;}
 return {version:1,summary,rows:selected.content,periodFacts,categoryEvidence,coverageEvidence:coverages,householdEvidence:rates,scopeFacts:source.filter(r=>contributing.has(String(r.complaint_id))).map(row=>{const fact=contributing.get(String(row.complaint_id))!;return {complaintId:fact.complaintId,current:{enterpriseCode:text(row.enterprise_code),districtCode:text(row.district_code)},original:{enterpriseCode:fact.enterpriseCode,districtCode:fact.districtCode}};}),legacyListItems:matchingSource.map(r=>rowToListItem(r as unknown as ComplaintRow)),legacyMetrics};
}
export async function captureStatistics(q:StatisticsQuery,access:AccessContext,permissions:readonly string[],clock:()=>Date=()=>new Date(),legacy=false):Promise<StatisticsCapture>{
 assertStatisticsPermission(q,permissions,false,legacy);const conn=await pool.getConnection();try{await conn.query('set transaction isolation level repeatable read');await conn.query('start transaction with consistent snapshot, read only');return await captureStatisticsIn(conn,q,access,permissions,clock,legacy);}finally{try{await conn.rollback();}finally{conn.release();}}
}
export function statisticsPage(capture:StatisticsCapture,page:number,size:number):StatisticsPage {
 return {query:capture.summary.query,content:capture.rows.slice((page-1)*size,page*size),total:capture.summary.total,page,size,totalPages:Math.ceil(capture.summary.total/size),partial:capture.summary.partial,dateFilterUnavailableCount:capture.summary.dateFilterUnavailableCount,dataCutoffAt:capture.summary.dataCutoffAt};
}
