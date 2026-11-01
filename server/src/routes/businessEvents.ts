import {Router,type Request} from 'express';
import {currentAccessContext} from '../auth/accessScope';
import {ok} from '../http/respond';
import {businessEventService as service} from '../services/businessEventService';
import {receiveSourceProcesses} from '../services/sourceProcessIngressService';
import {env} from '../config/env';
import type {BusinessEventContext,BusinessSourceConfig} from '../types/businessEvents';
export const businessEventsRouter=Router(),businessSourceRouter=Router();
export const businessContext=(req:Request):BusinessEventContext=>({userId:req.user!.id,userName:req.user!.username,clientIp:req.ip,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()});
export function businessSourceConfigs():BusinessSourceConfig[]{try{const value:unknown=JSON.parse(env.businessSources);return Array.isArray(value)?value.filter((c):c is BusinessSourceConfig=>c!==null&&typeof c==='object'&&typeof c.sourceId==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(c.sourceId)&&typeof c.keyId==='string'&&typeof c.secret==='string'&&c.secret.length>=32&&Number.isInteger(c.maxSkewSeconds)&&c.maxSkewSeconds>=1&&c.maxSkewSeconds<=900):[];}catch{return [];}}
businessSourceRouter.post('/events',async(req,res,next)=>{try{ok(res,await service.receive(req.rawBody??Buffer.alloc(0),{sourceId:req.get('x-source-id')??'',keyId:req.get('x-key-id')??'',timestamp:req.get('x-source-timestamp')??'',signature:req.get('x-source-signature')??''},businessSourceConfigs(),req.ip??null));}catch(e){next(e);}});
businessSourceRouter.post('/processes',async(req,res,next)=>{try{ok(res,await receiveSourceProcesses(req.rawBody??Buffer.alloc(0),{sourceId:req.get('x-source-id')??'',keyId:req.get('x-key-id')??'',timestamp:req.get('x-source-timestamp')??'',signature:req.get('x-source-signature')??''},businessSourceConfigs(),req.ip??null));}catch(e){next(e);}});
for(const [path,kind] of [['shutdowns','shutdown'],['pipeline-projects','pipeline'],['synchronized-followups','followup']] as const){
 businessEventsRouter.get('/'+path,async(req,res,next)=>{try{ok(res,await service.list(kind,req.query,businessContext(req)));}catch(e){next(e);}});
 businessEventsRouter.get('/'+path+'/:id',async(req,res,next)=>{try{ok(res,await service.detail(kind,req.params.id,businessContext(req)));}catch(e){next(e);}});
}
