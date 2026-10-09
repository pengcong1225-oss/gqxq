import {randomUUID,createHash} from 'node:crypto';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import type {MasterDataContext} from '../types/masterData';
import type {SqlExecutor} from '../repositories/userRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import {heatCategoryKey,heatJson,readHeatDraft,readHeatConfirmation,readPublishedHeat} from '../repositories/heatRuleRepo';
import {parseHeatDraft,completeHeatPolicy,validateConfirmation,evaluateHeat,type HeatDraftInput,type HeatConfirmation,type HeatBoundaryPolicy} from '../domain/heatRule';
import {validateCategoryInTx,CATEGORY_TYPE} from './categoryService';
import {readDictionaryType} from './dictService';
import {insertAudit} from '../repositories/auditLogRepo';
import {captureStatisticsIn,assertStatisticsPermission,type StatisticsCapture} from './statisticsService';
import {normalizeStatisticsQuery,dayCount,shanghaiToday} from '../domain/statisticsQuery';
import type {StatisticsQuery} from '../types/statistics';
const manage=(ctx:MasterDataContext)=>{if(!ctx.userId||!ctx.permissionCodes.includes('heatmap.manage'))throw AppError.forbidden();};
async function audit(db:Tx,ctx:MasterDataContext,action:string,id:string,input:HeatDraftInput,version:number,publishedVersion?:string){await insertAudit(db,{userId:ctx.userId,appCode:'gqxq',resourceCode:'heat_rule',action,bizType:'heat_rule',bizId:id,result:'success',clientIp:ctx.clientIp,createdAt:new Date(),detail:{ruleId:id,majorCode:input.category.majorCode,minorCode:input.category.minorCode,dictionaryVersion:input.category.dictionaryVersion,version,policyId:input.policyId,policyVersion:input.policyVersion,effectiveFrom:input.effectiveFrom,...(publishedVersion?{publishedVersion}:{})}});}
export async function saveHeatDraft(raw:unknown,ctx:MasterDataContext){manage(ctx);const input=parseHeatDraft(raw);return withTransaction(async tx=>{
 await validateCategoryInTx(tx,input.category,{forNewSelection:true});const type=await readDictionaryType(tx,CATEGORY_TYPE);if(!type?.published)throw AppError.validation('正式分类类型尚未发布');
 const key=heatCategoryKey(input.category.majorCode,input.category.minorCode);
 await tx.execute('insert ignore into heat_rule_head(category_key) values(?)',[key]);await rowsIn(tx,'select category_key from heat_rule_head where category_key=? for update',[key]);
 const before=await readHeatDraft(tx,input.ruleId,true);if((before?.editVersion??0)!==input.expectedVersion)throw AppError.conflict('草稿版本已变化');if(before&&before.categoryKey!==key)throw AppError.conflict('规则稳定分类不可改绑，请另建草稿');
 const other=await rowsIn(tx,'select rule_id from heat_rule_draft where category_key=?',[key]);if(other.length&&other[0].rule_id!==input.ruleId)throw AppError.conflict('该分类已有草稿');
 const policy=JSON.stringify(input.policy);const fingerprint=createHash('sha256').update(policy).digest('hex');
 await tx.execute('insert ignore into heat_policy_version(policy_id,policy_version,fingerprint,content) values(?,?,?,?)',[input.policyId,input.policyVersion,fingerprint,policy]);
 const existing=(await rowsIn(tx,'select fingerprint from heat_policy_version where policy_id=? and policy_version=? for share',[input.policyId,input.policyVersion]))[0];if(existing?.fingerprint!==fingerprint)throw AppError.conflict('政策版本内容不可修改，请递增政策版本');
 const stored={...input,expectedVersion:0};if(before&&JSON.stringify({...before.input,expectedVersion:0})===JSON.stringify(stored))return {...before,changed:false,approvalStatus:validateConfirmation(await readHeatConfirmation(tx,input.policyId,input.policyVersion),input.policyVersion,input.policy)?'confirmed' as const:'unconfirmed' as const};
 if((before?.editVersion??0)>=Number.MAX_SAFE_INTEGER)throw AppError.conflict('草稿版本达到容量上限');const version=(before?.editVersion??0)+1;await tx.execute('insert into heat_rule_draft(rule_id,category_key,edit_version,content) values(?,?,?,?) on duplicate key update edit_version=values(edit_version),content=values(content)',[input.ruleId,key,version,JSON.stringify(stored)]);
 await audit(tx,ctx,'HEAT_DRAFT_SAVE',input.ruleId,input,version);return {ruleId:input.ruleId,editVersion:version,input:stored,changed:true,approvalStatus:validateConfirmation(await readHeatConfirmation(tx,input.policyId,input.policyVersion),input.policyVersion,input.policy)?'confirmed' as const:'unconfirmed' as const};
 });}
