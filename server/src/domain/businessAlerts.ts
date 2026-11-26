import {createHash} from 'node:crypto';

/** 预警统计范围：全市（标书 1.2.10「诉求量」口径）/ 区县 / 企业 / 行政网格。 */
export type AlertScope='city'|'district'|'enterprise'|'grid';
const ALERT_SCOPES:readonly string[]=['city','district','enterprise','grid'];
/** 历史规则 content 与旧响应没有 scope 时一律按全市处理，不得抛错。 */
export function resolveAlertScope(value:unknown):AlertScope{
 return typeof value==='string'&&ALERT_SCOPES.includes(value)?value as AlertScope:'city';
}

interface AlertFact {complaintId:string;enterpriseCode:string|null;districtCode:string|null;adminGridCode:string|null;timeSource?:string|null;majorCode?:string|null;minorCode?:string|null;dictionaryVersion?:string|null}

interface ScopeFactFields {timeSource?:string|null;majorCode?:string|null;minorCode?:string|null;dictionaryVersion?:string|null;districtCode?:string|null;enterpriseCode?:string|null;adminGridCode?:string|null}

/** 按统计范围列出判定所需但缺失的字段；空数组=该行可参与判定。
 * city：业务时间来源 + 大类/小类 + 分类字典版本；district 需区县；enterprise 需企业；
 * grid 需企业 + 区县 + 行政网格（与网格分组口径一致）。 */
export function alertScopeMissingFields(row:ScopeFactFields,scope:AlertScope):string[]{
 const missing:string[]=[];
 if(row.timeSource!=='source_reported_at')missing.push('timeSource');
 if(!row.majorCode&&!row.minorCode)missing.push('major/minor');
 if(!row.dictionaryVersion)missing.push('dictionaryVersion');
 if((scope==='district'||scope==='grid')&&!row.districtCode)missing.push('districtCode');
 if((scope==='enterprise'||scope==='grid')&&!row.enterpriseCode)missing.push('enterpriseCode');
 if(scope==='grid'&&!row.adminGridCode)missing.push('adminGridCode');
 return missing;
}

type GroupCodes=readonly [enterpriseCode:string|null,districtCode:string|null,adminGridCode:string|null];
/** 按 scope 返回分组键；该行缺少本 scope 的分组维度时返回 null（交由完整性判定，不并入 null 分组）。 */
function groupCodes(scope:AlertScope,row:AlertFact):GroupCodes|null{
 switch(scope){
  case 'city':return [null,null,null];
  case 'district':return row.districtCode?[null,row.districtCode,null]:null;
  case 'enterprise':return row.enterpriseCode?[row.enterpriseCode,null,null]:null;
  case 'grid':return row.enterpriseCode&&row.districtCode&&row.adminGridCode?[row.enterpriseCode,row.districtCode,row.adminGridCode]:null;
 }
}

export function alertCandidates(rule:{ruleId:string;version:number;threshold:number|null;scope?:string|null},rows:AlertFact[],from:string,to:string){
 const scope=resolveAlertScope(rule.scope);
 const groups=new Map<string,{codes:GroupCodes;rows:AlertFact[]}>();
 for(const row of new Map(rows.map(r=>[r.complaintId,r] as const)).values()){
  const codes=groupCodes(scope,row);if(!codes)continue;
  const key=JSON.stringify([scope,codes]),group=groups.get(key)??{codes,rows:[]};
  group.rows.push(row);groups.set(key,group);
 }
 return [...groups.values()].filter(g=>rule.threshold!==null&&g.rows.length>=rule.threshold).map(g=>{
  const [enterpriseCode,districtCode,adminGridCode]=g.codes,complaintIds=g.rows.map(r=>r.complaintId).sort();
  return {alertId:createHash('sha256').update(JSON.stringify([rule.ruleId,rule.version,scope,enterpriseCode,districtCode,adminGridCode,from,to])).digest('hex'),scope,enterpriseCode,districtCode,adminGridCode,quantity:complaintIds.length,complaintIds};
 });
}

/** 展示/查询侧按已存三码推断统计范围（历史行 evidence 无 scope 时的兜底，不得编造）。 */
export function alertScopeOfCodes(enterpriseCode:string|null,districtCode:string|null,adminGridCode:string|null):AlertScope{
 if(enterpriseCode&&districtCode&&adminGridCode)return 'grid';
 if(enterpriseCode)return 'enterprise';
 if(districtCode)return 'district';
 return 'city';
}

/** Use only explicitly planned, approved real public-utility applications. Never infer
 * planned nature from a title or join the obsolete shutdown worker tables. */
export function plannedUtilityEvidence(rows:(AlertFact&{businessType:string|null;businessAt:string|null})[],sources:import('./utilityFeed').MappedUtilitySource[]) {
 const evidence:{complaintId:string;eventId:string;sourceApplicationNo:string;sourceRevision:string;eventRevision:number}[]=[];
 for(const mapped of sources){
  const source=mapped.source;
  if(mapped.syncStatus!=='mapped'||source.dataMode!=='real'||source.fields.nature!=='planned')continue;
  for(const event of mapped.events){
   if(event.mode!=='real'||event.kind!=='shutdown'||event.sourceSystem!=='public-utility'||event.approvalStatus!=='approved'||['cancelled','canceled','withdrawn','rejected','90'].includes(String(source.status).toLowerCase())||String(source.approvalStatus).toLowerCase()==='cancelled')continue;
   const start=Date.parse(event.startsAt),end=Date.parse(event.endsAt);
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)continue;
   for(const row of rows){
    const at=row.businessAt?Date.parse(row.businessAt):NaN;
    if(row.enterpriseCode!==event.enterpriseId||row.districtCode!==event.districtCode||row.businessType!==event.businessType||!row.adminGridCode||!event.gridIds.includes(row.adminGridCode)||!Number.isFinite(at)||at<start||at>end)continue;
    evidence.push({complaintId:row.complaintId,eventId:event.id,sourceApplicationNo:source.sourceApplicationNo,sourceRevision:source.revision,eventRevision:event.revision});
   }
  }
 }
 return evidence;
}
