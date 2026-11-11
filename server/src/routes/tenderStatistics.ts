import {Router} from 'express';
import {ok} from '../http/respond';
import {normalizeStatisticsQuery} from '../domain/statisticsQuery';
import {currentAccessContext} from '../auth/accessScope';
import {captureTenderStatistics,tenderCommunityPage} from '../services/tenderStatisticsService';
import {captureStatistics,assertStatisticsPermission} from '../services/statisticsService';
import {parsePageQuery} from '../services/correctionService';
import {AppError} from '../http/errors';
export const tenderStatisticsRouter=Router();
tenderStatisticsRouter.get('/statistics/tender',async(req,res,next)=>{
 try{const access=req.accessContext??currentAccessContext();const query=normalizeStatisticsQuery(req.query,access);ok(res,await captureTenderStatistics(query,access,req.user?.permissionCodes??[]));}catch(error){next(error);}
});
tenderStatisticsRouter.get('/statistics/tender/community-complaints',async(req,res,next)=>{
 try{
  const {communityCode,page:rawPage,size:rawSize,...raw}=req.query;
  if(typeof communityCode!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(communityCode))throw AppError.validation('小区编码无效');
  const access=req.accessContext??currentAccessContext(),query=normalizeStatisticsQuery(raw,access),permissions=req.user?.permissionCodes??[];
  assertStatisticsPermission(query,permissions,true);const {page,size}=parsePageQuery({page:rawPage,size:rawSize});
  ok(res,tenderCommunityPage(await captureStatistics(query,access,permissions),communityCode,page,size));
 }catch(error){next(error);}
});
