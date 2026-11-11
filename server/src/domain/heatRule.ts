import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '../http/errors';
import {categoryRefSchema} from '../services/categoryService';
import {normalizeShanghaiDay} from './statisticsQuery';
export const HEAT_LEVELS=['green','blue','yellow','orange','red'] as const;
export type HeatLevel=typeof HEAT_LEVELS[number];
export const heatPolicySchema=z.object({anchor:z.enum(['lower','upper']),endpointOwner:z.enum(['lower','upper']),zero:z.enum(['green','null']),belowFirst:z.enum(['green','null']),top:z.enum(['red','null']),day:z.literal('shanghai_inclusive'),classFallback:z.enum(['exact_only','minor_then_major']),noRule:z.literal('null'),ruleSelection:z.literal('query_end')}).strict();
export type HeatBoundaryPolicy=z.infer<typeof heatPolicySchema>;
export function coefficientUnits(value:unknown):bigint {
 if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$/.test(value))throw AppError.validation('系数须为非负十进制字符串，最多18位整数与两位小数');
 const [whole,fraction='']=value.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
export function validateCoefficients(values:unknown):string[]{
 if(!Array.isArray(values)||values.length!==5)throw AppError.validation('绿蓝黄橙红须有五个系数');
 const units=values.map(coefficientUnits);if(units.some((n,i)=>i>0&&n<=units[i-1]))throw AppError.validation('五档系数必须严格递增');return values as string[];
}
export function completeHeatPolicy(raw:unknown):HeatBoundaryPolicy|null {const p=heatPolicySchema.safeParse(raw);return p.success&&!(p.data.anchor==='upper'&&p.data.belowFirst!=='green')&&!(p.data.anchor==='lower'&&p.data.top!=='red')?p.data:null;}
export function policyFingerprint(policy:HeatBoundaryPolicy):string {const p=heatPolicySchema.parse(policy);return createHash('sha256').update(JSON.stringify(p)).digest('hex');}
const key=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const draftSchema=z.object({ruleId:key,category:categoryRefSchema,coefficients:z.array(z.string()),policyId:key,policyVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),policy:heatPolicySchema.partial(),effectiveFrom:z.string(),expectedVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export type HeatDraftInput=z.infer<typeof draftSchema>;
/** Tender §1.1.9. Boundary details are explicit and frozen in each new version. */
export const TENDER_HEAT_POLICY_ID='TENDER_1_1_9_V1';
export const TENDER_HEAT_POLICY:HeatBoundaryPolicy=Object.freeze({anchor:'upper',endpointOwner:'lower',zero:'green',belowFirst:'green',top:'red',day:'shanghai_inclusive',classFallback:'minor_then_major',noRule:'null',ruleSelection:'query_end'});
const tenderRuleSchema=z.object({ruleId:key.optional(),category:categoryRefSchema,coefficients:z.array(z.string()),expectedVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-2)}).strict();
export function parseTenderHeatRule(raw:unknown){
 const parsed=tenderRuleSchema.safeParse(raw);
 if(!parsed.success)throw AppError.validation('请选择诉求类别并填写五档系数',parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));
 validateCoefficients(parsed.data.coefficients);
 if(parsed.data.expectedVersion>0&&!parsed.data.ruleId)throw AppError.validation('修改规则需要原规则及编辑版本');
 return parsed.data;
}
export function nextHeatEffectiveDay(today:string,last:string|null):string {
 normalizeShanghaiDay(today);if(!last||last<today)return today;
 normalizeShanghaiDay(last);const day=new Date(last+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+1);return day.toISOString().slice(0,10);
}
export function tenderHeatConfirmation():HeatConfirmation {
 // Illustrative coefficients prove the algorithm; these are never saved as category defaults.
 const coefficients=['1','5','10','20','30'];
 const cases:[number,HeatLevel][]=[[0,'green'],[30,'green'],[31,'blue'],[150,'blue'],[151,'yellow'],[300,'yellow'],[301,'orange'],[450,'orange'],[600,'orange'],[601,'red'],[900,'red'],[901,'red']];
 return {policyVersion:1,fingerprint:policyFingerprint(TENDER_HEAT_POLICY),truthTable:cases.map(([count,level])=>({count,days:30,coefficients:[...coefficients],level})),evidenceRef:'招标文件1.1.9：阈值=天数×系数，区间取较大阈值颜色；边界约定：等于阈值归较低档、零值绿色、超顶红色、小类优先回退大类、无规则不设等级。'};
}
export function parseHeatDraft(raw:unknown):HeatDraftInput {const parsed=draftSchema.safeParse(raw);if(!parsed.success)throw AppError.validation('热力草稿参数无效',parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));validateCoefficients(parsed.data.coefficients);normalizeShanghaiDay(parsed.data.effectiveFrom);return parsed.data;}
export interface HeatRuleValue {version:string;coefficients:string[]}
export function evaluateHeat({count,days,rule,policy}:{count:number;days:number;rule:HeatRuleValue|null;policy:unknown}):{level:HeatLevel|null;reason:string|null;ruleVersion:string|null}{
 const result=(level:HeatLevel|null,reason:string|null=null)=>({level,reason,ruleVersion:rule?.version??null});
 if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(days)||days<1)throw AppError.validation('数量须为非负安全整数，计日须为正安全整数');
 if(!rule)return result(null,'UNCONFIGURED');const p=completeHeatPolicy(policy);if(!p)return result(null,heatPolicySchema.safeParse(policy).success?'POLICY_INCOHERENT':'POLICY_INCOMPLETE');
 const thresholds=validateCoefficients(rule.coefficients).map(c=>coefficientUnits(c)*BigInt(days));const x=BigInt(count)*100n;
 if(count===0)return result(p.zero==='green'?'green':null,p.zero==='null'?'ZERO_UNCLASSIFIED':null);
 if(p.anchor==='upper'){
  const index=thresholds.findIndex(t=>x<t||x===t&&p.endpointOwner==='lower');
  if(index>=0)return result(HEAT_LEVELS[index]);return result(p.top==='red'?'red':null,p.top==='null'?'ABOVE_TOP':null);
 }
 let index=-1;for(let i=0;i<5;i++)if(x>thresholds[i]||x===thresholds[i]&&p.endpointOwner==='upper')index=i;
 if(index<0)return result(p.belowFirst==='green'?'green':null,p.belowFirst==='null'?'BELOW_FIRST':null);
 if(x>thresholds[4]&&p.top==='null')return result(null,'ABOVE_TOP');return result(HEAT_LEVELS[index]);
}
export interface HeatConfirmation {policyVersion:number;fingerprint:string;truthTable:{count:number;days:number;coefficients:string[];level:HeatLevel|null}[];evidenceRef:string}
export function validateConfirmation(record:HeatConfirmation|null,version:number,policy:unknown):boolean {
 const p=completeHeatPolicy(policy);if(!p||!record||record.policyVersion!==version||record.fingerprint!==policyFingerprint(p)||!record.evidenceRef?.trim()||!Array.isArray(record.truthTable)||!record.truthTable.length)return false;
 try{return record.truthTable.every(r=>evaluateHeat({count:r.count,days:r.days,rule:{version:'confirmation',coefficients:r.coefficients},policy:p}).level===r.level);}catch{return false;}
}
