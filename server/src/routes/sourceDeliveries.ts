import {Router,type Request} from 'express';
import {z} from 'zod';
import {env} from '../config/env';
import {ok} from '../http/respond';
import {AppError} from '../http/errors';
import {currentAccessContext} from '../auth/accessScope';
import {receiveSourceProcesses} from '../services/sourceProcessIngressService';
import {businessEventService} from '../services/businessEventService';
import type {BusinessEventContext,BusinessSourceConfig} from '../types/businessEvents';

const configSchema=z.array(z.object({sourceId:z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),sourceSystem:z.string().min(1).max(64).optional(),keyId:z.string().min(1).max(128),secret:z.string().min(32),maxSkewSeconds:z.number().int().min(1).max(900),complaintTargets:z.array(z.object({sourceSystem:z.string().min(1),allEnterprises:z.boolean().optional(),enterpriseCodes:z.array(z.string().min(1)).optional()}).strict()).optional()}).strict());
export function sourceDeliveryConfigs():BusinessSourceConfig[]{
 try{const result=configSchema.safeParse(JSON.parse(env.businessSources));if(!result.success)return [];const ids=result.data.map(x=>x.sourceId);return new Set(ids).size===ids.length?result.data:[];}catch{return [];}
}
const headers=(req:Request)=>({sourceId:req.get('x-source-id')??'',keyId:req.get('x-key-id')??'',timestamp:req.get('x-source-timestamp')??'',signature:req.get('x-source-signature')??''});
const context=(req:Request):BusinessEventContext=>({userId:req.user!.id,userName:req.user!.username,clientIp:req.ip,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()});
export const sourceDeliveryRouter=Router(),synchronizedFollowupsRouter=Router();
sourceDeliveryRouter.post('/processes',async(req,res,next)=>{try{ok(res,await receiveSourceProcesses(req.rawBody??Buffer.alloc(0),headers(req),sourceDeliveryConfigs(),req.ip??null));}catch(e){next(e);}});
sourceDeliveryRouter.post('/events',async(req,res,next)=>{try{
 // Stop/construction records continue to use the authenticated public-utility feed.
 if(req.body?.kind!=='followup')throw AppError.validation('此入口仅接收外部回访；申请审批使用填报系统同步接口');
 ok(res,await businessEventService.receive(req.rawBody??Buffer.alloc(0),headers(req),sourceDeliveryConfigs(),req.ip??null));
}catch(e){next(e);}});
synchronizedFollowupsRouter.get('/synchronized-followups',async(req,res,next)=>{try{ok(res,await businessEventService.list('followup',req.query,context(req)));}catch(e){next(e);}});
synchronizedFollowupsRouter.get('/synchronized-followups/:id',async(req,res,next)=>{try{ok(res,await businessEventService.detail('followup',req.params.id,context(req)));}catch(e){next(e);}});
