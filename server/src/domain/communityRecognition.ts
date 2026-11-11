import regions from '../data/yichangTownships.snapshot.json';
import {parseFieldState} from './effectiveFieldPolicy';
import {locationCandidates,type LocationCandidate} from './locationCandidates';
export interface CommunityPoint {name:string;districtCode:string|null;providerLevel:string;score:number;longitude:number;latitude:number}
export function recognizedCommunity(row:Record<string,unknown>,candidates:LocationCandidate[],p:CommunityPoint):boolean{
 if(regions.counties.some(c=>c.code!==(row.district_code||p.districtCode)&&[row.address,row.title,row.content].some(t=>String(t??'').includes(c.name))))return false;
 const county=regions.counties.find(c=>c.code===p.districtCode);
 if(!county||row.district_name&&row.district_name!==county.name)return false;
 const residential=candidates.filter(c=>/(小区|花园|家园|公寓|家属院|苑)$/.test(c.name));
 if(candidates.length>=8||new Set(residential.map(c=>c.name)).size!==1||residential[0]?.name!==p.name)return false;
 if(p.score<95||p.providerLevel!=='兴趣点'||!p.districtCode||row.district_code&&row.district_code!==p.districtCode)return false;
 if(row.address&&locationCandidates({address:row.address,district_code:row.district_code}).some(c=>/(小区|花园|家园|公寓|家属院|苑)$/.test(c.name)&&c.name!==p.name))return false;
 if(Math.abs(Number(row.location_lng)-p.longitude)>1e-7||Math.abs(Number(row.location_lat)-p.latitude)>1e-7)return false;
 const states=parseFieldState(row.effective_field_state);
 if(!['location_lng','location_lat','location_coordinate_system','location_coordinate_source'].every(k=>states[k]?.resolution==='unresolved'))return false;
 if(['address','district_code','district_name'].some(k=>states[k]&&(['confirmed','no_correction'].includes(states[k].resolution)||states[k].correctionId)))return false;
 return true;
}
