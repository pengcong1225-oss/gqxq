import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
import {AppError} from '../http/errors';
import {assertPuCredentials,serializeOnce,buildAttempt,postIntegrationTask,lowercaseHexSha256} from '../clients/publicUtilityClient';
import {readSupportStore,saveSupportStore} from './tenderSupportService';
import {mapUtilityFeed,type UtilityFeedItem,type FeedReferences,type MappedUtilitySource} from '../domain/utilityFeed';
import {simulatedSupportData} from '../domain/tenderSupportData';
import {shanghaiToday} from '../domain/statisticsQuery';
import type {UtilityMode,TimeoutItem,UtilityEvent} from '../types/utility';
import type {MasterDataContext} from '../types/masterData';
import {utilityOptions,utilityTimeouts,loadUtility,utilityComplaints} from './utilityService';
import {timeoutCandidate,utilityTimeoutWindow} from '../domain/utility';

export const utilitySystemContext:MasterDataContext={userId:'utility-integration-system',userName:'公共事业申请自动同步',clientIp:null,permissionCodes:['shutdown.read','pipeline.read','complaint.read'],access:{userId:'trusted-system',roles:[],scopeVersion:0,rules:[{kind:'all'}],canReadSource:false}};
export function utilitySyncEnabled(){return process.env.GQXQ_PU_UTILITY_SYNC_ENABLED==='true';}
const key=(mode:UtilityMode)=>'utility-feed-'+mode;
interface FeedState {sources:MappedUtilitySource[];unclassifiedCount:number;syncedAt:string}
/** MySQL JSON reorders object keys. Snapshot equality is structural, never its
 * driver serialization order; arrays retain their meaningful source ordering. */
