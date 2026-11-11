import {recognizeCommunityIn} from './communityRecognitionService';
import {locationCandidates,cachedLocation,mayRefineLocation,shouldImproveLocation} from '../domain/locationCandidates';
import {fallbackLocation,acceptApproximateGeocode,type InitialPoint} from '../domain/locationFallback';
import {pool} from '../db/pool';
import {mayInitialize,locationQuery,acceptGeocode,initializationAddress} from '../domain/locationInitialization';
import {parseFieldState} from '../domain/effectiveFieldPolicy';
import type {Tx} from '../db/tx';
import {loadEffectiveFieldState} from '../repositories/effectiveFieldRepo';
import {insertAudit} from '../repositories/auditLogRepo';
const fingerprint="sha2(concat_ws(char(0),coalesce(c.address,''),coalesce(c.title,''),coalesce(c.content,''),coalesce(c.district_code,''),coalesce(c.district_name,''),coalesce(a.candidate_text,''),coalesce(a.parent_match,''),coalesce(a.district_code,'')),256)";
async function initializationState(db:Tx,row:Record<string,unknown>){
 const raw=parseFieldState(row.effective_field_state),states=await loadEffectiveFieldState(db,row);
 // User-authorized legacy initialization: blank imported coordinates without any human position decision.
 // Explicit stored protection always wins, including a human decision to clear the position.
 if(row.location_lng==null&&row.location_lat==null&&!raw.location_lng&&!raw.location_lat){
  const [history]=await db.query<any[]>("select 1 from correction_item where complaint_id=? and field_name in ('location_lng','location_lat','location_group','address','district_name') and status in ('confirmed','rejected') union all select 1 from complaint_field_version where complaint_id=? and change_source='manual_edit' and field_name in ('location_lng','location_lat','location_coordinate_system','location_coordinate_source','address','district_code','district_name') limit 1",[row.complaint_id,row.complaint_id]);
  if(!history.length)for(const field of ['location_lng','location_lat'])states[field]={resolution:'unresolved',value:null,version:Number(row.edit_version),reason:'已授权初始化原始导入空坐标，未发现人工位置决定'};
 }
 return states;
}
let providerUnavailableUntil=0;
async function provider(params:Record<string,string>,key:string){
 const url='https://api.tianditu.gov.cn/geocoder?'+new URLSearchParams({...params,tk:key});
 const response=await fetch(url,{headers:{Referer:'https://ai.mockr.com.cn/','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error('地图服务请求未成功');
 const bytes=await response.arrayBuffer();let text=new TextDecoder('utf-8').decode(bytes);
 if(text.includes('\ufffd'))text=new TextDecoder('gb18030').decode(bytes);
 return JSON.parse(text);
}
export async function initializeLocations(limit=20){
 const key=process.env.GQXQ_TIANDITU_KEY?.trim();
 const conn=await pool.getConnection();let locked=false;
 const counts={processed:0,matched:0,review:0,retry:0,preserved:0};
 try{
 const [[lock]]=await conn.query<any[]>("select get_lock('gqxq-location-init',0) acquired");if(!lock.acquired)return counts;locked=true;
 const [rows]=await conn.query<any[]>(`select c.*,a.candidate_text,a.parent_match,${fingerprint} init_hash,case when j.input_hash=${fingerprint} then coalesce(j.attempts,0) else 0 end attempts from complaint c left join complaint_address_candidate a on a.complaint_id=c.complaint_id left join complaint_location_initialization j on j.complaint_id=c.complaint_id where coalesce(c.deleted,0)=0 and ((c.location_lng is null and c.location_lat is null) or c.location_coordinate_source like '待纠偏：%') and (j.complaint_id is null or j.input_hash<>${fingerprint} or (j.state='retry' and j.next_attempt_at<=now()) or (j.state='review' and j.reason not like '细化定位v3：%')) order by c.id limit ?`,[Math.min(100,Math.max(1,limit))]);
 for(const row of rows){
 let state='review',reason='缺少可可靠定位的详细地址，请在诉求核验中补充或选择位置',point:InitialPoint|null=null;let retryProvider=false;
 const address=initializationAddress(row);
 row.effective_field_state=await initializationState(conn,row);
 const candidate={...row,address};
 if(!mayRefineLocation(row)){state='preserved';reason='保留人工位置决定，自动初始化不覆盖';}
 else {point=cachedLocation(candidate);if(point){state='review';reason=point.source;}
 const extracted=locationCandidates(candidate);
 const query=locationQuery(candidate)??(extracted[0]?'湖北省宜昌市'+(extracted[0].districtName??'')+extracted[0].name:null);
 if(!point&&query&&(!key||Date.now()<providerUnavailableUntil))retryProvider=true;
 if(!point&&query&&key&&Date.now()>=providerUnavailableUntil){try{
 const forward=await provider({ds:JSON.stringify({keyWord:query})},key);
 if(String(forward?.status)!=='0')throw new Error('地图服务未返回成功结果');
 const p=forward.location;
 if(p&&Number.isFinite(Number(p.lon))&&Number.isFinite(Number(p.lat))){const reverse=await provider({postStr:JSON.stringify({lon:Number(p.lon),lat:Number(p.lat),ver:1}),type:'geocode'},key);const exact=acceptGeocode(forward,reverse,row);point=exact?{...exact,coordinateSystem:'CGCS2000',source:''}:acceptApproximateGeocode(forward,reverse,row);}
 if(point){state=point.source?'review':'matched';reason=point.source||`天地图自动地址定位，匹配分数${point.score}，级别${point.level}，已核对宜昌市及区县；坐标系CGCS2000，非人工核验`;}
 else reason='地址匹配不够精确、匹配区县不一致或无详细点位，请人工核验';
 }catch{retryProvider=true;providerUnavailableUntil=Date.now()+10*60*1000;state='retry';reason=state==='retry'?'地图服务暂不可用，稍后自动重试':'地图服务连续失败，请人工核验地址';}}}
 if(state!=='preserved'&&!point){point=fallbackLocation(candidate);if(point){state='review';reason=point.source;}else if(!key&&locationQuery(candidate)){state='retry';reason='地图服务未配置，保留地址待自动重试';}else if(state==='review')reason='降级定位已检查：'+reason;}
 if(retryProvider&&state!=='preserved'){state='retry';if(!point)reason='地图服务暂不可用，保留现有位置等待进一步定位';}
 await conn.beginTransaction();
 try{
 const [[current]]=await conn.query<any[]>('select * from complaint where complaint_id=? for update',[row.complaint_id]);
 const [[evidence]]=await conn.query<any[]>(`select ${fingerprint} init_hash from complaint c left join complaint_address_candidate a on a.complaint_id=c.complaint_id where c.complaint_id=? for update`,[row.complaint_id]);
 if(!current||evidence?.init_hash!==row.init_hash||Number(current.edit_version)!==Number(row.edit_version)){await conn.rollback();continue;}
 const fields=await initializationState(conn,current);
 if(!mayRefineLocation({...current,effective_field_state:fields})){state='preserved';reason='保留现有位置或人工核验决定，自动定位不覆盖';point=null;}
 if(point&&shouldImproveLocation(current,point)){
 const version=Number(current.edit_version)+1;
 for(const [field,value] of Object.entries({location_lng:point.longitude,location_lat:point.latitude,location_coordinate_system:point.coordinateSystem,location_coordinate_source:reason}))fields[field]={resolution:'unresolved',value,version,reason};
 await conn.query('update complaint set location_lng=?,location_lat=?,location_coordinate_system=?,location_coordinate_source=?,effective_field_state=?,edit_version=edit_version+1 where complaint_id=?',[point.longitude,point.latitude,point.coordinateSystem,reason,JSON.stringify(fields),row.complaint_id]);
 await insertAudit(conn,{userId:null,appCode:'gqxq',resourceCode:'location',action:'LOCATION_AUTO_INITIALIZE',bizType:'complaint',bizId:row.complaint_id,result:'success',clientIp:null,createdAt:new Date(),detail:{provider:point.level==='区县代表点'?'datav-district':'tianditu',coordinateSystem:point.coordinateSystem,needsCorrection:state==='review',score:point.score,level:point.level}});
 }
 await conn.query('insert into complaint_location_initialization(complaint_id,input_hash,state,reason,attempts,next_attempt_at,updated_at) values(?,?,?,?,?,date_add(now(),interval 5 minute),now()) on duplicate key update input_hash=values(input_hash),state=values(state),reason=values(reason),attempts=values(attempts),next_attempt_at=values(next_attempt_at),updated_at=now()',[row.complaint_id,row.init_hash,state,'细化定位v3：'+reason,Number(row.attempts)+1]);
 await recognizeCommunityIn(conn,row.complaint_id);
 await conn.commit();counts.processed++;if(state in counts)(counts as any)[state]++;
 }catch(e){await conn.rollback();throw e}
 }
 return counts;
 }finally{if(locked)await conn.query("select release_lock('gqxq-location-init')");conn.release();}
}
export function startLocationInitializer(){let busy=false;const run=async()=>{if(busy)return;busy=true;try{const result=await initializeLocations();if('processed' in result&&result.processed)console.log('[location-init]',JSON.stringify(result));}catch{console.error('[location-init] initialization retained for retry');}finally{busy=false;}};const timer=setInterval(()=>void run(),15000);timer.unref();void run();return ()=>clearInterval(timer);}
