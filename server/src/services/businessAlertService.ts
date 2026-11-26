import {randomUUID} from 'node:crypto';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {buildComplaintScopeSql,canAccessComplaint} from '../auth/accessScope';
import {eventRows,featureOwnershipScope} from '../repositories/sourceBusinessRepo';
import {addDays,normalizeShanghaiDay,shanghaiToday} from '../domain/statisticsQuery';
import {alertCandidates,plannedUtilityEvidence,alertScopeMissingFields,resolveAlertScope,alertScopeOfCodes,type AlertScope} from '../domain/businessAlerts';
import {seasonRange} from '../domain/businessAssessment';
import {captureStatisticsIn} from './statisticsService';
import {publishedRules,decodeContent,featureAudit,type BusinessRule} from './businessRuleService';
import {currentFeatureActor,featurePermission} from './businessFeatureAuth';
import type {BusinessEventContext} from '../types/businessEvents';
interface AlertEvidence {scope?:AlertScope;utilityEvidence?:ReturnType<typeof plannedUtilityEvidence>;scene:string;ruleName:string;definitionBasis:string;dictionaryVersion:string;complaintIds:string[];facts:{complaintId:string;editVersion:number}[];dataCutoffAt:string}
const codeOf=(value:unknown):string|null=>value==null?null:String(value);

function alertRuleSettings(rule:BusinessRule){
 const {ruleId,name,scene,businessType,version:ruleVersion,threshold,windowDays,majorCodes,minorCodes,dictionaryVersion}=rule;
 return {ruleId,name,scene,businessType,ruleVersion,threshold,windowDays,majorCodes,minorCodes,dictionaryVersion,scope:resolveAlertScope(rule.scope)};
}

export async function listBusinessAlertRules(ctx:BusinessEventContext){
 featurePermission(ctx,'alert.read');
 const canReadDrafts=ctx.permissionCodes.includes('business.rules.manage')&&ctx.access.rules.some(r=>r.kind==='all');
 const canEvaluate=!ctx.access.roles.includes('readonly')&&['alert.handle','statistics.read','dashboard.read'].every(p=>ctx.permissionCodes.includes(p));
 const asOf=shanghaiToday();
 return withTransaction(async tx=>{
  const published=await publishedRules(tx,'alert');
  let draftScenes:string[]|null=null;
  if(canReadDrafts){
   const versions=new Map(published.map(rule=>[rule.ruleId,rule.version]));
   const drafts=await eventRows(tx,"select rule_id,edit_version,json_unquote(json_extract(content,'$.scene')) as scene from business_rule where kind=?",['alert']);
   draftScenes=[...new Set(drafts.filter(draft=>{
    const version=versions.get(String(draft.rule_id));
    // 发布会推进一次编辑版本，后续再次保存才产生待发布改动。
    return Number(draft.edit_version)>(version===undefined?0:version+1);
   }).map(draft=>String(draft.scene)).filter(scene=>['winter','summer','planned_shutdown','gas_three_piece'].includes(scene)))];
  }
  const rules=published.map(rule=>({
   ...alertRuleSettings(rule),effectiveFrom:rule.effectiveFrom,effectiveTo:rule.effectiveTo,
   state:!rule.enabled?'disabled':asOf<rule.effectiveFrom||asOf>rule.effectiveTo?'out_of_effect':'enabled',
  }));
  return {asOf,rules,draftScenes,canEvaluate};
 });
}

