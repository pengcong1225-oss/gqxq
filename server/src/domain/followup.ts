import {z} from 'zod';
import {AppError} from '../http/errors';
import type {FollowupFacts,SourceEvaluationView} from '../types/api';
const nullableText=(max:number)=>z.string().trim().max(max).nullable().transform(v=>v||null);
const factsShape={contacted:z.boolean(),occurredAt:z.string().datetime({offset:true}).transform(v=>new Date(v).toISOString()),evaluationCode:z.enum(['satisfied','dissatisfied']).nullable(),dissatisfactionReason:nullableText(500),notes:nullableText(2000)};
const checkFacts=(v:FollowupFacts,ctx:z.RefinementCtx)=>{
 if(!v.contacted&&(v.evaluationCode!==null||v.dissatisfactionReason!==null))ctx.addIssue({code:'custom',path:['evaluationCode'],message:'未接通不能填写评价或不满意理由'});
 if(v.evaluationCode==='dissatisfied'&&!v.dissatisfactionReason)ctx.addIssue({code:'custom',path:['dissatisfactionReason'],message:'不满意理由必填'});
 if(v.evaluationCode!=='dissatisfied'&&v.dissatisfactionReason!==null)ctx.addIssue({code:'custom',path:['dissatisfactionReason'],message:'不满意理由仅用于不满意评价'});
};
const requestId=z.string().regex(/^[-A-Za-z0-9_.:]{1,128}$/);
const expectedVersion=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason=z.string().trim().min(1,'理由必填').max(500);
const factsSchema=z.object(factsShape).strict().superRefine(checkFacts);
const createSchema=z.object({...factsShape,requestId}).strict().superRefine(checkFacts);
const revisionSchema=z.object({...factsShape,requestId,expectedVersion,reason}).strict().superRefine(checkFacts);
const conclusionSchema=z.object({requestId,expectedVersion,reason,conclusion:z.string().trim().min(1).max(1000)}).strict();
function parse<T>(schema:z.ZodType<T>,input:unknown):T {const v=schema.safeParse(input);if(!v.success)throw AppError.validation('回访请求不合法',v.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));return v.data;}
export const parseFollowupFacts=(input:unknown)=>parse(factsSchema,input);
export const parseCreate=(input:unknown)=>parse(createSchema,input);
export const parseRevision=(input:unknown)=>parse(revisionSchema,input);
export const parseConclusion=(input:unknown)=>parse(conclusionSchema,input);
export const formalEvaluationState={state:'unavailable' as const,reason:'Q5 正式有效评价及来源优先规则未确认；回访事实和主管结论不代表正式满意率'};
/** Display a narrow known label from the ACTUAL import contract; never map it to a local code. */
export function sourceEvaluation(payload:unknown):SourceEvaluationView {
 let p=payload;if(typeof p==='string'){try{p=JSON.parse(p);}catch{p=null;}}
 const metadata=p&&typeof p==='object'&&!Array.isArray(p)?(p as Record<string,unknown>).metadata:null;
 const value=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?(metadata as Record<string,unknown>)['坐席满意度']:null;
 if(value===null||value===undefined||value==='')return {state:'unavailable',label:null,reason:'未留存来源坐席满意度',provenance:'来源导出 metadata.坐席满意度'};
 const labels=['满意','不满意','基本满意','非常满意','未评价'];
 return typeof value==='string'&&labels.includes(value)?{state:'available',label:value,reason:null,provenance:'来源导出 metadata.坐席满意度'}:{state:'withheld',label:null,reason:'来源原值无法安全展示；授权用户可通过来源原件查看',provenance:'来源导出 metadata.坐席满意度'};
}
/** Unapproved technical candidate, deliberately not a production official indicator. */
export function selectCandidateEvaluations<T extends {followupId:string;complaintId:string;version:number;contacted:boolean;evaluationCode:'satisfied'|'dissatisfied'|null;occurredAt:string;order:number}>(history:T[]):{policy:'candidate-unapproved';records:T[]} {
 const heads=new Map<string,T>();for(const row of history){const key=row.complaintId+'\0'+row.followupId;if((heads.get(key)?.version??0)<row.version)heads.set(key,row);}
 const records=new Map<string,T>();for(const row of [...heads.values()].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.order-b.order||a.followupId.localeCompare(b.followupId))){if(row.contacted&&row.evaluationCode!==null)records.set(row.complaintId,row);}
 return {policy:'candidate-unapproved',records:[...records.values()].sort((a,b)=>a.complaintId.localeCompare(b.complaintId))};
}
