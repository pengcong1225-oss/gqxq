import {Router,type Request} from 'express';
import {AppError} from '../http/errors';
import {ok} from '../http/respond';
import {currentAccessContext} from '../auth/accessScope';
import {findEnterprises,findEnterpriseOptions} from '../repositories/enterpriseRepo';
import {enterpriseService} from '../services/enterpriseService';
import type {MasterDataContext} from '../types/masterData';
export const enterprisesRouter=Router();
function context(req:Request):MasterDataContext{return {userId:req.user!.id,userName:req.user!.username,clientIp:req.ip??null,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()};}
function str(v:unknown):string|undefined{return typeof v==='string'&&v.trim()?v.trim():undefined;}
enterprisesRouter.get('/enterprise-reference-options',async(req,res,next)=>{try{ok(res,await enterpriseService.referenceOptions());}catch(e){next(e);}});
enterprisesRouter.get('/enterprise-options',async(req,res,next)=>{try{ok(res,await findEnterpriseOptions(str(req.query.keyword)?.slice(0,100)));}catch(e){next(e);}});
enterprisesRouter.get('/enterprises',async(req,res,next)=>{try{const page=Number(req.query.page??1),size=Number(req.query.size??20);if(!Number.isInteger(page)||page<1||!Number.isInteger(size)||size<1||size>100||!Number.isSafeInteger((page-1)*size))throw AppError.validation('分页参数无效');ok(res,await findEnterprises({keyword:str(req.query.keyword)?.slice(0,100),businessType:str(req.query.businessType),status:str(req.query.status)},page,size));}catch(e){next(e);}});
enterprisesRouter.post('/enterprises',async(req,res,next)=>{try{if(req.body.expectedVersion!==undefined&&req.body.expectedVersion!==0)throw AppError.validation('新增版本必须为0');ok(res,await enterpriseService.save({...req.body,expectedVersion:0},context(req)));}catch(e){next(e);}});
enterprisesRouter.patch('/enterprises/:enterpriseCode',async(req,res,next)=>{try{if(req.body.enterpriseCode&&req.body.enterpriseCode!==req.params.enterpriseCode)throw AppError.validation('企业稳定编码不能修改');ok(res,await enterpriseService.save({...req.body,enterpriseCode:req.params.enterpriseCode},context(req)));}catch(e){next(e);}});
enterprisesRouter.get('/enterprises/:enterpriseCode',async(req,res,next)=>{try{ok(res,await enterpriseService.detail(req.params.enterpriseCode,context(req)));}catch(e){next(e);}});
enterprisesRouter.get('/enterprises/:enterpriseCode/households',async(req,res,next)=>{try{ok(res,await enterpriseService.householdHistory(req.params.enterpriseCode,context(req)));}catch(e){next(e);}});
enterprisesRouter.post('/enterprises/:enterpriseCode/households',async(req,res,next)=>{try{ok(res,await enterpriseService.saveHouseholds({...req.body,enterpriseCode:req.params.enterpriseCode},context(req)));}catch(e){next(e);}});
enterprisesRouter.get('/enterprises/:enterpriseCode/department-mappings',async(req,res,next)=>{try{ok(res,await enterpriseService.mappings(req.params.enterpriseCode,context(req)));}catch(e){next(e);}});
enterprisesRouter.post('/enterprises/:enterpriseCode/department-mappings',async(req,res,next)=>{try{ok(res,await enterpriseService.saveMapping({...req.body,enterpriseCode:req.params.enterpriseCode},context(req)));}catch(e){next(e);}});
