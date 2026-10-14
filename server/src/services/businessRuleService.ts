import {z} from 'zod';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {normalizeShanghaiDay} from '../domain/statisticsQuery';
import {eventRows} from '../repositories/sourceBusinessRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {currentFeatureActor,featurePermission} from './businessFeatureAuth';
import {validateCategoryInTx} from './categoryService';
import {readDictionaryItems,readDictionaryType} from './dictService';
import type {BusinessEventContext} from '../types/businessEvents';
const code=z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,64}$/),day=z.string().refine(v=>{try{normalizeShanghaiDay(v);return true;}catch{return false;}});
const schema=z.object({ruleId:code,kind:z.enum(['restoration','seasonal','alert']),expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),name:z.string().trim().min(1).max(128),businessType:z.enum(['water','gas']),dictionaryVersion:z.string().regex(/^[1-9][0-9]*$/),majorCodes:z.array(code).max(100),minorCodes:z.array(code).max(100),effectiveFrom:day,effectiveTo:day,scene:z.enum(['winter','summer','planned_shutdown','gas_three_piece']).nullable(),startMonth:z.number().int().min(1).max(12).nullable(),endMonth:z.number().int().min(1).max(12).nullable(),threshold:z.number().int().min(1).max(100000).nullable(),windowDays:z.number().int().min(1).max(366).nullable(),definitionBasis:z.string().trim().min(1).max(2000),definitionConfirmed:z.boolean().default(false),enabled:z.boolean()}).strict().superRefine((v,c)=>{
 if(v.effectiveTo<v.effectiveFrom)c.addIssue({code:'custom',path:['effectiveTo'],message:'有效期无效'});
 if(!v.majorCodes.length&&!v.minorCodes.length)c.addIssue({code:'custom',path:['majorCodes'],message:'须选择正式分类'});
 if(v.kind==='seasonal'&&(!['winter','summer'].includes(v.scene??'')||!v.startMonth||!v.endMonth))c.addIssue({code:'custom',path:['scene'],message:'保障季须选择季节和月份'});
 if(v.kind==='alert'&&(!v.scene||!v.threshold||!v.windowDays))c.addIssue({code:'custom',path:['scene'],message:'预警须选择场景、阈值及窗口'});
 if(v.scene==='gas_three_piece'&&!v.definitionConfirmed)c.addIssue({code:'custom',path:['definitionConfirmed'],message:'三件套定义及分类映射须明确确认'});
 if(v.scene==='gas_three_piece'&&v.businessType!=='gas')c.addIssue({code:'custom',path:['businessType'],message:'燃气三件套须选择燃气'});
});
export type BusinessRule=z.infer<typeof schema>&{version:number};
export const decodeContent=<T>(v:unknown):T=>(typeof v==='string'?JSON.parse(v):v) as T;
export async function publishedRules(db:Pick<Tx,'query'>,kind:string):Promise<BusinessRule[]>{const rows=await eventRows(db,'select v.content,v.version from business_rule_version v join (select rule_id,max(version) version from business_rule_version where kind=? group by rule_id) h on h.rule_id=v.rule_id and h.version=v.version',[kind]);return rows.map(r=>({...decodeContent<Omit<BusinessRule,'version'>>(r.content),version:Number(r.version)}));}
export async function featureAudit(tx:Tx,ctx:BusinessEventContext,action:string,bizType:string,bizId:string,detail:Record<string,unknown>){await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:'business.features',action,bizType,bizId,result:'success',clientIp:ctx.clientIp??null,detail,createdAt:new Date()});}
async function validateCategories(tx:Tx,input:BusinessRule){const type=await readDictionaryType(tx,'complaint_category',true);if(!type?.published)throw AppError.validation('正式分类字典尚未发布');
 for(const majorCode of input.majorCodes)await validateCategoryInTx(tx,{majorCode,minorCode:null,dictionaryVersion:input.dictionaryVersion},{forNewSelection:true});
 const items=await readDictionaryItems(tx,'complaint_category',true);for(const minorCode of input.minorCodes){const minor=items.find(i=>i.code===minorCode);if(!minor?.parentCode)throw AppError.validation('小类不存在');await validateCategoryInTx(tx,{majorCode:minor.parentCode,minorCode,dictionaryVersion:input.dictionaryVersion},{forNewSelection:true});}
}
export async function listBusinessRules(ctx:BusinessEventContext){featurePermission(ctx,'business.rules.manage',true);const rows=await eventRows(pool,'select rule_id,kind,edit_version,content from business_rule order by kind,rule_id');const published=await eventRows(pool,'select rule_id,version,published_at from business_rule_version order by version desc');return rows.map(r=>({input:decodeContent<BusinessRule>(r.content),editVersion:Number(r.edit_version),publishedVersion:Number(published.find(p=>p.rule_id===r.rule_id)?.version??0)}));}
export async function saveBusinessRule(raw:unknown,ctx:BusinessEventContext){const p=schema.safeParse(raw);if(!p.success)throw AppError.validation('规则参数无效',p.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));const input=p.data;
 return withTransaction(async tx=>{const actor=await currentFeatureActor(tx,ctx,'business.rules.manage',true);await tx.execute('insert ignore into business_rule(rule_id,kind,edit_version,content) values(?,?,0,?)',[input.ruleId,input.kind,JSON.stringify(input)]);const row=(await eventRows(tx,'select kind,edit_version from business_rule where rule_id=? for update',[input.ruleId]))[0];if(Number(row.edit_version)!==input.expectedVersion||row.kind!==input.kind)throw AppError.conflict('规则版本或种类已变化');const version=input.expectedVersion+1;await tx.execute('update business_rule set edit_version=?,content=? where rule_id=?',[version,JSON.stringify(input),input.ruleId]);await featureAudit(tx,actor,'BUSINESS_RULE_SAVE','business_rule',input.ruleId,{version});return {editVersion:version};});
}
export async function publishBusinessRule(id:string,expectedVersion:number,ctx:BusinessEventContext){return withTransaction(async tx=>{const actor=await currentFeatureActor(tx,ctx,'business.rules.manage',true);const row=(await eventRows(tx,'select kind,edit_version,content from business_rule where rule_id=? for update',[id]))[0];if(!row)throw AppError.notFound('规则不存在');if(Number(row.edit_version)!==expectedVersion||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw AppError.conflict('草稿版本变化');const input=decodeContent<BusinessRule>(row.content);if(input.enabled)await validateCategories(tx,input);
 if(input.kind==='seasonal'&&(await publishedRules(tx,'seasonal')).some(r=>r.ruleId!==id&&r.enabled&&r.scene===input.scene&&r.businessType===input.businessType))throw AppError.conflict('同一季节与业务已有有效规则，须先停用原规则');
 await tx.execute('insert into business_rule_version(rule_id,version,kind,content,published_by,published_at) values(?,?,?,?,?,?)',[id,expectedVersion,input.kind,JSON.stringify(input),actor.userId,new Date()]);await tx.execute('update business_rule set edit_version=edit_version+1 where rule_id=?',[id]);await featureAudit(tx,actor,'BUSINESS_RULE_PUBLISH','business_rule',id,{version:expectedVersion});return {version:expectedVersion,editVersion:expectedVersion+1};});}
