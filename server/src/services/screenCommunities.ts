import type {SqlExecutor} from '../repositories/userRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import type {AccessContext} from '../auth/accessScope';
import type {SupportCommunity} from '../types/tenderSupport';
/** 大屏小区点位只发布已完成抖动的坐标。 */
const LNG_MIN=110.0,LNG_MAX=112.3,LAT_MIN=29.5,LAT_MAX=31.8;
export interface ScreenCommunityFilter {districtCode?:string;adminGridCode?:string;communityCode?:string}

export async function readScreenCommunities(db:SqlExecutor,access:AccessContext,filter:ScreenCommunityFilter={}):Promise<SupportCommunity[]>{
 const all=access.rules.some(r=>r.kind==='all');
 const districtCodes=[...new Set(access.rules.flatMap(r=>r.kind==='restricted'?r.districtCodes:[]))].sort();
 if(!all&&districtCodes.length===0)return [];
 const parts:string[]=["c.jitter_state='succeeded'",'c.jitter_lng is not null','c.jitter_lat is not null'];
 const params:unknown[]=[];
 if(!all){parts.push('coalesce(a.district_code,c.district_code) in ('+districtCodes.map(()=>'?').join(',')+')');params.push(...districtCodes);}
 if(filter.districtCode&&filter.districtCode!=='__missing__'&&filter.districtCode!=='MISSING'){parts.push('coalesce(a.district_code,c.district_code)=?');params.push(filter.districtCode);}
 if(filter.adminGridCode){parts.push('c.admin_grid_code=?');params.push(filter.adminGridCode);}
 if(filter.communityCode){parts.push('c.code=?');params.push(filter.communityCode);}
 const rows=await rowsIn(db,'select c.code,c.name,c.admin_grid_code,c.jitter_lng,c.jitter_lat '+
  'from community c left join admin_grid a on a.code=c.admin_grid_code where '+
  parts.join(' and ')+' order by c.code limit 5000',params);
 const out:SupportCommunity[]=[];
 for(const row of rows){
  const longitude=Number(row.jitter_lng),latitude=Number(row.jitter_lat);
  if(!Number.isFinite(longitude)||!Number.isFinite(latitude))continue;
  if(longitude<LNG_MIN||longitude>LNG_MAX||latitude<LAT_MIN||latitude>LAT_MAX)continue;
  out.push({id:String(row.code),name:String(row.name),gridId:String(row.admin_grid_code??''),longitude,latitude,households:0,coordinateSource:'jitter'});
 }
 return out;
}