export interface FrozenHeatRule {formatVersion:1;rule:HeatDraftInput&{version:string};policy:HeatBoundaryPolicy;confirmation:HeatConfirmation}
export async function publishHeatDraft(id:string,expectedVersion:number,ctx:MasterDataContext,clock:()=>Date=()=>new Date()){
 manage(ctx);if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=Number.MAX_SAFE_INTEGER)throw AppError.validation('发布须提供草稿版本');
 return withTransaction(async tx=>{
  const found=await readHeatDraft(tx,id);if(!found)throw AppError.notFound('草稿不存在');await validateCategoryInTx(tx,found.input.category,{forNewSelection:true});if(!(await readDictionaryType(tx,CATEGORY_TYPE))?.published)throw AppError.validation('分类类型尚未发布');await rowsIn(tx,'select category_key from heat_rule_head where category_key=? for update',[found.categoryKey]);
  const draft=await readHeatDraft(tx,id,true);if(!draft||draft.editVersion!==expectedVersion)throw AppError.conflict('草稿版本已变化');const input=parseHeatDraft({...draft.input,expectedVersion});
  const policy=completeHeatPolicy(input.policy);const confirmation=await readHeatConfirmation(tx,input.policyId,input.policyVersion);if(!policy)throw AppError.validation('候选政策未完整选择或不自洽：upper 须 belowFirst=green，lower 须 top=red');if(!validateConfirmation(confirmation,input.policyVersion,policy))throw AppError.conflict('Q7 政策未确认或确认版本不匹配，不可发布');
  if(input.effectiveFrom<shanghaiToday(clock))throw AppError.conflict('不得追溯到已完成业务日');
  const last=(await rowsIn(tx,'select effective_from from heat_rule_published where category_key=? order by effective_from desc limit 1 for update',[draft.categoryKey]))[0];
  const day=(v:unknown)=>v instanceof Date?v.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):String(v).slice(0,10);if(last&&input.effectiveFrom<=day(last.effective_from))throw AppError.conflict('发布开始日须严格晚于已有最大开始日');
  const version='HEAT-'+randomUUID();const frozen:FrozenHeatRule={formatVersion:1,rule:{...input,expectedVersion:0,version},policy,confirmation:confirmation!};
  await tx.execute('insert into heat_rule_published(version_id,category_key,effective_from,content,published_by,published_at) values(?,?,?,?,?,?)',[version,draft.categoryKey,input.effectiveFrom,JSON.stringify(frozen),ctx.userId,clock()]);
  await tx.execute('update heat_rule_draft set edit_version=edit_version+1 where rule_id=?',[id]);await audit(tx,ctx,'HEAT_RULE_PUBLISH',id,input,expectedVersion+1,version);return {version,editVersion:expectedVersion+1};
 });
}
/** Internal D3 same-snapshot freeze API: no source facts, no current-policy reread. */
export async function freezeHeatRuleIn(db:SqlExecutor,version:string):Promise<FrozenHeatRule>{const row=(await rowsIn(db,'select content from heat_rule_published where version_id=?',[version]))[0];if(!row)throw AppError.notFound('发布版本不存在');return heatJson<FrozenHeatRule>(row.content);}
export async function freezeHeatRule(version:string,ctx:MasterDataContext){manage(ctx);return freezeHeatRuleIn(pool,version);}
export async function listHeatDrafts(ctx:MasterDataContext){manage(ctx);const rows=await rowsIn(pool,'select rule_id,edit_version,content from heat_rule_draft order by rule_id');return Promise.all(rows.map(async r=>{const input=heatJson<HeatDraftInput>(r.content);const c=await readHeatConfirmation(pool,input.policyId,input.policyVersion);return {ruleId:String(r.rule_id),editVersion:Number(r.edit_version),input,approvalStatus:validateConfirmation(c,input.policyVersion,input.policy)?'confirmed':'unconfirmed'};}));}
export async function previewHeatDraft(id:string,raw:unknown,ctx:MasterDataContext){
 manage(ctx);
 const {z}=await import('zod');
 const sample={count:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),days:z.number().int().positive().max(3660)};
 const parsed=z.union([
  z.object({...sample,expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),
  z.object({...sample,version:z.string().min(1)}).strict()
 ]).safeParse(raw);
 if(!parsed.success)throw AppError.validation('预览需要明确数量、计日及草稿版本或发布版本');
 if('version' in parsed.data){
  const frozen=await freezeHeatRuleIn(pool,parsed.data.version);
  if(frozen.rule.ruleId!==id)throw AppError.validation('发布版本不属于该规则');
  return {...evaluateHeat({...parsed.data,rule:frozen.rule,policy:frozen.policy}),candidate:true,policyId:frozen.rule.policyId,policyVersion:frozen.rule.policyVersion};
 }
 const draft=await readHeatDraft(pool,id);
 if(!draft)throw AppError.notFound('草稿不存在');
 if(draft.editVersion!==parsed.data.expectedVersion)throw AppError.conflict('草稿版本已变化，请重新读取后预览');
 return {
  ...evaluateHeat({...parsed.data,rule:{version:'draft:'+draft.editVersion,coefficients:draft.input.coefficients},policy:draft.input.policy}),
  candidate:true,approvalStatus:'unconfirmed',policyId:draft.input.policyId,policyVersion:draft.input.policyVersion
 };
}
function selectedCategory(q:StatisticsQuery,rows:StatisticsCapture['rows']):{majorCode:string;minorCode:string|null}|null {
 const bucket=q.bucket?.dimension==='category'?q.bucket:null;const minor=q.minorCode??(bucket?.level==='minor'?bucket.code??undefined:undefined);const major=q.majorCode??(bucket?.level==='major'?bucket.code??undefined:undefined);
 if(minor){const majors=new Set(rows.filter(r=>r.minorCode===minor&&r.majorCode).map(r=>r.majorCode!));if(major)return {majorCode:major,minorCode:minor};if(majors.size===1)return {majorCode:[...majors][0],minorCode:minor};return null;}
 return major?{majorCode:major,minorCode:null}:null;
}
export function buildHeatData(capture:StatisticsCapture,rules:FrozenHeatRule[],detail:boolean){
 const q=capture.summary.query,category=selectedCategory(q,capture.rows),days=dayCount(q.from,q.to);
 let frozen=category?rules.find(r=>r.rule.category.majorCode===category.majorCode&&r.rule.category.minorCode===category.minorCode):undefined;
 if(!frozen&&category?.minorCode){
  frozen=rules.find(r=>r.rule.category.majorCode===category.majorCode&&r.rule.category.minorCode===null&&r.policy.classFallback==='minor_then_major');
 }
 const seen=new Set<string>();
 const rows=capture.rows.filter(r=>{
  if(seen.has(r.complaintId))return false;
  seen.add(r.complaintId);
  return true;
 });
 const memberships=new Map<string,Set<string>>();
 const grids=new Map<string,{
  code:string;count:number;
  coverages:{version:string;selectedBusinessDays:string[];geometrySources:string[];validFrom:string|null;validTo:string|null;geometry:StatisticsCapture['coverageEvidence'][number]['coverage']['geometry'];coordinateSystem:string|null}[]
 }>();
 for(const e of capture.coverageEvidence){
  const selectedBusinessDays=e.selectedBusinessDays.filter(d=>d>=q.from&&d<=q.to);
  if(!selectedBusinessDays.length)continue;
  const mask=memberships.get(e.coverage.code)??new Set<string>();
  for(const d of selectedBusinessDays)mask.add(d);
  memberships.set(e.coverage.code,mask);
  const g=grids.get(e.coverage.code)??{code:e.coverage.code,count:0,coverages:[]};
  g.coverages.push({version:e.coverage.version,selectedBusinessDays,geometry:e.coverage.geometry,coordinateSystem:e.coverage.coordinateSystem,geometrySources:e.coverage.geometrySources,validFrom:e.coverage.validFrom,validTo:e.coverage.validTo});
  grids.set(g.code,g);
 }
 for(const r of rows){
  for(const code of new Set(r.grids)){
   const g=grids.get(code);
   if(g&&r.businessDay&&memberships.get(code)?.has(r.businessDay))g.count++;
  }
 }
 const available=frozen&&validateConfirmation(frozen.confirmation,frozen.rule.policyVersion,frozen.policy)?frozen:undefined;
 // Match D1's CRS/source eligibility. A sourced point can still have no historic grid match.
 const points=detail?rows.filter(r=>
  r.longitude!==null&&r.latitude!==null&&Number.isFinite(r.longitude)&&Number.isFinite(r.latitude)&&
  Math.abs(r.longitude)<=180&&Math.abs(r.latitude)<=90&&r.coordinateSystem==='WGS84'&&Boolean(r.coordinateSource)
 ).map(r=>({
  complaintId:r.complaintId,longitude:r.longitude!,latitude:r.latitude!,
  grids:r.grids.filter(code=>r.businessDay&&memberships.get(code)?.has(r.businessDay))
 })):[];
 return {
  query:q,total:capture.summary.total,unlocatedCount:capture.summary.unlocatedCount,dataCutoffAt:capture.summary.dataCutoffAt,
  statisticsPolicy:capture.summary.policy,partial:capture.summary.partial,excludedByReason:capture.summary.excludedByReason,
  selectionDate:q.to,ruleSelection:'query_end' as const,days,category,nonAdditive:true as const,
  grids:[...grids.values()].map(g=>({
   ...g,
   ...(category?evaluateHeat({count:g.count,days,rule:available?.rule??null,policy:available?.policy}):{level:null,reason:'CATEGORY_SELECTION_REQUIRED',ruleVersion:null}),
   policyId:available?.rule.policyId??null,policyVersion:available?.rule.policyVersion??null
  })),
  points
 };
}
export async function captureHeatIn(db:SqlExecutor,q:StatisticsQuery,ctx:MasterDataContext,clock:()=>Date=()=>new Date()){
 if(!ctx.permissionCodes.includes('heatmap.read'))throw AppError.forbidden();const capture=await captureStatisticsIn(db,q,ctx.access,ctx.permissionCodes,clock);const category=selectedCategory(q,capture.rows);const rules:FrozenHeatRule[]=[];
 if(category){for(const minor of category.minorCode?[category.minorCode,null]:[null]){const row=await readPublishedHeat(db,heatCategoryKey(category.majorCode,minor),q.to);if(row)rules.push(heatJson<FrozenHeatRule>(row.content));}}
 return {data:buildHeatData(capture,rules,ctx.permissionCodes.includes('complaint.read')),statistics:capture,rules};
}
export async function getHeatData(raw:Record<string,unknown>,ctx:MasterDataContext,clock:()=>Date=()=>new Date()){
 const q=normalizeStatisticsQuery(raw,ctx.access,clock);if(!ctx.permissionCodes.includes('heatmap.read'))throw AppError.forbidden();assertStatisticsPermission(q,ctx.permissionCodes);const conn=await pool.getConnection();try{await conn.query('set transaction isolation level repeatable read');await conn.query('start transaction with consistent snapshot, read only');return (await captureHeatIn(conn,q,ctx,clock)).data;}finally{try{await conn.rollback();}finally{conn.release();}}
}