export function canonicalUtilitySnapshot(value:unknown):string {
 const sort=(item:any):any=>Array.isArray(item)?item.map(sort):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(k=>[k,sort(item[k])])):item;
 return JSON.stringify(sort(value));
}
export async function readUtilityFeed(mode:UtilityMode,db=pool){
 const row=await readSupportStore(key(mode),db),state=row?.content as FeedState|undefined;
 return {revision:row?.revision??0,state:state&&{...state,sources:(state.sources??[])
  .filter(entry=>entry.source?.dataMode===mode)
  .map(entry=>({...entry,events:(entry.events??[]).filter(event=>event.mode===mode)}))}};
}
let running=false,lastAttemptAt:string|null=null,lastSuccessAt:string|null=null,lastError:string|null=null;
export async function utilityIntegrationStatus(mode:UtilityMode){
 const r=await readUtilityFeed(mode);
 return {enabled:utilitySyncEnabled(),running,lastAttemptAt,lastSuccessAt,lastError,source:'公共事业管理的填报系统',protocol:'签名接口自动同步',sourceRevision:r.revision,syncedAt:r.state?.syncedAt??null,unclassifiedCount:r.state?.unclassifiedCount??0,mapped:r.state?.sources.filter(s=>s.syncStatus==='mapped').length??0,pendingMapping:r.state?.sources.filter(s=>s.syncStatus!=='mapped').length??0};
}
export async function references(mode:UtilityMode):Promise<FeedReferences>{
 if(mode==='simulation'){
  const data=simulatedSupportData(shanghaiToday(()=>new Date()));
  let configured:unknown;
  try{configured=JSON.parse(process.env.GQXQ_PU_UTILITY_SIM_ENTERPRISE_MAP??'{}');}catch{throw new Error('模拟企业对应配置不是有效JSON');}
  if(!configured||typeof configured!=='object'||Array.isArray(configured))throw new Error('模拟企业对应配置需为subjectId到模拟企业编码的对象');
  const mappings=Object.entries(configured).map(([sourceDepartmentCode,enterpriseCode])=>{
   if(!data.enterprises.some(e=>e.id===enterpriseCode))throw new Error('模拟企业对应配置引用不存在的模拟企业');
   return {sourceDepartmentCode,enterpriseCode};
  });
  const grids=data.grids.map(g=>({...g,geometry:{type:'Polygon',coordinates:[g.ring]},coordinateSystem:'WGS84',geometrySource:'独立模拟网格'}));
  return {enterprises:data.enterprises,grids,mappings};
 }
 const options=await utilityOptions(mode);
 const [mappings]=await pool.query<any[]>("select source_department_code sourceDepartmentCode,enterprise_code enterpriseCode from enterprise_department_mapping where source_system='public-utility' and verified=1 and entity_type='enterprise'");
 if(process.env.GQXQ_PU_ENTERPRISE_SYNC_ENABLED==='true'){const [bindings]=await pool.query<any[]>("select b.enterprise_code enterpriseCode,b.source_subject_id sourceSubjectId,b.source_payload sourcePayload from pu_enterprise_binding b join enterprise e on e.enterprise_code=b.enterprise_code where e.status='enabled'");for(const row of bindings){const payload=typeof row.sourcePayload==='string'?JSON.parse(row.sourcePayload):row.sourcePayload;for(const subjectId of [row.sourceSubjectId,...(payload.subjectAliases??[]).map((a:any)=>a.subjectId)].filter(Boolean))mappings.push({sourceDepartmentCode:String(subjectId),enterpriseCode:row.enterpriseCode});}}
 const [grids]=await pool.query<any[]>('select code id,name,district_code districtCode,geometry,coordinate_system coordinateSystem,geometry_source geometrySource from admin_grid');
 // 小区点位（含所属网格），用于「影响范围多边形 → 面内小区 → 网格」反推
 // 只取已定位且非 (0,0) 的点，避免脏点把反推结果拉到海外
 const [commRows]=await pool.query<any[]>(
   'select location_lng lng, location_lat lat, admin_grid_code gridCode from community ' +
   'where admin_grid_code is not null and admin_grid_code <> "" ' +
   'and location_lng is not null and location_lat is not null and location_lng <> 0 and location_lat <> 0'
 );
 const communityPoints=commRows
   .map(r=>({lng:Number(r.lng),lat:Number(r.lat),gridCode:String(r.gridCode??'')}))
   .filter(p=>Number.isFinite(p.lng)&&Number.isFinite(p.lat)&&p.gridCode);
 return {...options,grids,mappings,communityPoints};
}
function parseResponse(outcome:Awaited<ReturnType<typeof postIntegrationTask>>):any {
 if(outcome.kind!=='response')throw new Error('公共事业接口连接失败：'+outcome.kind);
 if(outcome.httpStatus<200||outcome.httpStatus>=300)throw new Error('公共事业接口 HTTP '+outcome.httpStatus);
 let data:any;try{data=JSON.parse(outcome.bodyText);}catch{throw new Error('公共事业接口返回无效JSON');}
 if(data?.code!==undefined&&![0,200,'0','200','SUCCESS'].includes(data.code))throw new Error('公共事业接口业务拒绝');
 return data?.data??data;
}
/**
 * 对**已有快照**重新做一次映射（不重新拉取外部源）。
 *
 * 用途：`mapUtilityFeed` 的映射规则修好后（例如补了「审批轨迹发起人」企业名兜底、
 * 加了「坐标系未声明时按 GCJ-02 推定」的几何兜底），全量重新拉取外部源在本机不可行
 * （依赖公用事业平台签名接口）。此函数复用已存快照里每条来源的**原始字段**，
 * 用新规则重算 `syncStatus` / `issues` / `events`，然后写回新 revision。
 *
 * 严格约束：
 *   · 只重算派生字段，**不改动 source 原始内容**（fields / approvalTraces 原样保留）
 *   · 重算前后打印 mapped / pending 数量对比，便于核对
 *   · 幂等：同样输入重跑结果一致（canonical 比较无变化则不写新 revision）
 */
