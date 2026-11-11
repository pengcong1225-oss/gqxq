import {Router} from 'express';
import type {Request,RequestHandler} from 'express';
import {ok} from '../http/respond';
import {AppError} from '../http/errors';
import {getFollowups,createFollowup,reviseFollowup,concludeFollowup} from '../services/followupService';
/** Manual followup facts use the service's current actor/scope/version checks. */
export const followupsRouter=Router();
const actor=(req:Request)=>({userId:req.user?.id??null,clientIp:req.remoteIp??null});
const guarded=(run:(req:Request)=>Promise<unknown>):RequestHandler=>async(req,res,next)=>{res.setHeader('Cache-Control','no-store');try{if(!req.user?.id)throw AppError.unauthenticated();ok(res,await run(req));}catch(error){next(error);}};
followupsRouter.get('/complaints/:idOrNo/followups',guarded(req=>getFollowups(String(req.params.idOrNo),actor(req))));
followupsRouter.post('/complaints/:idOrNo/followups',guarded(req=>createFollowup({...req.body,complaintId:String(req.params.idOrNo)},actor(req))));
followupsRouter.patch('/followups/:followupId',guarded(req=>reviseFollowup(String(req.params.followupId),req.body,actor(req))));
followupsRouter.patch('/followups/:followupId/conclusion',guarded(req=>concludeFollowup(String(req.params.followupId),req.body,actor(req))));
