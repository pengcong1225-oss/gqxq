import type {SqlExecutor} from '../repositories/userRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import type {AccessContext} from '../auth/accessScope';
import type {SupportCommunity} from '../types/tenderSupport';
import {env} from '../config/env';

/** 大屏小区点位：只读主数据定位结果；有抖动结果时展示抖动坐标，原坐标不被覆盖。
 * 返回 coordinateSource 明确标识展示坐标来源，前端不得把抖动坐标用于空间计算。
 *
 * 坐标来源可由 GQXQ_SCREEN_COORD_SOURCE 切换（original / jitter）：
 * 抖动只是在小区内部做几十米的打散，实测最大 27m；
 * 保留开关是为了能和原始高德坐标做 A/B 对照，排除"位移是抖动造成"的误判。 */
const USE_JITTER = env.screenCoordSource === 'jitter';
const LNG_MIN=110.0,LNG_MAX=112.3,LAT_MIN=29.5,LAT_MAX=31.8;
export interface ScreenCommunityFilter {districtCode?:string;adminGridCode?:string;communityCode?:string}
interface CommunityRow {code:string;name:string;admin_grid_code:string|null;district_code:string|null;grid_district:string|null;
 location_lng:unknown;location_lat:unknown;jitter_lng:unknown;jitter_lat:unknown;jitter_state:string|null}

export async function readScreenCommunities(db:SqlExecutor,access:AccessContext,filter:ScreenCommunityFilter={}):Promise<SupportCommunity[]>{
 const all=access.rules.some(r=>r.kind==='all');
 const districtCodes=[...new Set(access.rules.flatMap(r=>r.kind==='restricted'?r.districtCodes:[]))].sort();
 if(!all&&districtCodes.length===0)return [];
 const parts:string[]=['(c.location_lng is not null or c.jitter_lng is not null)'];
 const params:unknown[]=[];
 if(!all){parts.push('coalesce(a.district_code,c.district_code) in ('+districtCodes.map(()=>'?').join(',')+')');params.push(...districtCodes);}
 if(filter.districtCode&&filter.districtCode!=='__missing__'&&filter.districtCode!=='MISSING'){parts.push('coalesce(a.district_code,c.district_code)=?');params.push(filter.districtCode);}
 if(filter.adminGridCode){parts.push('c.admin_grid_code=?');params.push(filter.adminGridCode);}
 if(filter.communityCode){parts.push('c.code=?');params.push(filter.communityCode);}
 const rows=await rowsIn(db,'select c.code,c.name,c.admin_grid_code,c.district_code,coalesce(a.district_code,c.district_code) as grid_district,'+
  'c.location_lng,c.location_lat,c.jitter_lng,c.jitter_lat,c.jitter_state from community c left join admin_grid a on a.code=c.admin_grid_code where '+
  parts.join(' and ')+' order by c.code limit 5000',params) as unknown as CommunityRow[];
 const out:SupportCommunity[]=[];
 for(const row of rows){
  const jitter=USE_JITTER&&row.jitter_state==='succeeded'&&row.jitter_lng!=null&&row.jitter_lat!=null;
  const longitude=Number(jitter?row.jitter_lng:row.location_lng),latitude=Number(jitter?row.jitter_lat:row.location_lat);
  if(!Number.isFinite(longitude)||!Number.isFinite(latitude))continue;
  if(longitude<LNG_MIN||longitude>LNG_MAX||latitude<LAT_MIN||latitude>LAT_MAX)continue;
  if(!jitter&&row.location_lng==null)continue;
  out.push({id:String(row.code),name:String(row.name),gridId:String(row.admin_grid_code??''),longitude,latitude,households:0,coordinateSource:jitter?'jitter':'original'});
 }
 return out;
}
