import {z} from 'zod';
import {createHash} from 'node:crypto';
import {AppError} from '../http/errors';
import type {UtilityEvent,UtilityMode,UtilityOptions,UtilityComplaint,TimeoutItem} from '../types/utility';
const text=z.string().trim().max(4000),short=z.string().trim().min(1).max(128);
const time=z.string().datetime({offset:true});
const schema=z.object({id:z.string().max(128).optional(),kind:z.enum(['shutdown','pipeline']),title:short,businessType:z.enum(['water','gas']),enterpriseId:short,gridIds:z.array(short).min(1).max(100),districtCode:short,startsAt:time,endsAt:time,restoredAt:time.nullable(),households:z.number().int().min(0).max(100000000),workers:z.number().int().min(0).max(1000000),reason:text,area:text,plan:text,housing:text,sourceApplicationNo:short,approvalStatus:z.enum(['pending','approved','rejected']),approvalNote:text,approvedBy:text,approvedAt:time.nullable(),relatedTypes:z.array(short).min(1).max(50),revision:z.number().int().nonnegative().optional(),updatedAt:time.optional(),mode:z.enum(['simulation','real']).optional()}).strict();
/**
 * 「未定位到网格」的事件专用 schema —— 只放宽三个与空间定位相关的字段，
 * 其余（企业、分类、审批、时间顺序）仍按严格口径校验。
 *
 * 背景：admin_grid.geometry 当前 124 行全为 null，影响范围多边形无法映射到网格，
 * 但事件本身（企业、时间、涉及户数）是成立的。若沿用严格 schema（gridIds ≥1、
 * districtCode 非空、startsAt 必填），这些真实事件会被整体丢弃 → bootstrap.events 恒空
 * → 标书 1.2.2「关联事件」列永远空白。
 *
 * 放宽项与理由：
 *   · gridIds: 允许空数组 —— 事件成立但没有网格定位
 *   · districtCode: 允许空串 —— 无网格时推不出区县
 *   · startsAt/endsAt: 允许 null —— 部分来源来源时间缺失，但事件仍可展示（前端标注时间未知）
 */
const spatialTolerantSchema = schema.extend({
  gridIds: z.array(short).max(100),
  districtCode: z.string().trim().max(128),
  startsAt: z.string().datetime({offset:true}).nullable(),
  endsAt: z.string().datetime({offset:true}).nullable(),
});
export function validateUtilityEvent(raw:unknown,mode:UtilityMode,options:UtilityOptions,{allowUnlocated=false}={}):UtilityEvent{
 const parsed=(allowUnlocated?spatialTolerantSchema:schema).safeParse(raw);
 if(!parsed.success)throw AppError.validation('申请字段不合法：请检查必填项、时间时区和非负整数',parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));
 const e=parsed.data;
 if(e.mode&&e.mode!==mode)throw AppError.validation('数据来源模式不一致');
 if(mode==='real'&&(e.id?.startsWith('SIM-')||e.sourceApplicationNo.startsWith('SIM-')))throw AppError.validation('模拟记录不能导入真实数据');
 if(new Set(e.gridIds).size!==e.gridIds.length||new Set(e.relatedTypes).size!==e.relatedTypes.length)throw AppError.validation('网格或诉求类型重复');
 // 时间顺序校验：tolerant 模式下 startsAt/endsAt 可能为 null，null 不参与比较（不伪造时间）
 // 时间顺序校验：哨兵值（9999-12-31，表示来源未提供时间）不参与比较
 const isSentinel=(v:string|null|undefined)=>!v||v.startsWith('9999-');
 if(!isSentinel(e.startsAt)&&((!isSentinel(e.endsAt)&&Date.parse(e.endsAt!)<Date.parse(e.startsAt!))||(e.restoredAt&&Date.parse(e.restoredAt)<Date.parse(e.startsAt!))))throw AppError.validation('结束或复供时间不能早于开始时间');
 if(e.approvalStatus!=='pending'&&(!e.approvedAt||!e.approvedBy.trim()))throw AppError.validation('已审批记录需提供来源审批时间和审批人');
 if(!options.enterprises.some(c=>c.id===e.enterpriseId&&c.businessType===e.businessType))throw AppError.validation('企业不存在或业务类型不一致');
 // 网格归属校验：无网格（gridUnresolved）时跳过，不应因缺空间定位而拒绝整条事件
 if(e.gridIds.length&&e.gridIds.some(id=>!options.grids.some(g=>g.id===id&&g.districtCode===e.districtCode)))throw AppError.validation('网格不存在或不属于选定区县，请按区县拆分申请影响范围');
 // schema 里 id/updatedAt 是可选，返回给下游前补成确定类型（哨兵时间同样归一为 string）
 return {...e,startsAt:(e.startsAt??'9999-12-31T23:59:59.000Z'),endsAt:(e.endsAt??'9999-12-31T23:59:59.000Z')} as UtilityEvent;
}
export const TIMEOUT_WINDOW='以申请填报的复供时间为起点，检查其后24小时（不含起点、包含终点）的同业务、影响网格内相关类型诉求；未到时间、未审批通过或无复供时间不生成任务。';
export function utilityTimeoutWindow(event:UtilityEvent,now:Date){
 if(event.kind!=='shutdown'||event.approvalStatus!=='approved'||!event.restoredAt||!event.gridIds.length||!event.relatedTypes.length)return null;
 if(event.sourceSystem==='public-utility'&&(!event.hasVerifiedGrid||!event.approvedAt||!event.approvedBy))return null;
 const start=Date.parse(event.restoredAt);
 if(!Number.isFinite(start)||start>=now.getTime())return null;
 return {from:event.restoredAt,to:new Date(start+86400000).toISOString(),start};
}
export function timeoutCandidate(event:UtilityEvent,rows:UtilityComplaint[],now:Date):TimeoutItem|null{
 const window=utilityTimeoutWindow(event,now);
 if(!window)return null;
 const {start,from,to}=window,end=Date.parse(to);
 const complaints=rows.filter(r=>event.gridIds.includes(r.gridId)&&event.relatedTypes.includes(r.type)&&Date.parse(r.occurredAt)>start&&Date.parse(r.occurredAt)<=Math.min(end,now.getTime())).sort((a,b)=>a.id.localeCompare(b.id));
 if(!complaints.length)return null;
 // Membership changes produce a new immutable delivery, avoiding falsely reusing an earlier success.
 const digest=createHash('sha256').update(JSON.stringify([event.id,event.revision,complaints])).digest('hex').slice(0,24);
 return {sourceSystem:event.sourceSystem,id:digest,eventId:event.id,eventTitle:event.title,from,to,complaints,status:'pending',attempts:[],eventRevision:event.revision};
}
