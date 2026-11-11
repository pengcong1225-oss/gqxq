import { Router } from 'express';
import type { Request } from 'express';
import { currentAccessContext } from '../auth/accessScope';
import { requirePermission } from '../middleware/requireRole';
import { auditQueryService } from '../services/auditQueryService';
import { ok } from '../http/respond';
import type { AuditLogFilter } from '../types/api';
export const auditLogsRouter=Router();
const access=(req:Request)=>({...req.accessContext??currentAccessContext(),permissionCodes:req.user?.permissionCodes??[]});
auditLogsRouter.get('/audit-logs',requirePermission('system.audit.read'),async(req,res,next)=>{
 try{
  const {page='1',size='20',...filter}=req.query;
  ok(res,await auditQueryService.list(filter as AuditLogFilter,{page:Number(page),size:Number(size)},access(req)));
 }catch(error){next(error);}
});
auditLogsRouter.get('/audit-logs/:auditId',requirePermission('system.audit.read'),async(req,res,next)=>{
 try{ok(res,await auditQueryService.detail(req.params.auditId,access(req)));}catch(error){next(error);}
});
