import {z} from 'zod';

const id=z.union([z.string().trim().min(1).max(64),z.number().int().positive()]).transform(String);
const nullableText=(max:number)=>z.string().max(max).nullable().optional();
export const puEnterpriseSchema=z.object({
 feedId:z.number().int().positive(),sourceKind:z.literal('company'),sourceId:id,sourceEnterpriseId:z.string().regex(/^PU-COMPANY-\d+$/),gqxqSubjectCode:z.string().regex(/^PU-COMPANY-\d+$/),
 sourceSubjectId:id.nullable().optional(),sourceAppCode:nullableText(64),organizationCode:nullableText(128),
 companyName:z.string().trim().min(1).max(128),businessTypes:z.array(z.enum(['water','gas','lpg'])).min(1).max(3),creditCode:nullableText(64),status:z.enum(['enabled','disabled','unknown']),
 dataMode:z.enum(['real','simulation']),revision:z.string().min(1).max(128),
 subjectAliases:z.array(z.object({subjectId:id,sourceAppCode:nullableText(64),subjectCode:nullableText(128),status:nullableText(32)}).passthrough()).max(100),
 accountReadiness:z.object({hasActiveEnterpriseAccount:z.boolean(),activeAccountCount:z.number().int().nonnegative(),canReceiveTask:z.boolean()}).passthrough(),
 provenance:z.record(z.unknown()),legalPerson:nullableText(64),contactPerson:nullableText(64),contactPhone:nullableText(64),address:nullableText(500),
}).passthrough().superRefine((value,ctx)=>{
 if(value.sourceEnterpriseId!=='PU-COMPANY-'+value.sourceId||value.gqxqSubjectCode!==value.sourceEnterpriseId)ctx.addIssue({code:'custom',message:'来源企业稳定标识不一致'});
 if(new Set(value.businessTypes).size!==value.businessTypes.length)ctx.addIssue({code:'custom',message:'业务类型重复'});
 if(value.accountReadiness.activeAccountCount===0&&(value.accountReadiness.hasActiveEnterpriseAccount||value.accountReadiness.canReceiveTask))ctx.addIssue({code:'custom',message:'无企业账号不能声明可办理'});
});
export type PuEnterpriseSource=z.infer<typeof puEnterpriseSchema>;
export const PU_ENTERPRISE_SYSTEM_USER='pu-enterprise-sync';
export const PU_ENTERPRISE_OWNED_FIELDS=['enterpriseName','businessType','status','uscc','legalPerson','contactPerson','contactPhone','address'] as const;
export function puEnterpriseCode(source:PuEnterpriseSource,businessType:string){return source.sourceEnterpriseId+'-'+businessType;}
export function sourceEnterpriseStatus(status:string):'enabled'|'disabled'{return status==='enabled'?'enabled':'disabled';}
export function validSourceCreditCode(value:string|null|undefined):string|null{return value&&/^[0-9A-Z]{18}$/.test(value)?value:null;}
/** No name, alias, district or regulatory organization is an identity key. */
export function choosePuEnterpriseTarget(source:PuEnterpriseSource,businessType:string,binding:{enterpriseCode:string}|null,creditMatches:{enterpriseCode:string;businessType:string}[]){
 if(binding)return {enterpriseCode:binding.enterpriseCode,reason:'source_identity' as const};
 const matches=creditMatches.filter(e=>e.businessType===businessType);
 if(matches.length>1)throw new Error('统一信用代码对应多个同业务企业，需人工核实');
 return matches.length===1?{enterpriseCode:matches[0].enterpriseCode,reason:'unique_credit_code' as const}:{enterpriseCode:puEnterpriseCode(source,businessType),reason:'new_source_identity' as const};
}
