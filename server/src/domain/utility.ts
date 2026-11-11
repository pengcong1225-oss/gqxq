import {z} from 'zod';
import {createHash} from 'node:crypto';
import {AppError} from '../http/errors';
import type {UtilityEvent,UtilityMode,UtilityOptions,UtilityComplaint,TimeoutItem} from '../types/utility';
const text=z.string().trim().max(4000),short=z.string().trim().min(1).max(128);
const time=z.string().datetime({offset:true});
const schema=z.object({id:z.string().max(128).optional(),kind:z.enum(['shutdown','pipeline']),title:short,businessType:z.enum(['water','gas']),enterpriseId:short,gridIds:z.array(short).min(1).max(100),districtCode:short,startsAt:time,endsAt:time,restoredAt:time.nullable(),households:z.number().int().min(0).max(100000000),workers:z.number().int().min(0).max(1000000),reason:text,area:text,plan:text,housing:text,sourceApplicationNo:short,approvalStatus:z.enum(['pending','approved','rejected']),approvalNote:text,approvedBy:text,approvedAt:time.nullable(),relatedTypes:z.array(short).min(1).max(50),revision:z.number().int().nonnegative().optional(),updatedAt:time.optional(),mode:z.enum(['simulation','real']).optional()}).strict();
export function validateUtilityEvent(raw:unknown,mode:UtilityMode,options:UtilityOptions){
 const parsed=schema.safeParse(raw);if(!parsed.success)throw AppError.validation('申请字段不合法：请检查必填项、时间时区和非负整数',parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));
 const e=parsed.data;
 if(e.mode&&e.mode!==mode)throw AppError.validation('数据来源模式不一致');
 if(mode==='real'&&(e.id?.startsWith('SIM-')||e.sourceApplicationNo.startsWith('SIM-')))throw AppError.validation('模拟记录不能导入真实数据');
 if(new Set(e.gridIds).size!==e.gridIds.length||new Set(e.relatedTypes).size!==e.relatedTypes.length)throw AppError.validation('网格或诉求类型重复');
 if(Date.parse(e.endsAt)<Date.parse(e.startsAt)||e.restoredAt&&Date.parse(e.restoredAt)<Date.parse(e.startsAt))throw AppError.validation('结束或复供时间不能早于开始时间');
 if(e.approvalStatus!=='pending'&&(!e.approvedAt||!e.approvedBy.trim()))throw AppError.validation('已审批记录需提供来源审批时间和审批人');
 if(!options.enterprises.some(c=>c.id===e.enterpriseId&&c.businessType===e.businessType))throw AppError.validation('企业不存在或业务类型不一致');
 if(e.gridIds.some(id=>!options.grids.some(g=>g.id===id&&g.districtCode===e.districtCode)))throw AppError.validation('网格不存在或不属于选定区县，请按区县拆分申请影响范围');
 return e;
}
export const TIMEOUT_WINDOW='以申请填报的复供时间为起点，检查其后24小时（不含起点、包含终点）的同业务、影响网格内相关类型诉求；未到时间、未审批通过或无复供时间不生成任务。';
export function timeoutCandidate(event:UtilityEvent,rows:UtilityComplaint[],now:Date):TimeoutItem|null{
 if(event.kind!=='shutdown'||event.approvalStatus!=='approved'||!event.restoredAt||Date.parse(event.restoredAt)>=now.getTime())return null;
 const start=Date.parse(event.restoredAt),end=start+24*3600000;
 const complaints=rows.filter(r=>event.gridIds.includes(r.gridId)&&event.relatedTypes.includes(r.type)&&Date.parse(r.occurredAt)>start&&Date.parse(r.occurredAt)<=Math.min(end,now.getTime())).sort((a,b)=>a.id.localeCompare(b.id));
 if(!complaints.length)return null;
 // Membership changes produce a new immutable delivery, avoiding falsely reusing an earlier success.
 const digest=createHash('sha256').update(JSON.stringify([event.id,event.revision,complaints])).digest('hex').slice(0,24);
 return {sourceSystem:event.sourceSystem,id:digest,eventId:event.id,eventTitle:event.title,from:event.restoredAt,to:new Date(end).toISOString(),complaints,status:'pending',attempts:[],eventRevision:event.revision};
}