export async function remapUtilityFeedSnapshot(mode:UtilityMode){
  const previous=await readUtilityFeed(mode);
  if(!previous.state)throw new Error('本地没有 utility-feed-'+mode+' 快照，无法重映射');
  const refs=await references(mode);
  const sources:MappedUtilitySource[]=(previous.state.sources??[]).map((s:MappedUtilitySource)=>mapUtilityFeed(s.source,mode,refs));
  const unclassifiedCount=Number(previous.state.unclassifiedCount??0);
  const before={mapped:0,pending:0,events:0};
  for(const s of previous.state.sources??[]){if(s.syncStatus==='mapped')before.mapped++;else before.pending++;before.events+=(s.events??[]).length;}
  const after={mapped:0,pending:0,events:0};
  for(const s of sources){if(s.syncStatus==='mapped')after.mapped++;else after.pending++;after.events+=(s.events??[]).length;}
  const changed=canonicalUtilitySnapshot({sources,unclassifiedCount})!==canonicalUtilitySnapshot({sources:previous.state.sources??[],unclassifiedCount});
  let revision=previous.revision;
  if(changed){
    revision=await saveSupportStore(key(mode),{sources,unclassifiedCount,syncedAt:previous.state.syncedAt??new Date().toISOString()},previous.revision,utilitySystemContext);
  }
  return {mode,changed,revision,before,after};
}
export async function syncUtilityFeedMode(mode:UtilityMode){
 assertPuCredentials();const refs=await references(mode),sources:MappedUtilitySource[]=[];
 let afterId=0,snapshotMaxId:number|undefined,unclassifiedCount=0;
 for(let page=0;page<200;page++){
  const body=serializeOnce({requestId:randomUUID(),sourceAppCode:'gqxq',mode,afterId,limit:25,...(snapshotMaxId===undefined?{}:{snapshotMaxId})});
  const response=parseResponse(await postIntegrationTask(buildAttempt(body,{endpointPath:'/api/integrations/gqxq/utility-feed'}),2*1024*1024));
  if(!Array.isArray(response.items)||response.items.length>25||!Number.isSafeInteger(response.snapshotMaxId)||!Number.isSafeInteger(response.nextAfterId)||typeof response.hasMore!=='boolean')throw new Error('公共事业申请分页契约无效');
  if(snapshotMaxId!==undefined&&response.snapshotMaxId!==snapshotMaxId)throw new Error('公共事业分页快照边界变化');
  snapshotMaxId=response.snapshotMaxId;unclassifiedCount=Number(response.unclassifiedCount)||0;
  for(const source of response.items as UtilityFeedItem[]){
   if(!source||!Number.isSafeInteger(source.feedId)||source.feedId<=afterId||source.feedId>snapshotMaxId!||source.dataMode!==mode||!['native','legacy'].includes(source.sourceKind)||!source.sourceId||!source.revision||!source.sourceApplicationNo||!['water-stops','gas-stops','construction'].includes(source.kind)||!source.fields||typeof source.fields!=='object'||Array.isArray(source.fields)||!Array.isArray(source.approvalTraces))throw new Error('公共事业申请来源契约无效，未更新本地快照');
   if(sources.some(s=>s.source.feedId===source.feedId))throw new Error('公共事业分页重复记录');
   sources.push(mapUtilityFeed(source,mode,refs));
  }
  if(!response.hasMore){
   const previous=await readUtilityFeed(mode),stable={sources,unclassifiedCount};
   if(!previous.state||canonicalUtilitySnapshot(stable)!==canonicalUtilitySnapshot({sources:previous.state?.sources??[],unclassifiedCount:previous.state?.unclassifiedCount??0}))await saveSupportStore(key(mode),{...stable,syncedAt:new Date().toISOString()},previous.revision,utilitySystemContext);
   return;
  }
  if(response.nextAfterId<=afterId||response.nextAfterId>snapshotMaxId!)throw new Error('公共事业分页游标无进展');
  afterId=response.nextAfterId;
 }
 throw new Error('公共事业申请超过5000条安全扫描上限，未替换本地快照');
}

