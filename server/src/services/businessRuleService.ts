import {z} from 'zod';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {addDays,normalizeShanghaiDay,shanghaiToday} from '../domain/statisticsQuery';
import {eventRows} from '../repositories/sourceBusinessRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {currentFeatureActor,featurePermission} from './businessFeatureAuth';
import {validateCategoryInTx} from './categoryService';
import {readDictionaryItems,readDictionaryType} from './dictService';
import type {AlertBaselinePreview,AlertBaselineQueryInput,AlertBaselineSeason,AlertBaselineSnapshot,BusinessAlertScene,BusinessEventContext} from '../types/businessEvents';
import {resolveAlertScope} from '../domain/businessAlerts';
import {ALERT_MULTIPLIER_SUGGESTIONS,alertSeasonMonths,computeAlertBaseline,expectedAlertThreshold,freezeBusinessRuleBaseline} from '../domain/alertBaseline';
const code=z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,64}$/),day=z.string().refine(v=>{try{normalizeShanghaiDay(v);return true;}catch{return false;}});
const multiplier=z.number().finite().min(1).max(5).refine(v=>Math.abs(Math.round(v*100)-v*100)<1e-9,'倍数最多两位小数');
const baselineSnapshot=z.object({avgPerDay:z.number().finite().min(0).max(100000),windowBase:z.number().finite().min(0).max(1000000),baseDays:z.number().int().min(1).max(4000),daysFrom:day,daysTo:day}).strict();
const scene=z.enum(['winter','summer','planned_shutdown','gas_three_piece']);
const schema=z.object({ruleId:code,kind:z.enum(['seasonal','alert']),expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),name:z.string().trim().min(1).max(128),businessType:z.enum(['water','gas']),dictionaryVersion:z.string().regex(/^[1-9][0-9]*$/),majorCodes:z.array(code).max(100),minorCodes:z.array(code).max(100),effectiveFrom:day,effectiveTo:day,scene:scene.nullable(),startMonth:z.number().int().min(1).max(12).nullable(),endMonth:z.number().int().min(1).max(12).nullable(),threshold:z.number().int().min(1).max(100000).nullable(),windowDays:z.number().int().min(1).max(366).nullable(),definitionBasis:z.string().trim().min(1).max(2000),definitionConfirmed:z.boolean().default(false),scope:z.enum(['city','district','enterprise','grid']).default('city'),multiplier:multiplier.nullable().default(null),baseline:baselineSnapshot.nullable().default(null),enabled:z.boolean()}).strict().superRefine((v,c)=>{
 if(v.effectiveTo<v.effectiveFrom)c.addIssue({code:'custom',path:['effectiveTo'],message:'有效期无效'});
 if(!v.majorCodes.length&&!v.minorCodes.length)c.addIssue({code:'custom',path:['majorCodes'],message:'须选择正式分类'});
 if(v.kind==='seasonal'&&(!['winter','summer'].includes(v.scene??'')||!v.startMonth||!v.endMonth))c.addIssue({code:'custom',path:['scene'],message:'保障季须选择季节和月份'});
 if(v.kind==='alert'&&(!v.scene||!v.threshold||!v.windowDays))c.addIssue({code:'custom',path:['scene'],message:'预警须选择场景、阈值及窗口'});
 if(v.scene==='gas_three_piece'&&!v.definitionConfirmed)c.addIssue({code:'custom',path:['definitionConfirmed'],message:'三件套定义及分类映射须明确确认'});
 if(v.scene==='gas_three_piece'&&v.businessType!=='gas')c.addIssue({code:'custom',path:['businessType'],message:'燃气三件套须选择燃气'});
 if(v.kind==='seasonal'&&(v.multiplier!==null||v.baseline!==null))c.addIssue({code:'custom',path:['multiplier'],message:'仅预警规则可配置倍数与基线'});
 if(v.kind==='alert'&&v.multiplier===null&&v.baseline!==null)c.addIssue({code:'custom',path:['multiplier'],message:'配置基线必须同时配置倍数'});
 if(v.baseline&&v.baseline.daysFrom>v.baseline.daysTo)c.addIssue({code:'custom',path:['baseline','daysTo'],message:'基线日期区间无效'});
});
export type BusinessRule=z.infer<typeof schema>&{version:number};
export const decodeContent=<T>(v:unknown):T=>(typeof v==='string'?JSON.parse(v):v) as T;
const withAlertDefaults=(content:Omit<BusinessRule,'version'>)=>({...content,scope:resolveAlertScope(content.scope),multiplier:content.multiplier??null,baseline:content.baseline??null});
export async function publishedRules(db:Pick<Tx,'query'>,kind:string):Promise<BusinessRule[]>{const rows=await eventRows(db,'select v.content,v.version from business_rule_version v join (select rule_id,max(version) version from business_rule_version where kind=? group by rule_id) h on h.rule_id=v.rule_id and h.version=v.version',[kind]);return rows.map(r=>({...withAlertDefaults(decodeContent<Omit<BusinessRule,'version'>>(r.content)),version:Number(r.version)}));}
export async function featureAudit(tx:Tx,ctx:BusinessEventContext,action:string,bizType:string,bizId:string,detail:Record<string,unknown>){await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:'business.features',action,bizType,bizId,result:'success',clientIp:ctx.clientIp??null,detail,createdAt:new Date()});}
async function validateCategories(tx:Tx,input:Omit<BusinessRule,'version'>){const type=await readDictionaryType(tx,'complaint_category',true);if(!type?.published)throw AppError.validation('正式分类字典尚未发布');
 for(const majorCode of input.majorCodes)await validateCategoryInTx(tx,{majorCode,minorCode:null,dictionaryVersion:input.dictionaryVersion},{forNewSelection:true});
 const items=await readDictionaryItems(tx,'complaint_category',true);for(const minorCode of input.minorCodes){const minor=items.find(i=>i.code===minorCode);if(!minor?.parentCode)throw AppError.validation('小类不存在');await validateCategoryInTx(tx,{majorCode:minor.parentCode,minorCode,dictionaryVersion:input.dictionaryVersion},{forNewSelection:true});}
}
export async function listBusinessRules(ctx:BusinessEventContext){featurePermission(ctx,'business.rules.manage',true);const rows=await eventRows(pool,'select rule_id,kind,edit_version,content from business_rule where kind in (\'seasonal\',\'alert\') order by kind,rule_id');const published=await eventRows(pool,'select rule_id,version,published_at from business_rule_version order by version desc');return rows.map(r=>{const input=withAlertDefaults(decodeContent<Omit<BusinessRule,'version'>>(r.content));return {input,editVersion:Number(r.edit_version),publishedVersion:Number(published.find(p=>p.rule_id===r.rule_id)?.version??0)};});}
export function parseBusinessRule(raw:unknown){const p=schema.safeParse(raw);if(!p.success)throw AppError.validation('规则参数无效',p.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));return p.data;}

