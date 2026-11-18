import {recognizeCommunityIn} from './communityRecognitionService';
import {locationCandidates,cachedLocation,mayRefineLocation,shouldImproveLocation} from '../domain/locationCandidates';
import {fallbackLocation,acceptApproximateGeocode,type InitialPoint} from '../domain/locationFallback';
import {pool} from '../db/pool';
import {mayInitialize,locationQuery,acceptGeocode,initializationAddress} from '../domain/locationInitialization';
import {parseFieldState} from '../domain/effectiveFieldPolicy';
import type {Tx} from '../db/tx';
import {loadEffectiveFieldState} from '../repositories/effectiveFieldRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {amapGeocode,amapRegeocode,amapConfigured} from '../clients/amapGeocoder';
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
/**
 * 地址解析（标书 1.2.12 指定高德；天地图已全部下线，不再作为兜底）。
 * 返回 { point, state, reason }：point=null 表示未能定位（由调用方决定重试/人工核验）。
 * 校验口径：宜昌市域 + 区县一致；不一致直接拒绝，不猜。
 */
async function resolveByAmap(row: Record<string, unknown>, query: string | null): Promise<{ point: InitialPoint | null; state: 'matched' | 'review' | 'retry'; reason: string }> {
  if (!amapConfigured()) return { point: null, state: 'retry', reason: '未配置高德 Key' };
  if (!query) return { point: null, state: 'review', reason: '缺少可解析的地址' };
  const forward = await amapGeocode(query);
  if (!forward.ok || forward.longitude === null || forward.latitude === null) {
    return { point: null, state: 'retry', reason: forward.reason ?? '高德地理编码无结果' };
  }
  const reverse = await amapRegeocode(forward.longitude, forward.latitude);
  if (!reverse.ok) return { point: null, state: 'retry', reason: reverse.reason ?? '高德逆地理编码无结果' };
  // 区县一致性校验
  const expectedCode = String(row.district_code ?? '').trim();
  const expectedName = String(row.district_name ?? '').trim();
  if (expectedCode && !String(reverse.adcode ?? '').startsWith(expectedCode.slice(0, 6))) {
    return { point: null, state: 'review', reason: '高德匹配区县与诉求区划不一致，需人工核验' };
  }
  if (!expectedCode && expectedName && reverse.district !== expectedName) {
    return { point: null, state: 'review', reason: '高德匹配区县名称与诉求区划不一致，需人工核验' };
  }
  const level = forward.level ?? '未知';
  const precise = ['门牌号', '门址', '兴趣点', '建筑物', '道路', '道路交叉路口'].includes(level);
  const point: InitialPoint = {
    longitude: forward.longitude,
    latitude: forward.latitude,
    score: precise ? 100 : 60,
    level: String(level),
    coordinateSystem: 'WGS84',
    source: precise
      ? ''
      : '待纠偏：高德近似地址定位（' + String(level) + '），已核对宜昌市及区县；坐标系GCJ02已转WGS84；非人工核验',
  };
  return {
    point,
    state: precise ? 'matched' : 'review',
    reason: precise
      ? '高德地址解析（' + String(level) + '），已核对宜昌市及区县；坐标系GCJ02→WGS84；非人工核验'
      : '高德近似地址定位（' + String(level) + '），需人工核验',
  };
}

export async function initializeLocations(limit=20){
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
 // 标书 1.2.12 指定高德：地理编码只走高德（天地图已下线）。
 if(!point&&query&&amapConfigured()){
  const r=await resolveByAmap(row,query);point=r.point;reason=r.reason;
  state=r.state==='matched'?(r.point&&r.point.source?'review':'matched'):r.state;
  if(r.state==='retry')retryProvider=true;
 }
 if(!point&&query&&!amapConfigured()){retryProvider=true;state='retry';reason='未配置高德 Key，无法自动定位；已保留地址待配置后重试';}}
 if(state!=='preserved'&&!point){point=fallbackLocation(candidate);if(point){state='review';reason=point.source;}else if(!amapConfigured()&&locationQuery(candidate)){state='retry';reason='未配置高德 Key，保留地址待配置后自动重试';}else if(state==='review')reason='降级定位已检查：'+reason;}
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
