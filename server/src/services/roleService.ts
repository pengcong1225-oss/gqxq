import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { bumpAuthorization, findRole, listRoles, lockAuthorization, resolveAuthorizationFrom, saveRole } from '../repositories/roleRepo';
import { isPermissionCode, PROTECTED_PERMISSIONS, type PermissionCode, type PlatformRole } from '../auth/permissionCatalog';
import type { OperatorContext } from './dispatchService';

const ACTION_ROLE_CREATE = 'ROLE_CREATE'; // gate-g1-allow: audit action follows the existing uppercase audit lineage.
const ACTION_ROLE_UPDATE = 'ROLE_UPDATE'; // gate-g1-allow: audit action follows the existing uppercase audit lineage.

export { PERMISSION_CATALOG, type EffectiveAuthorization } from '../auth/permissionCatalog';
export async function resolveAuthorization(userId: string) { return resolveAuthorizationFrom(pool, userId); }
export async function getRoles() { return listRoles(pool); }
export interface RoleWriteInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  permissionCodes?: string[];
  expectedVersion: number;
  copyFrom?: string;
}
function validatedPermissions(codes: string[]): PermissionCode[] {
  if (codes.some(code => !isPermissionCode(code))) throw AppError.validation('存在未登记的权限代码');
  if (codes.some(code => PROTECTED_PERMISSIONS.includes(code as PermissionCode))) throw AppError.forbidden('管理员账号与角色管理权限不能授予业务角色');
  return [...new Set(codes)] as PermissionCode[];
}
export async function writeRole(roleCode: string, input: RoleWriteInput, creating: boolean, ctx: OperatorContext): Promise<PlatformRole> {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(roleCode) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
    (creating && !input.name?.trim()) || (input.name !== undefined && (!input.name.trim() || input.name.length > 64)) ||
    (input.description !== undefined && input.description.length > 500)) throw AppError.validation('角色参数不合法');
  return withTransaction(async tx => {
    await lockAuthorization(tx);
    const existing = await findRole(tx, roleCode);
    if (creating && existing) throw AppError.conflict('角色代码已存在');
    if (!creating && !existing) throw AppError.notFound('角色不存在');
    if (input.expectedVersion !== (existing?.version ?? 0)) throw AppError.conflict('角色版本已变化，请刷新后重试');
    if (!creating && input.copyFrom) throw AppError.validation('复制角色只用于新建');
    let copied: PlatformRole | null = null;
    if (input.copyFrom) {
      copied = await findRole(tx, input.copyFrom);
      if (!copied || !copied.enabled) throw AppError.validation('复制来源角色不存在或已停用');
      if (copied.roleCode === 'admin') throw AppError.forbidden('不能复制管理员角色');
    }
    let codes = input.permissionCodes ?? copied?.permissionCodes ?? existing?.permissionCodes ?? [];
    if (existing?.roleCode === 'admin') {
      if (input.enabled === false || input.permissionCodes !== undefined) throw AppError.forbidden('内置管理员启用状态及权限受保护');
    } else {
      codes = validatedPermissions(codes);
    }
    const role: PlatformRole = {
      roleCode, name: input.name?.trim() ?? existing!.name, description: input.description ?? existing?.description ?? '',
      enabled: input.enabled ?? existing?.enabled ?? true, builtIn: existing?.builtIn ?? false,
      version: (existing?.version ?? 0) + 1, permissionCodes: codes as PermissionCode[],
    };
    await saveRole(tx, role, creating);
    await bumpAuthorization(tx);
    await insertAudit(tx, {userId:ctx.userId,appCode:'gqxq',resourceCode:'role',action:creating ? ACTION_ROLE_CREATE : ACTION_ROLE_UPDATE,
      bizType:'role',bizId:roleCode,result:'success',clientIp:ctx.clientIp,detail:{before:existing,after:role},createdAt:new Date()});
    return role;
  });
}