/* ---------------------------------------------------------------- 阈值基线 */
const ALERT_BASELINE_DEFAULT_DAYS=730,ALERT_BASELINE_MAX_DAYS=4000;
/** 默认基线窗口：截至今天（含）的近两年自然日；from/to 可显式指定。 */
export function alertBaselineRange(from?:string|null,to?:string|null):{from:string;to:string}{
 const today=shanghaiToday();
 let start=from??null,end=to??null;
 if(start!==null)normalizeShanghaiDay(start);if(end!==null)normalizeShanghaiDay(end);
 end=end??today;
 if(end>today)throw AppError.validation('基线截止日期不能晚于今天');
 start=start??addDays(end,1-ALERT_BASELINE_DEFAULT_DAYS);
 if(start>end)throw AppError.validation('基线起始日期不能晚于截止日期');
 if((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000+1>ALERT_BASELINE_MAX_DAYS)throw AppError.validation('基线区间不得超过 '+ALERT_BASELINE_MAX_DAYS+' 天');
 return {from:start,to:end};
}
function baselineDays(from:string,to:string){const days:string[]=[];for(let current=from;current<=to;current=addDays(current,1))days.push(current);return days;}
/** 保障季场景只用保障月份日期做基线；月份取自已发布保障季规则。 */
async function baselineSeason(db:Pick<Tx,'query'>,input:{scene:BusinessAlertScene|null;businessType:'water'|'gas'}):Promise<AlertBaselineSeason|null>{
 if(input.scene!=='winter'&&input.scene!=='summer')return null;
 const seasons=(await publishedRules(db,'seasonal')).filter(rule=>rule.enabled&&rule.scene===input.scene&&rule.businessType===input.businessType);
 if(seasons.length!==1)throw AppError.validation('保障季规则尚未发布或不唯一，无法计算保障季基线');
 const season=seasons[0];if(season.startMonth===null||season.endMonth===null)throw AppError.validation('保障季规则缺少月份，无法计算保障季基线');
 return {startMonth:season.startMonth,endMonth:season.endMonth,months:alertSeasonMonths(season.startMonth,season.endMonth)};
}
/** 按日取件数：宜接就办来源、deleted=0、source_reported_at 自然日（与复核脚本同口径）。 */
async function readDailyAlertCounts(db:Pick<Tx,'query'>,input:AlertBaselineQueryInput&{from:string;to:string}):Promise<Map<string,number>>{
 const params:unknown[]=[input.businessType,input.from,addDays(input.to,1)];
 const filters=["deleted=0","source_system='宜接就办'",'business_type=?','source_reported_at>=?','source_reported_at<?'];
 const categories:string[]=[];
 if(input.minorCodes.length){categories.push('minor_category_code in ('+input.minorCodes.map(()=>'?').join(',')+')');params.push(...input.minorCodes);}
 if(input.majorCodes.length){categories.push('major_category_code in ('+input.majorCodes.map(()=>'?').join(',')+')');params.push(...input.majorCodes);}
 if(categories.length)filters.push('('+categories.join(' or ')+')');
 if(input.dictionaryVersion!==null){filters.push('category_dictionary_version=?');params.push(input.dictionaryVersion);}
 const rows=await eventRows(db,"select date_format(source_reported_at,'%Y-%m-%d') as d, count(*) as n from complaint where "+filters.join(' and ')+' group by d',params);
 const counts=new Map<string,number>();for(const row of rows){const key=String(row.d??'').slice(0,10);if(!key)continue;counts.set(key,(counts.get(key)??0)+Number(row.n??0));}
 return counts;
}
export async function computeAlertBaselinePreview(db:Pick<Tx,'query'>,input:AlertBaselineQueryInput):Promise<AlertBaselinePreview>{
 const range=alertBaselineRange(input.from,input.to),season=await baselineSeason(db,input);
 const dailyCounts=await readDailyAlertCounts(db,{...input,...range});
 const baseline=computeAlertBaseline({dailyCounts,days:baselineDays(range.from,range.to),windowDays:input.windowDays,months:season?.months??null});
 return {...baseline,season,suggestions:ALERT_MULTIPLIER_SUGGESTIONS.map(item=>({multiplier:item,threshold:expectedAlertThreshold(baseline.windowBase,item)}))};
}
/** 保存/发布时由服务端按当前数据重算基线（客户端传入的 baseline 只作结构校验，不作为权威值）。 */
export async function computeRuleAlertBaseline(db:Pick<Tx,'query'>,input:Pick<BusinessRule,'businessType'|'minorCodes'|'majorCodes'|'dictionaryVersion'|'windowDays'|'scene'>):Promise<AlertBaselineSnapshot>{
 if(input.windowDays===null)throw AppError.validation('预警规则缺少窗口天数，无法计算基线');
 const preview=await computeAlertBaselinePreview(db,{businessType:input.businessType,minorCodes:input.minorCodes,majorCodes:input.majorCodes,dictionaryVersion:input.dictionaryVersion,windowDays:input.windowDays,scene:input.scene,from:null,to:null});
 return {avgPerDay:preview.avgPerDay,windowBase:preview.windowBase,baseDays:preview.baseDays,daysFrom:preview.daysFrom,daysTo:preview.daysTo};
}
export const baselineQuerySchema=z.object({businessType:z.enum(['water','gas']),minorCodes:z.array(code).max(100),majorCodes:z.array(code).max(100).optional().default([]),dictionaryVersion:z.string().regex(/^[1-9][0-9]*$/).optional(),windowDays:z.number().int().min(1).max(366),scene:scene.optional(),from:day.optional(),to:day.optional()}).strict().superRefine((v,c)=>{
 if(!v.minorCodes.length&&!v.majorCodes.length)c.addIssue({code:'custom',path:['minorCodes'],message:'须选择正式分类'});
 if(v.from&&v.to&&v.from>v.to)c.addIssue({code:'custom',path:['from'],message:'基线起始日期不能晚于截止日期'});
});
export function parseAlertBaselineQuery(raw:unknown):AlertBaselineQueryInput{
 const parsed=baselineQuerySchema.safeParse(raw);
 if(!parsed.success)throw AppError.validation('基线参数无效',parsed.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));
 return {businessType:parsed.data.businessType,minorCodes:parsed.data.minorCodes,majorCodes:parsed.data.majorCodes,dictionaryVersion:parsed.data.dictionaryVersion??null,windowDays:parsed.data.windowDays,scene:parsed.data.scene??null,from:parsed.data.from??null,to:parsed.data.to??null};
}
export async function previewAlertBaseline(raw:unknown,ctx:BusinessEventContext){const input=parseAlertBaselineQuery(raw);featurePermission(ctx,'business.rules.manage',true);return computeAlertBaselinePreview(pool,input);}

