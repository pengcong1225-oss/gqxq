import {Router} from 'express';
import {ok} from '../http/respond';
import {normalizeStatisticsQuery} from '../domain/statisticsQuery';
import {currentAccessContext} from '../auth/accessScope';
import {captureStatistics,assertStatisticsPermission,statisticsPage} from '../services/statisticsService';
import {parsePageQuery} from '../services/correctionService';
export const statisticsRouter=Router();
for(const detail of [false,true])statisticsRouter.get('/statistics/'+(detail?'complaints':'summary'),async(req,res,next)=>{
 try{const {page:rawPage,size:rawSize,...raw}=req.query;const access=req.accessContext??currentAccessContext();const q=normalizeStatisticsQuery(raw,access);const grants=req.user?.permissionCodes??[];assertStatisticsPermission(q,grants,detail);const {page,size}=parsePageQuery({page:rawPage,size:rawSize});const captured=await captureStatistics(q,access,grants);ok(res,detail?statisticsPage(captured,page,size):captured.summary);}catch(e){next(e);}
});