interface DeliveryBatch {deliveryId:string;bodyText:string;bodySha256:string;receipt?:{receiptId:number;status:string}}
interface DeliveryOutbox {item:TimeoutItem;batches:DeliveryBatch[];leaseUntil:string|null;nextAttemptAt:string|null}
const deliveryKey=(mode:UtilityMode,id:string)=>'uo-'+(mode==='real'?'r':'s')+'-'+id;
const deliveryPath='/api/integrations/gqxq/utility-timeouts';
export function timeoutDeliveryBatches(mode:UtilityMode,event:UtilityEvent,item:TimeoutItem):DeliveryBatch[]{
 const batches:DeliveryBatch[]=[];
 // A receiver request accepts <=1000 complaints and <=900KiB; 100 keeps titles bounded too.
 for(let offset=0;offset<item.complaints.length;offset+=100){
  const deliveryId=item.id+'-'+Math.floor(offset/100),body=serializeOnce({requestId:'utility-'+mode+'-'+deliveryId,sourceAppCode:'gqxq',deliveryId,mode,sourceApplicationNo:event.sourceApplicationNo,eventRevision:String(event.revision),windowFrom:item.from,windowTo:item.to,complaints:item.complaints.slice(offset,offset+100)});
  batches.push({deliveryId,bodyText:body.bodyText,bodySha256:body.bodySha256});
 }
 return batches;
}
export async function readUtilityDelivery(mode:UtilityMode,id:string){const r=await readSupportStore(deliveryKey(mode,id));return {revision:r?.revision??0,state:r?.content as DeliveryOutbox|undefined};}
export async function utilityDeliveryHistory(mode:UtilityMode):Promise<TimeoutItem[]>{
 const [rows]=await pool.query<any[]>('select content from gqxq_tender_support_store where store_key like ? order by updated_at desc limit 1000',['uo-'+(mode==='real'?'r':'s')+'-%']);
 return rows.map(row=>{const content=typeof row.content==='string'?JSON.parse(row.content):row.content;return content.item;}).filter(Boolean);
}
export async function deliverUtilityTimeout(mode:UtilityMode,id:string){
 if(!utilitySyncEnabled())throw AppError.validation('公共事业自动集成尚未启用');
 assertPuCredentials();const current=await loadUtility(mode);
 // Re-evaluate the current source approval, current revision and current complaint membership before every send/retry.
 const list=await utilityTimeouts(mode,utilitySystemContext),candidate=list.items.find(i=>i.id===id);
 const out=await readUtilityDelivery(mode,id),prior=out.state;
 if(prior?.item.status==='sent')return prior.item;
 if(prior?.leaseUntil&&Date.parse(prior.leaseUntil)>Date.now())return prior.item;
 const source=candidate?current.state.events.find(e=>e.id===candidate.eventId):undefined;
 const now=new Date(),window=source&&utilityTimeoutWindow(source,now);
 const rows=source&&window?await utilityComplaints(source,utilitySystemContext,window.from,window.to,true):[];
 if(!source||source.mode!==mode||source.sourceSystem!=='public-utility'||source.revision!==candidate?.eventRevision||timeoutCandidate(source,rows,now)?.id!==id){
  if(prior){prior.item={...prior.item,status:'superseded'};prior.leaseUntil=null;await saveSupportStore(deliveryKey(mode,id),prior,out.revision,utilitySystemContext);return prior.item;}
  throw AppError.conflict('来源申请或诉求匹配结果已变化，请刷新');
 }
 if(prior?.nextAttemptAt&&Date.parse(prior.nextAttemptAt)>Date.now())return prior.item;
 let state:DeliveryOutbox=prior??{item:candidate!,batches:timeoutDeliveryBatches(mode,source,candidate!),leaseUntil:null,nextAttemptAt:null};
 if(state.item.attempts.length>=12)return state.item;
 state={...state,leaseUntil:new Date(Date.now()+120000).toISOString(),item:{...state.item,status:'pending',attempts:[...state.item.attempts,{at:new Date().toISOString(),result:'sending',message:'已持久化签名字节，正在发送至公共事业填报系统'}]}};
 // Optimistic store revision is a durable claim across processes, not merely an in-memory lock.
 let revision=await saveSupportStore(deliveryKey(mode,id),state,out.revision,utilitySystemContext);
 try{
  for(const batch of state.batches){
   if(batch.receipt)continue;
   const bytes=Buffer.from(batch.bodyText,'utf8');if(lowercaseHexSha256(bytes)!==batch.bodySha256)throw new Error('已保存的推送字节摘要不一致，拒绝发送');
   const receipt=parseResponse(await postIntegrationTask(buildAttempt({bodyText:batch.bodyText,bodyBytes:bytes,bodySha256:batch.bodySha256},{endpointPath:deliveryPath})));
   if(!Number.isSafeInteger(receipt?.receiptId)||receipt.receiptId<=0||receipt.deliveryId!==batch.deliveryId||receipt.mode!==mode||!['accepted','duplicate'].includes(receipt.status))throw new Error('公共事业推送回执契约不一致');
   batch.receipt={receiptId:receipt.receiptId,status:receipt.status};state.leaseUntil=new Date(Date.now()+120000).toISOString();
   revision=await saveSupportStore(deliveryKey(mode,id),state,revision,utilitySystemContext);
  }
  state.item={...state.item,status:'sent',attempts:[...state.item.attempts,{at:new Date().toISOString(),result:'sent',message:(mode==='simulation'?'【模拟链路】':'')+'填报系统已签名接收；回执 '+state.batches.map(b=>b.receipt!.receiptId).join('、')}]};state.nextAttemptAt=null;
 }catch(e){state.item={...state.item,status:'failed',attempts:[...state.item.attempts,{at:new Date().toISOString(),result:'failed',message:e instanceof Error?e.message:'公共事业推送失败'}]};state.nextAttemptAt=new Date(Date.now()+Math.min(3600000,30000*2**Math.min(7,Math.floor(state.item.attempts.length/2)))).toISOString();}
 state.leaseUntil=null;await saveSupportStore(deliveryKey(mode,id),state,revision,utilitySystemContext);return state.item;
}
export async function runUtilityIntegrationCycle(){
 if(running||!utilitySyncEnabled())return;
 running=true;lastAttemptAt=new Date().toISOString();
 try{
  if(process.env.GQXQ_PU_ENTERPRISE_SYNC_ENABLED==='true')await (await import('./puEnterpriseSyncService')).syncPuEnterpriseFeed();
  for(const mode of ['real','simulation'] as const){
   await syncUtilityFeedMode(mode);
   const list=await utilityTimeouts(mode,utilitySystemContext);
   for(const item of list.items.filter(i=>!['sent','simulated','superseded'].includes(i.status)).slice(0,25)){
    const current=await loadUtility(mode);if(!current.state.events.some(e=>e.id===item.eventId&&e.sourceSystem==='public-utility'))continue;
    await deliverUtilityTimeout(mode,item.id);
   }
  }
  lastSuccessAt=new Date().toISOString();lastError=null;
 }catch(e){lastError=e instanceof Error?e.message:'自动同步失败';console.error('[utility-integration]',lastError);}finally{running=false;}
}
export function startUtilityIntegrationWorker(){
 if(!utilitySyncEnabled())return ()=>{};
 const interval=Number(process.env.GQXQ_PU_UTILITY_SYNC_INTERVAL_MS??30000);if(!Number.isFinite(interval)||interval<10000||interval>3600000)throw new Error('GQXQ_PU_UTILITY_SYNC_INTERVAL_MS须在10000..3600000之间');
 void runUtilityIntegrationCycle();const timer=setInterval(()=>void runUtilityIntegrationCycle(),interval);timer.unref();return ()=>clearInterval(timer);
}