export async function authorizedAlerts(db:Pick<Tx,'query'>,ctx:BusinessEventContext,id?:string,lock=false){featurePermission(ctx,'alert.read');const cs=buildComplaintScopeSql(ctx.access,'c'),own=featureOwnershipScope(ctx.access,'a');const rows=await eventRows(db,'select a.alert_id,a.rule_id,a.rule_version,a.window_from,a.window_to,a.enterprise_code,a.district_code,a.admin_grid_code,a.quantity,a.threshold_value,a.state,a.evidence,a.created_at from business_alert a where '+own.sql+(id?' and a.alert_id=? ':' ')+'order by a.created_at desc limit 1001'+(lock?' for share':''),[...own.params,...(id?[id]:[])]);if(rows.length>1000)throw AppError.validation('当前授权预警超过1000条，请缩小授权范围');
 // 全市口径预警三码为 NULL：所有权过滤按授权范围判定（受限授权不可见全域统计），这里只做空值安全处理。
 const result:(Record<string,unknown>&{evidence:AlertEvidence})[]=[];for(const r of rows){if(!canAccessComplaint(ctx.access,r))continue;const evidence=decodeContent<AlertEvidence>(r.evidence);if(!evidence||!Array.isArray(evidence.complaintIds)||evidence.complaintIds.length<1||evidence.complaintIds.length>100000)continue;const available=await eventRows(db,'select c.complaint_id from complaint c where c.complaint_id in ('+evidence.complaintIds.map(()=>'?').join(',')+') and '+cs.sql+(lock?' for share':''),[...evidence.complaintIds,...cs.params]);if(available.length!==evidence.complaintIds.length)continue;result.push({...r,evidence});}return result;
}
export async function listBusinessAlerts(ctx: BusinessEventContext) {
 const canReadComplaints = ctx.permissionCodes.includes('complaint.read');
 const canReadShutdown = ctx.permissionCodes.includes('shutdown.read');
 return withTransaction(async tx => (await authorizedAlerts(tx, ctx, undefined, true)).map(r => {
  const enterpriseCode = codeOf(r.enterprise_code), districtCode = codeOf(r.district_code), adminGridCode = codeOf(r.admin_grid_code);
  return {
   alertId: r.alert_id, ruleId: r.rule_id, ruleVersion: Number(r.rule_version),
   scope: r.evidence.scope ?? alertScopeOfCodes(enterpriseCode, districtCode, adminGridCode),
   from: new Date(r.window_from as string).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
   to: new Date(r.window_to as string).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
   enterpriseCode, districtCode, adminGridCode,
   quantity: Number(r.quantity), threshold: Number(r.threshold_value), state: r.state,
   createdAt: r.created_at, scene: r.evidence.scene, ruleName: r.evidence.ruleName, definitionBasis: r.evidence.definitionBasis,
   complaintIds: canReadComplaints ? r.evidence.complaintIds : null,
   ...(r.evidence.scene === 'planned_shutdown' ? {
    utilityEvidence: canReadComplaints && canReadShutdown ? r.evidence.utilityEvidence ?? [] : null,
   } : {}),
   dataCutoffAt: r.evidence.dataCutoffAt,
  };
 }));
}
export async function evaluateBusinessAlerts(day:string,ctx:BusinessEventContext){
 normalizeShanghaiDay(day);if(day>shanghaiToday())throw AppError.validation('不能计算未来预警');
 return withTransaction(async tx=>evaluateBusinessAlertsIn(tx,day,await currentFeatureActor(tx,ctx,'alert.handle')));
}
export async function evaluateBusinessAlertsIn(tx:Tx,day:string,actor:BusinessEventContext,assertActive:()=>void=()=>{}){
 normalizeShanghaiDay(day);if(day>shanghaiToday())throw AppError.validation('不能计算未来预警');
 featurePermission(actor,'alert.handle');featurePermission(actor,'alert.read');if(actor.access.roles.includes('readonly'))throw AppError.forbidden();
 const rules=(await publishedRules(tx,'alert')).filter(r=>r.enabled&&r.effectiveFrom<=day&&r.effectiveTo>=day);const seasons=await publishedRules(tx,'seasonal');const statuses=[];let created=0;
 for(const rule of rules){
  const ruleSettings=alertRuleSettings(rule),scope=ruleSettings.scope,from=addDays(day,1-rule.windowDays!),q={dataset:'ledger' as const,projection:'current' as const,periodKind:'custom' as const,from,to:day,comparisonPolicyId:'procurement-source-completed-v2' as const,businessType:rule.businessType};
  if (scope === 'city' && !actor.access.rules.some(rule => rule.kind === 'all')) {
   statuses.push({...ruleSettings,status:'insufficient',count:0,eligibleCount:0,incompleteCount:0,reason:'全市预警核算需要完整的全市数据权限'});
   continue;
  }
  const capture=await captureStatisticsIn(tx,q,actor.access,actor.permissionCodes);
  // 完整性按统计范围逐行判定：缺字段行只计入 incompleteCount，不再毒化整个窗口（覆盖不足也不得说成正常）。
  const complete=capture.rows.filter(r=>alertScopeMissingFields(r,scope).length===0),incompleteCount=capture.rows.length-complete.length;
  let rows=complete.filter(r=>r.dictionaryVersion===rule.dictionaryVersion&&((r.majorCode&&rule.majorCodes.includes(r.majorCode))||(r.minorCode&&rule.minorCodes.includes(r.minorCode)))),reason:string|null=null;
  if(rule.scene==='winter'||rule.scene==='summer'){const season=seasons.filter(s=>s.enabled&&s.scene===rule.scene&&s.businessType===rule.businessType);if(season.length!==1)reason='保障季规则尚未发布或不唯一';else{const s=season[0];const year=Number(day.slice(0,4))-(s.endMonth!<s.startMonth!&&Number(day.slice(5,7))<=s.endMonth!?1:0),range=seasonRange(year,s.startMonth!,s.endMonth!);rows=rows.filter(r=>r.businessDay&&r.businessDay>=range.from&&r.businessDay<=range.to&&r.businessDay>=s.effectiveFrom&&r.businessDay<=s.effectiveTo);}}
  // Require access to the entire aggregation group. A partial count must never claim its durable alert key.
  const authorized = rows.filter(row => canAccessComplaint(actor.access, {
   enterprise_code: scope === 'enterprise' || scope === 'grid' ? row.enterpriseCode : null,
   district_code: scope === 'district' || scope === 'grid' ? row.districtCode : null,
  }));
  const scopeExcludedCount = rows.length - authorized.length;
  rows = authorized;
  if (scopeExcludedCount && !rows.length) {
   statuses.push({...ruleSettings,status:'insufficient',count:0,eligibleCount:0,incompleteCount,reason:'当前账号缺少完整统计分组的数据权限'});
   continue;
  }
  let utilityEvidence:ReturnType<typeof plannedUtilityEvidence>=[];
  if(rule.scene==='planned_shutdown'){
   if(!actor.permissionCodes.includes('shutdown.read'))reason='缺少停供申请查询权限，不能核验计划停供证据';
   else {
    const stores=await eventRows(tx,"select content from gqxq_tender_support_store where store_key='utility-feed-real'");
    const feed=stores[0]?decodeContent<{sources:import('../domain/utilityFeed').MappedUtilitySource[]}>(stores[0].content):null;
    const sources=feed?.sources??[];
    if(sources.length>10000)throw AppError.validation('公共事业来源证据超过10000条');
    utilityEvidence=plannedUtilityEvidence(rows,sources);
    const ids=new Set(utilityEvidence.map(e=>e.complaintId));rows=rows.filter(r=>ids.has(r.complaintId));
    if(!rows.length)reason='该窗口缺少明确计划性质、审批通过且同企业/区县/网格/时段的公共事业真实来源证据';
   }
  }
  const counts='可判定 '+rows.length+' 件 / 缺字段 '+incompleteCount+' 件'+(capture.summary.partial?'；另有 '+capture.summary.dateFilterUnavailableCount+' 件业务日期不可用未计入':'')+(scopeExcludedCount?'；部分记录所在分组缺少完整权限':'');
  if(reason){statuses.push({...ruleSettings,status:'insufficient',count:rows.length,eligibleCount:rows.length,incompleteCount,reason:reason+'（'+counts+'）'});continue;}
  if(!rows.length){const gap=incompleteCount>0||capture.summary.partial?'字段覆盖不足':capture.rows.length?'窗口内无命中该规则分类/时段的记录，来源覆盖未认证':'窗口内无已接入记录，来源覆盖未认证';statuses.push({...ruleSettings,status:'insufficient',count:0,eligibleCount:0,incompleteCount,reason:counts+'：'+gap+'，不能判定正常'});continue;}
  const candidates=alertCandidates(rule,rows,from,day);for(const c of candidates){const evidence:AlertEvidence={...(utilityEvidence.length?{utilityEvidence:utilityEvidence.filter(e=>c.complaintIds.includes(e.complaintId))}:{}),scope,scene:rule.scene!,ruleName:rule.name,definitionBasis:rule.definitionBasis,dictionaryVersion:rule.dictionaryVersion,complaintIds:c.complaintIds,facts:rows.filter(r=>c.complaintIds.includes(r.complaintId)).map(r=>({complaintId:r.complaintId,editVersion:r.editVersion})),dataCutoffAt:capture.summary.dataCutoffAt};assertActive();const [result]=await tx.execute('insert ignore into business_alert(alert_id,rule_id,rule_version,window_from,window_to,enterprise_code,district_code,admin_grid_code,quantity,threshold_value,state,evidence,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',[c.alertId,rule.ruleId,rule.version,from,day,c.enterpriseCode,c.districtCode,c.adminGridCode,c.quantity,rule.threshold!,'open',JSON.stringify(evidence),new Date()]);created+=(result as {affectedRows:number}).affectedRows;}
  const triggered=candidates.length>0,coverageIncomplete=incompleteCount>0||capture.summary.partial||scopeExcludedCount>0;
  statuses.push({...ruleSettings,status:triggered?'triggered':'below_threshold',count:rows.length,eligibleCount:rows.length,incompleteCount,reason:triggered?(coverageIncomplete?counts+'：已达阈值，但仍有字段缺失，覆盖不完整':null):(coverageIncomplete?counts+'：未达阈值，且覆盖不完整，不能据此判定正常':counts+'：未达阈值')});
 }
 assertActive();await featureAudit(tx,actor,'BUSINESS_ALERT_EVALUATE','business_alert','batch',{day,created});return {created,statuses,unconfiguredScenes:['winter','summer','planned_shutdown','gas_three_piece'].filter(s=>!rules.some(r=>r.scene===s))};}

