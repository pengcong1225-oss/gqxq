import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { PERMISSION_CATALOG, PROTECTED_PERMISSIONS } from '../auth/permissionCatalog';
import { getRoles, writeRole } from '../services/roleService';
import { requirePermission } from '../middleware/requireRole';

export const rolesRouter = Router();
const roleCodeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const writeSchema = z.object({
  name:z.string().trim().min(1).max(64).optional(), description:z.string().trim().max(500).optional(),
  enabled:z.boolean().optional(), permissionCodes:z.array(z.string()).max(100).optional(),
  expectedVersion:z.number().int().min(0), copyFrom:roleCodeSchema.optional(),
}).strict();
rolesRouter.get('/roles', requirePermission('system.roles.manage'), async (_req,res,next) => {
  try { ok(res,await getRoles()); } catch(err) { next(err); }
});
rolesRouter.get('/permissions', requirePermission('system.roles.manage'), (_req,res) => {
  ok(res,PERMISSION_CATALOG.map(([code,name])=>({code,name,protected:PROTECTED_PERMISSIONS.includes(code)})));
});
for (const creating of [true,false]) {
  rolesRouter[creating ? 'post' : 'patch'](creating ? '/roles' : '/roles/:roleCode', requirePermission('system.roles.manage'), async (req,res,next) => {
    try {
      const roleCode = roleCodeSchema.safeParse(creating ? req.body?.roleCode : req.params.roleCode);
      const body = {...req.body}; delete body.roleCode;
      const input = writeSchema.safeParse(body);
      if (!roleCode.success || !input.success) throw AppError.validation('角色请求参数不合法');
      ok(res, await writeRole(roleCode.data,input.data,creating,{userId:req.user!.id,userName:req.user!.username,clientIp:req.remoteIp}));
    } catch(err) { next(err); }
  });
}
