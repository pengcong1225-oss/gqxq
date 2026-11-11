import {z} from 'zod';
import {AppError} from '../http/errors';
import type {TenderDataset,SupportWarningConfig} from '../types/tenderSupport';
import type {AccessContext} from '../auth/accessScope';
import {canAccessComplaint} from '../auth/accessScope';
const id=z.string().trim().min(1).max(100),text=z.string().trim().min(1).max(1000),business=z.enum(['water','gas']);
const timestamp=z.string().refine(s=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===s.slice(0,10),'时间须为带时区的ISO格式');
const lng=z.number().finite().min(-180).max(180),lat=z.number().finite().min(-90).max(90),point=z.tuple([lng,lat]);
const count=z.number().int().min(0).max(100000000);
const grid=z.object({id,name:text,districtCode:id,districtName:text,longitude:lng,latitude:lat,ring:z.array(point).min(4).max(10000)}).strict();
const community=z.object({id,name:text,gridId:id,longitude:lng,latitude:lat,households:count}).strict();
const enterprise=z.object({id,name:text,businessType:business,households:count}).strict();
const complaint=z.object({id,title:text,businessType:business,type:text,enterpriseId:id,districtCode:id,gridId:id,communityId:id,occurredAt:timestamp,completedAt:timestamp.nullable(),evaluation:z.enum(['satisfied','unsatisfied','unevaluated']),longitude:lng,latitude:lat,scenario:z.enum(['winter','summer','planned','installation','other'])}).strict();
const event=z.object({id,kind:z.enum(['planned-water','planned-gas','emergency-water','emergency-gas','water-project','gas-project']),title:text,enterpriseId:id,gridIds:z.array(id).min(1).max(100),startsAt:timestamp,endsAt:timestamp,households:count,workers:count,reason:text,area:text,plan:text,housing:text}).strict();
const pipeline=z.object({id,name:text,businessType:business,enterpriseId:id,gridIds:z.array(id).min(1).max(100),path:z.array(point).min(2).max(10000)}).strict();
const schema=z.object({schemaVersion:z.literal(1),mode:z.enum(['simulation','real']),revision:count,sourceLabel:text,updatedAt:timestamp,grids:z.array(grid).max(1000),communities:z.array(community).max(5000),enterprises:z.array(enterprise).max(1000),complaints:z.array(complaint).max(30000),events:z.array(event).max(5000),pipelines:z.array(pipeline).max(3000).optional()}).strict();
export function validateSupportDataset(raw:unknown,realOnly=false):TenderDataset{
 const parsed=schema.safeParse(raw);if(!parsed.success)throw AppError.validation('数据格式错误：'+parsed.error.issues.slice(0,4).map(i=>i.path.join('.')+' '+i.message).join('；'));
 const d=parsed.data as TenderDataset;
 if(realOnly&&d.mode!=='real')throw AppError.validation('真实接入须明确mode=real，模拟样本不可直接转为真实数据');
 for(const list of [d.grids,d.communities,d.enterprises,d.complaints,d.events,d.pipelines??[]]){if(new Set(list.map(x=>x.id)).size!==list.length)throw AppError.validation('同类数据编码重复');if(realOnly&&list.some(x=>x.id.startsWith('SIM-')))throw AppError.validation('真实数据不得使用SIM-模拟编码');}
 const grids=new Map(d.grids.map(g=>[g.id,g])),communities=new Map(d.communities.map(c=>[c.id,c])),companies=new Map(d.enterprises.map(e=>[e.id,e]));
 for(const g of d.grids)if(JSON.stringify(g.ring[0])!==JSON.stringify(g.ring[g.ring.length-1]))throw AppError.validation('网格边界必须闭合');
 for(const c of d.communities)if(!grids.has(c.gridId))throw AppError.validation('小区引用了不存在的网格');
 for(const c of d.complaints){
  if(!grids.has(c.gridId)||communities.get(c.communityId)?.gridId!==c.gridId||grids.get(c.gridId)?.districtCode!==c.districtCode||companies.get(c.enterpriseId)?.businessType!==c.businessType)throw AppError.validation('诉求的小区、网格、区划或企业业务关联不一致');
  if(c.completedAt&&Date.parse(c.completedAt)<Date.parse(c.occurredAt)||!c.completedAt&&c.evaluation!=='unevaluated')throw AppError.validation('办结时间或评价状态不一致');
 }
 for(const e of d.events)if(e.gridIds.some(g=>!grids.has(g))||Date.parse(e.endsAt)<Date.parse(e.startsAt)||companies.get(e.enterpriseId)?.businessType!==(e.kind.includes('water')?'water':'gas'))throw AppError.validation('事件网格、时间或企业关联不一致');
 for(const p of d.pipelines??[])if(p.gridIds.some(g=>!grids.has(g))||companies.get(p.enterpriseId)?.businessType!==p.businessType)throw AppError.validation('管线网格或企业关联不一致');
 return d;
}
export function scopeSupportDataset(d:TenderDataset,ctx:AccessContext):TenderDataset{
 if(ctx.rules.some(r=>r.kind==='all'))return d;
 const allowed=(enterprise_code:string,district_code:string)=>canAccessComplaint(ctx,{enterprise_code,district_code});
 const gridMap=new Map(d.grids.map(g=>[g.id,g]));
 const complaints=d.complaints.filter(c=>allowed(c.enterpriseId,c.districtCode));
 // A multi-grid event is disclosed only if the complete event is in scope.
 const events=d.events.filter(e=>e.gridIds.every(id=>allowed(e.enterpriseId,gridMap.get(id)?.districtCode??'')));
 const pipelines=d.pipelines?.filter(e=>e.gridIds.every(id=>allowed(e.enterpriseId,gridMap.get(id)?.districtCode??'')));
 const gridIds=new Set([...complaints.map(c=>c.gridId),...events.flatMap(e=>e.gridIds),...(pipelines??[]).flatMap(e=>e.gridIds)]);
 const enterpriseIds=new Set([...complaints.map(c=>c.enterpriseId),...events.map(e=>e.enterpriseId),...(pipelines??[]).map(e=>e.enterpriseId)]);
 return {...d,complaints,events,pipelines,grids:d.grids.filter(g=>gridIds.has(g.id)),communities:d.communities.filter(c=>gridIds.has(c.gridId)),enterprises:d.enterprises.filter(e=>enterpriseIds.has(e.id)).map(e=>({...e,households:0}))};
}
export function validateSupportWarnings(raw:unknown):SupportWarningConfig{
 const s=z.object({revision:count,rules:z.array(z.object({scenario:z.enum(['winter','summer','planned','installation']),name:text,threshold:z.number().int().min(1).max(1000000),days:z.number().int().min(1).max(3660),enabled:z.boolean()}).strict()).length(4)}).strict().safeParse(raw);
 if(!s.success||new Set(s.data.rules.map(r=>r.scenario)).size!==4)throw AppError.validation('四场景规则须各一条，阈值为正整数，统计天数为1至3660');return s.data;
}