export async function alertHistory(id:string,ctx:BusinessEventContext){return withTransaction(async tx=>{const rows=await authorizedAlerts(tx,ctx,id,true);if(!rows.length)throw AppError.notFound('预警不存在');return eventRows(tx,'select action,notes,user_id,created_at from business_alert_action where alert_id=? order by created_at',[id]);});}
export async function actOnBusinessAlert(id:string,raw:unknown,ctx:BusinessEventContext){const input=raw as Record<string,unknown>;if(!input||Object.keys(input).some(k=>!['action','notes'].includes(k))||!['acknowledge','resolve'].includes(String(input.action))||typeof input.notes!=='string'||!input.notes.trim()||input.notes.length>2000)throw AppError.validation('处理动作及说明必填');return withTransaction(async tx=>{const actor=await currentFeatureActor(tx,ctx,'alert.handle');const rows=await authorizedAlerts(tx,actor,id,true);if(!rows.length)throw AppError.notFound('预警不存在');const current=(await eventRows(tx,'select state from business_alert where alert_id=? for update',[id]))[0];const next=input.action==='resolve'?'resolved':'acknowledged';if(current.state==='resolved'||current.state===next)throw AppError.conflict('预警已处理或确认');await tx.execute('insert into business_alert_action(action_id,alert_id,action,notes,user_id,created_at) values(?,?,?,?,?,?)',[randomUUID(),id,String(input.action),String(input.notes).trim(),actor.userId,new Date()]);await tx.execute('update business_alert set state=? where alert_id=?',[next,id]);await featureAudit(tx,actor,'BUSINESS_ALERT_ACTION','business_alert',id,{action:input.action});return {state:next};});}
