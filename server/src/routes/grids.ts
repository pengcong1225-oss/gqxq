import {Router,type Request} from 'express';
import {currentAccessContext} from '../auth/accessScope';
import {serviceGridService as service} from '../services/serviceGridService';
import {AppError} from '../http/errors';
import {ok} from '../http/respond';
import type {MasterDataContext} from '../types/masterData';
export const gridsRouter=Router();
const context=(req:Request):MasterDataContext=>({userId:req.user!.id,userName:req.user!.username,clientIp:req.ip??null,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()});
function at(req:Request){if(req.query.at!==undefined&&typeof req.query.at!=='string')throw AppError.validation('日期参数无效');return req.query.at as string|undefined;}
gridsRouter.get('/grid-reference-options',async(req,res,next)=>{try{ok(res,await service.referenceOptions(context(req)));}catch(e){next(e);}});
gridsRouter.get('/grids',async(req,res,next)=>{try{ok(res,await service.list({page:Number(req.query.page??1),size:Number(req.query.size??20)},context(req)));}catch(e){next(e);}});
gridsRouter.post('/grids',async(req,res,next)=>{try{ok(res,await service.save(req.body,context(req)));}catch(e){next(e);}});
gridsRouter.patch('/grids/:code',async(req,res,next)=>{try{if(req.body.code&&req.body.code!==req.params.code)throw AppError.validation('稳定编码不能修改');ok(res,await service.save({...req.body,code:req.params.code},context(req)));}catch(e){next(e);}});
gridsRouter.get('/grids/:code',async(req,res,next)=>{try{ok(res,await service.detail(req.params.code,context(req),at(req)));}catch(e){next(e);}});
gridsRouter.get('/grids/:code/history',async(req,res,next)=>{try{ok(res,await service.history(req.params.code,context(req)));}catch(e){next(e);}});
gridsRouter.get('/grids/:code/boundary',async(req,res,next)=>{try{ok(res,await service.boundary(req.params.code,context(req),at(req)));}catch(e){next(e);}});
gridsRouter.post('/admin-grids',async(req,res,next)=>{try{ok(res,await service.saveAdmin(req.body,context(req)));}catch(e){next(e);}});
gridsRouter.get('/admin-grids/:code',async(req,res,next)=>{try{ok(res,await service.adminDetail(req.params.code,context(req)));}catch(e){next(e);}});
gridsRouter.post('/communities',async(req,res,next)=>{try{ok(res,await service.saveCommunity(req.body,context(req)));}catch(e){next(e);}});