/* ---------------------------------------------------------------- 保存/发布 */
export async function saveBusinessRule(raw:unknown,ctx:BusinessEventContext){const input=parseBusinessRule(raw);
 return withTransaction(async tx=>{const actor=await currentFeatureActor(tx,ctx,'business.rules.manage',true);await tx.execute('insert ignore into business_rule(rule_id,kind,edit_version,content) values(?,?,0,?)',[input.ruleId,input.kind,JSON.stringify(input)]);const row=(await eventRows(tx,'select kind,edit_version from business_rule where rule_id=? for update',[input.ruleId]))[0];if(Number(row.edit_version)!==input.expectedVersion||row.kind!==input.kind)throw AppError.conflict('规则版本或种类已变化');
  // 基线由服务端按当前数据重算并冻结；阈值必须等于 ceil(常态窗口量×倍数)，否则 400 要求先重算。
  const frozen=freezeBusinessRuleBaseline(input,input.kind==='alert'&&input.multiplier!==null?await computeRuleAlertBaseline(tx,input):null);
  const version=input.expectedVersion+1;await tx.execute('update business_rule set edit_version=?,content=? where rule_id=?',[version,JSON.stringify(frozen),input.ruleId]);await featureAudit(tx,actor,'BUSINESS_RULE_SAVE','business_rule',input.ruleId,{version});return {editVersion:version};});
}
export async function publishBusinessRule(id:string,expectedVersion:number,ctx:BusinessEventContext){return withTransaction(async tx=>{const actor=await currentFeatureActor(tx,ctx,'business.rules.manage',true);const row=(await eventRows(tx,'select kind,edit_version,content from business_rule where rule_id=? for update',[id]))[0];if(!row)throw AppError.notFound('规则不存在');if(Number(row.edit_version)!==expectedVersion||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw AppError.conflict('草稿版本变化');
 const input={...withAlertDefaults(decodeContent<Omit<BusinessRule,'version'>>(row.content))};
 if(input.enabled)await validateCategories(tx,input);
 // 发布时沿用保存时冻结的基线（可复现）；历史草稿缺基线才按当前数据补算并校验阈值。
 if(input.kind==='alert'&&input.multiplier!==null){const frozen=freezeBusinessRuleBaseline(input,input.baseline??await computeRuleAlertBaseline(tx,input));input.baseline=frozen.baseline;}else input.baseline=null;
 if(input.kind==='seasonal'&&(await publishedRules(tx,'seasonal')).some(r=>r.ruleId!==id&&r.enabled&&r.scene===input.scene&&r.businessType===input.businessType))throw AppError.conflict('同一季节与业务已有有效规则，须先停用原规则');
 await tx.execute('insert into business_rule_version(rule_id,version,kind,content,published_by,published_at) values(?,?,?,?,?,?)',[id,expectedVersion,input.kind,JSON.stringify(input),actor.userId,new Date()]);await tx.execute('update business_rule set edit_version=edit_version+1 where rule_id=?',[id]);await featureAudit(tx,actor,'BUSINESS_RULE_PUBLISH','business_rule',id,{version:expectedVersion});return {version:expectedVersion,editVersion:expectedVersion+1};});}
