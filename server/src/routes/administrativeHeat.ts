import {Router} from 'express';
import {currentAccessContext} from '../auth/accessScope';
import {ok} from '../http/respond';
import {administrativeHeat} from '../services/administrativeHeatService';
export const administrativeHeatRouter=Router();
for(const detail of [false,true])administrativeHeatRouter.get('/heatmap/administrative-'+(detail?'complaints':'data'),async(req,res,next)=>{try{ok(res,await administrativeHeat(req.query as Record<string,unknown>,{userId:req.user!.id,userName:req.user!.username,clientIp:req.ip??null,access:req.accessContext??currentAccessContext(),permissionCodes:req.user?.permissionCodes??[]},detail));}catch(e){next(e);}});
