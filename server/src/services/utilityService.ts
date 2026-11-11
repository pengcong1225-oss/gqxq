import {randomUUID} from 'node:crypto';
import {readUtilityFeed,utilityIntegrationStatus,readUtilityDelivery,deliverUtilityTimeout,utilityDeliveryHistory} from './utilityIntegrationService';
import {pool} from '../db/pool';
import {AppError} from '../http/errors';
import {canAccessComplaint,assertAllScope,buildComplaintScopeSql} from '../auth/accessScope';
import {readSupportStore,saveSupportStore} from './tenderSupportService';
import {simulatedSupportData} from '../domain/tenderSupportData';
import {shanghaiToday} from '../domain/statisticsQuery';
import {validateUtilityEvent,timeoutCandidate,TIMEOUT_WINDOW} from '../domain/utility';
import type {MasterDataContext} from '../types/masterData';
import type {UtilityMode,UtilityEvent,UtilityOptions,UtilityState,UtilityComplaint,TimeoutItem} from '../types/utility';
export const UTILITY_SOURCE='公共事业管理的填报系统';
const today=()=>shanghaiToday(()=>new Date());
const fixture=()=>simulatedSupportData(today());
const permission=(kind:string)=>kind==='shutdown'?'shutdown.read':'pipeline.read';
function read(ctx:MasterDataContext,kind:string){if(!['shutdown','pipeline'].includes(kind)||!ctx.permissionCodes.includes(permission(kind)))throw AppError.forbidden('缺少申请查询权限');}
function write(ctx:MasterDataContext){if(!ctx.userId||ctx.access.roles.includes('readonly')||!ctx.permissionCodes.includes('masterdata.import'))throw AppError.forbidden('维护需要数据导入权限');assertAllScope(ctx.access);}
function visible(e:UtilityEvent,ctx:MasterDataContext){return ctx.permissionCodes.includes(permission(e.kind))&&canAccessComplaint(ctx.access,{enterprise_code:e.enterpriseId,district_code:e.districtCode});}
export async function utilityOptions(mode:UtilityMode):Promise<UtilityOptions>{
 if(mode==='simulation'){const d=fixture();return {enterprises:d.enterprises,grids:d.grids};}
 const [companies]=await pool.query<any[]>("select enterprise_code id,enterprise_name name,business_type businessType from enterprise where status='enabled'");
 const [grids]=await pool.query<any[]>('select code id,name,district_code districtCode from admin_grid');
 return {enterprises:companies,grids};
}
function seed():UtilityState{
 const d=simulatedSupportData('2026-11-10'),now=new Date('2026-11-10T00:00:00+08:00');
 const picked=d.complaints.filter(c=>Date.parse(c.occurredAt)<now.getTime()).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)).slice(0,6);
 const events:UtilityEvent[]=picked.map((c,i)=>({id:'SIM-U-'+i,mode:'simulation',kind:i<4?'shutdown':'pipeline',title:'【模拟】'+(i<4?'停供检修申请':'管道施工改造申请')+(i+1),businessType:c.businessType,enterpriseId:c.enterpriseId,gridIds:[c.gridId],districtCode:c.districtCode,startsAt:new Date(Date.parse(c.occurredAt)-25*3600000).toISOString(),endsAt:new Date(Date.parse(c.occurredAt)-3600000).toISOString(),restoredAt:i<4?new Date(Date.parse(c.occurredAt)-3600000).toISOString():null,households:500,workers:12,reason:'【模拟】设备检修',area:'【模拟】'+d.grids.find(g=>g.id===c.gridId)!.name,plan:'【模拟】通知用户、设置警戒并提供备用供给',housing:'【模拟】住宅楼8栋',sourceApplicationNo:'SIM-APPLY-'+i,approvalStatus:'approved',approvalNote:'【模拟】来源系统审批通过',approvedBy:'模拟审批人',approvedAt:new Date(Date.parse(c.occurredAt)-26*3600000).toISOString(),relatedTypes:[c.type],revision:1,updatedAt:now.toISOString()}));
 return {events,deliveries:{}};
}
async function loadLocal(mode:UtilityMode){const row=await readSupportStore('utility-'+mode);return {revision:row?.revision??0,state:(row?.content??(mode==='simulation'?seed():{events:[],deliveries:{}})) as UtilityState};}
export async function loadUtility(mode:UtilityMode){const local=await loadLocal(mode),remote=await readUtilityFeed(mode);return {...local,feedRevision:remote.revision,feedSyncedAt:remote.state?.syncedAt??null,state:{...local.state,events:[...local.state.events,...(remote.state?.sources.flatMap(s=>s.events)??[])]}};}
const load=loadUtility;
export async function utilityList(mode:UtilityMode,kind:string,ctx:MasterDataContext){
 read(ctx,kind);const {revision,state}=await load(mode),o=await utilityOptions(mode);
 const events=state.events.filter(e=>e.kind===kind&&visible(e,ctx));
 const all=ctx.access.rules.some(r=>r.kind==='all');
 const feed=await readUtilityFeed(mode);
 return {revision,events,source:UTILITY_SOURCE,integration:all?await utilityIntegrationStatus(mode):undefined,sourceRows:all?feed.state?.sources.filter(s=>(kind==='pipeline')===(s.source.kind==='construction')).map(s=>({sourceApplicationNo:s.source.sourceApplicationNo,kind:s.source.kind,sourceRevision:s.source.revision,sourceStatus:s.source.status,syncStatus:s.syncStatus,issues:s.issues,fields:s.source.fields,approvalTraces:s.source.approvalTraces}))??[]:[],options:all?o:{enterprises:o.enterprises.filter(c=>events.some(e=>e.enterpriseId===c.id)),grids:o.grids.filter(g=>events.some(e=>e.gridIds.includes(g.id)))}};
}
export async function utilityComplaints(e:UtilityEvent,ctx:MasterDataContext,from:string,to:string,after=false):Promise<UtilityComplaint[]>{
 if(!ctx.permissionCodes.includes('complaint.read')||!e.gridIds.length||!e.relatedTypes.length)return [];
 if(e.mode==='simulation')return fixture().complaints.filter(c=>canAccessComplaint(ctx.access,{enterprise_code:c.enterpriseId,district_code:c.districtCode})&&c.businessType===e.businessType&&e.gridIds.includes(c.gridId)&&e.relatedTypes.includes(c.type)&&Date.parse(c.occurredAt)>=(Date.parse(from)+(after?1:0))&&Date.parse(c.occurredAt)<=Math.min(Date.parse(to),Date.now())).map(c=>({id:c.id,title:c.title,type:c.type,occurredAt:c.occurredAt,gridId:c.gridId}));
 const scope=buildComplaintScopeSql(ctx.access,'c');
 const marks=e.relatedTypes.map(()=>'?').join(',');
 const [categories]=await pool.query<any[]>("select item_value code,item_label label from dict_item where dict_type='complaint_category' and status='enabled' and published=1 and (item_value in ("+marks+") or item_label in ("+marks+"))",[...e.relatedTypes,...e.relatedTypes]);
 const codes=[...new Set(categories.map(c=>String(c.code)))];if(!codes.length)return [];
 const categorySql='(c.major_category_code in ('+codes.map(()=>'?').join(',')+') or c.minor_category_code in ('+codes.map(()=>'?').join(',')+'))';
 const [rows]=await pool.query<any[]>('select c.complaint_id id,c.title,c.major_category_code majorCode,c.minor_category_code minorCode,coalesce(c.minor_category_code,c.major_category_code) type,coalesce(c.source_reported_at,c.received_at) occurredAt,c.admin_grid_code gridId from complaint c where '+scope.sql+' and c.source_system=? and c.business_type=? and c.admin_grid_code in ('+e.gridIds.map(()=>'?').join(',')+') and '+categorySql+' and coalesce(c.source_reported_at,c.received_at) '+(after?'>':'>=')+' ? and coalesce(c.source_reported_at,c.received_at)<=? order by c.complaint_id limit 10001',[...scope.params,'宜接就办',e.businessType,...e.gridIds,...codes,...codes,new Date(from),new Date(Math.min(Date.parse(to),Date.now()))]);
 if(rows.length>10000)throw AppError.validation('关联诉求超过10000条，请缩小事件范围');
 return rows.map(r=>({...r,type:e.relatedTypes.find(t=>categories.some(c=>(c.code===r.majorCode||c.code===r.minorCode)&&(c.code===t||c.label===t)))??r.type,occurredAt:new Date(r.occurredAt).toISOString()}));
}
export async function utilityDetail(mode:UtilityMode,id:string,ctx:MasterDataContext){
 const {state}=await load(mode),event=state.events.find(e=>e.id===id);if(!event||!visible(event,ctx))throw AppError.notFound('申请不存在或无权限');
 if(event.sourceSystem==='public-utility'){const [historyRows]=await pool.query<any[]>('select content from gqxq_tender_support_history where store_key=? order by revision desc limit 100',['utility-feed-'+mode]);const history:unknown[]=[],seen=new Set<number>();for(const row of historyRows){const content=typeof row.content==='string'?JSON.parse(row.content):row.content;for(const source of content.sources??[])for(const e of source.events??[])if(e.id===id&&visible(e,ctx)&&!seen.has(e.revision)){seen.add(e.revision);history.push({revision:e.revision,updatedAt:e.updatedAt,event:e});}}return {event,history,complaints:await utilityComplaints(event,ctx,event.startsAt,event.endsAt),complaintAccess:ctx.permissionCodes.includes('complaint.read')};}
 const [rows]=await pool.query<any[]>('select revision,content,updated_at from gqxq_tender_support_history where store_key=? order by revision desc limit 100',['utility-'+mode]);
 const seen=new Set<number>(),history:any[]=[];
 for(const r of rows){const content=typeof r.content==='string'?JSON.parse(r.content):r.content;const e=content.events.find((e:UtilityEvent)=>e.id===id);if(e&&visible(e,ctx)&&!seen.has(e.revision)){seen.add(e.revision);history.push({revision:e.revision,updatedAt:e.updatedAt,event:e});}}
 if(!history.length)history.push({revision:event.revision,updatedAt:event.updatedAt,event});
 return {event,history,complaints:await utilityComplaints(event,ctx,event.startsAt,event.endsAt),complaintAccess:ctx.permissionCodes.includes('complaint.read')};
}
export async function saveUtility(mode:UtilityMode,id:string|undefined,raw:any,ctx:MasterDataContext){
 write(ctx);if(mode!=='simulation')throw AppError.validation('真实申请及审批以公共事业管理的填报系统为准，请使用来源导入，不在本系统修改');
 const {revision,state}=await loadLocal(mode);if(raw.expectedRevision!==revision)throw AppError.conflict('数据已更新，请刷新');
 const parsed=validateUtilityEvent(raw.event,mode,await utilityOptions(mode));read(ctx,parsed.kind);
 const old=id?state.events.find(e=>e.id===id):undefined;if(id&&!old)throw AppError.notFound('申请不存在');
 if(old&&old.kind!==parsed.kind)throw AppError.validation('不能修改申请类别');
 if(parsed.id&&parsed.id!==id)throw AppError.validation('申请编号不一致');
 const event:UtilityEvent={...parsed,id:id??'SIM-U-'+randomUUID(),mode,revision:(old?.revision??0)+1,updatedAt:new Date().toISOString()};
 if(state.events.some(e=>e.id!==id&&e.sourceApplicationNo===event.sourceApplicationNo))throw AppError.conflict('来源申请号已存在');
 if(state.events.length>=1000&&!old)throw AppError.validation('单个数据版本最多1000条申请');
 state.events=old?state.events.map(e=>e.id===id?event:e):[event,...state.events];
 return {revision:await saveSupportStore('utility-'+mode,state,revision,ctx),event};
}
export async function importUtility(raw:any,ctx:MasterDataContext){
 write(ctx);if(!Array.isArray(raw.events)||!raw.events.length||raw.events.length>500)throw AppError.validation('一次导入1至500条来源申请');
 const {revision,state}=await loadLocal('real');if(raw.expectedRevision!==revision)throw AppError.conflict('数据已更新，请刷新');
 const options=await utilityOptions('real'),seen=new Set<string>();
 for(const item of raw.events){const parsed=validateUtilityEvent(item,'real',options);read(ctx,parsed.kind);if(seen.has(parsed.sourceApplicationNo))throw AppError.validation('导入申请号重复');seen.add(parsed.sourceApplicationNo);
 const old=state.events.find(e=>e.sourceApplicationNo===parsed.sourceApplicationNo);if(old&&old.kind!==parsed.kind)throw AppError.validation('来源申请类别不能变更');
 const event:UtilityEvent={...parsed,id:old?.id??'PU-'+randomUUID(),mode:'real',revision:(old?.revision??0)+1,updatedAt:new Date().toISOString()};state.events=old?state.events.map(e=>e.id===old.id?event:e):[event,...state.events];}
 if(state.events.length>1000)throw AppError.validation('单版本申请超过1000条，请联系管理员分批归档');
 return {revision:await saveSupportStore('utility-real',state,revision,ctx),count:raw.events.length};
}
export async function utilityTimeouts(mode:UtilityMode,ctx:MasterDataContext){
 read(ctx,'shutdown');if(!ctx.permissionCodes.includes('complaint.read'))throw AppError.forbidden('超时匹配需要诉求查询权限');
 const {revision,state}=await load(mode),items:TimeoutItem[]=[];
 for(const event of state.events.filter(e=>e.kind==='shutdown'&&visible(e,ctx)&&e.approvalStatus==='approved'&&e.restoredAt&&Date.parse(e.restoredAt)<Date.now())){
 const end=new Date(Date.parse(event.restoredAt!)+24*3600000).toISOString();const rows=await utilityComplaints(event,ctx,event.restoredAt!,end,true),item=timeoutCandidate(event,rows,new Date());if(item)items.push(event.sourceSystem==='public-utility'?(await readUtilityDelivery(mode,item.id)).state?.item??item:state.deliveries[item.id]??item);}
 if(ctx.access.rules.some(r=>r.kind==='all'))for(const old of await utilityDeliveryHistory(mode))if(!items.some(i=>i.id===old.id))items.push(['sent','simulated'].includes(old.status)?old:{...old,status:'superseded'});
 // Retain prior attempts even if a later edit changes the matching set; explicit old revision is shown.
 for(const old of Object.values(state.deliveries)){if(ctx.access.rules.some(r=>r.kind==='all')&&!items.some(i=>i.id===old.id)&&state.events.some(e=>e.id===old.eventId&&visible(e,ctx)))items.push(old);}
 return {revision,items,evaluatedAt:new Date().toISOString(),windowDescription:TIMEOUT_WINDOW};
}
export async function pushUtility(mode:UtilityMode,id:string,raw:any,ctx:MasterDataContext){
 write(ctx);const current=await utilityTimeouts(mode,ctx),candidate=current.items.find(i=>i.id===id);if(raw.expectedRevision!==current.revision)throw AppError.conflict('数据已更新，请刷新');const currentState=await load(mode);if(candidate&&currentState.state.events.some(e=>e.id===candidate.eventId&&e.sourceSystem==='public-utility'))return {revision:current.revision,item:await deliverUtilityTimeout(mode,id)};if(mode==='real')throw AppError.validation('只有已自动同步且完成映射的来源申请可推送');if(!['success','failure'].includes(raw.outcome))throw AppError.validation('请选择模拟返回结果');
 const list=await utilityTimeouts(mode,ctx);if(raw.expectedRevision!==list.revision)throw AppError.conflict('数据已更新，请刷新');
 const item=list.items.find(i=>i.id===id);if(!item)throw AppError.notFound('没有对应的匹配任务');
 const {revision,state}=await loadLocal(mode);if(revision!==list.revision)throw AppError.conflict('数据已更新，请刷新');
 const event=state.events.find(e=>e.id===item.eventId)!;if(event.revision!==item.eventRevision)throw AppError.conflict('申请已修订，请推送重新匹配的任务');
 const latestRows=await utilityComplaints(event,ctx,event.restoredAt!,new Date(Date.parse(event.restoredAt!)+24*3600000).toISOString(),true);
 if(timeoutCandidate(event,latestRows,new Date())?.id!==id)throw AppError.conflict('诉求匹配结果已变化，请刷新使用新任务');
 if(item.status==='simulated')return {revision,item};
 if(item.attempts.length>=100)throw AppError.validation('重试次数已达上限');
 const result=raw.outcome==='success'?'simulated':'failed';
 const next:TimeoutItem={...item,status:result,attempts:[...item.attempts,{at:new Date().toISOString(),result,message:raw.outcome==='success'?'【模拟】填报系统接收成功，未发送外部请求。':'【模拟】填报系统返回失败，可重试。'}]};
 state.deliveries[id]=next;return {revision:await saveSupportStore('utility-'+mode,state,revision,ctx),item:next};
}
