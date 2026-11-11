import {normalizeStatisticsQuery,shanghaiToday} from '../domain/statisticsQuery';
import {AppError} from '../http/errors';
import type {AccessContext} from '../auth/accessScope';
import type {ScreenQuery} from '../domain/screen';

export function normalizeScreenQuery(raw:Record<string,unknown>,access:AccessContext,permissions:readonly string[]){
 const allowed=['mode','from','to','periodKind','businessType','districtCode','enterpriseCode','adminGridCode','communityCode','categoryCode'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))throw AppError.validation('不支持的筛选参数');
 const mode=raw.mode??'real';
 if(mode!=='real'&&mode!=='simulation')throw AppError.validation('mode 须为 real 或 simulation');
 const {mode:_,adminGridCode,communityCode,categoryCode,...fields}=raw;
 if((adminGridCode||communityCode)&&(!permissions.includes('grid.read')||!permissions.includes('heatmap.read')))throw AppError.forbidden('缺少网格或热力查询权限');
 for(const value of [adminGridCode,communityCode,categoryCode]){
  if(value!==undefined&&(typeof value!=='string'||value.length===0||value.length>100||/[\x00-\x1f]/.test(value)))throw AppError.validation('筛选编码无效');
 }
 const today=shanghaiToday(),normalizedFields={...fields};
 for(const key of ['districtCode','enterpriseCode'])if(normalizedFields[key]==='__missing__')normalizedFields[key]='MISSING';
 const query=normalizeStatisticsQuery({dataset:'ledger',projection:'current',comparisonPolicyId:'candidate-calendar-v1',periodKind:'custom',from:today.slice(0,7)+'-01',to:today,...normalizedFields},access);
 for(const key of ['districtCode','enterpriseCode'] as const)if(fields[key]==='__missing__')query[key]='__missing__';
 if(query.businessType&&!['water','gas'].includes(query.businessType))throw AppError.validation('业务类型仅支持 water 或 gas');
 const screen:ScreenQuery={mode,from:query.from,to:query.to,districtCode:query.districtCode,enterpriseCode:query.enterpriseCode,businessType:query.businessType,adminGridCode:adminGridCode as string|undefined,communityCode:communityCode as string|undefined,categoryCode:categoryCode as string|undefined};
 return {mode:mode as 'real'|'simulation',today,query,screen};
}
