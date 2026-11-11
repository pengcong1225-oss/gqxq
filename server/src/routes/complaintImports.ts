import {Router,raw,type Request} from 'express';
import {ok} from '../http/respond';
import {AppError} from '../http/errors';
import {currentAccessContext} from '../auth/accessScope';
import {complaintImportService,type ComplaintImportContext} from '../services/complaintImportService';
export const complaintImportsRouter=Router();
const context=(req:Request):ComplaintImportContext=>({userId:req.user!.id,userName:req.user!.username,clientIp:req.ip??null,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext(),sessionVersion:req.user?.sessionVersion});
complaintImportsRouter.post('/complaint-imports/preview',(req,res,next)=>raw({type:'application/octet-stream',limit:'10mb'})(req,res,error=>next(error?.type==='entity.too.large'?new AppError('PAYLOAD_TOO_LARGE','文件超过 10 MB，请拆批导入'):error)),async(req,res,next)=>{try{
 if(!Buffer.isBuffer(req.body)||typeof req.query.name!=='string'||!req.query.name.trim()||req.query.name.length>200)throw AppError.validation('请选择有效的 Excel 文件');
 ok(res,await complaintImportService.preview({name:req.query.name,bytes:req.body},context(req)));
}catch(e){next(e);}});
complaintImportsRouter.get('/complaint-imports',async(req,res,next)=>{try{ok(res,await complaintImportService.list(context(req)));}catch(e){next(e);}});
complaintImportsRouter.get('/complaint-imports/:batchId',async(req,res,next)=>{try{ok(res,await complaintImportService.get(req.params.batchId,context(req)));}catch(e){next(e);}});
complaintImportsRouter.post('/complaint-imports/:batchId/commit',async(req,res,next)=>{try{ok(res,await complaintImportService.commit(req.params.batchId,req.body?.requestId,context(req)));}catch(e){next(e);}});
