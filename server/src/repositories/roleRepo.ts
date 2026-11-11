import type { SqlExecutor } from './userRepo';
import { isPermissionCode, type EffectiveAuthorization, type PermissionCode, type PlatformRole } from '../auth/permissionCatalog';

async function rows(exec: SqlExecutor, sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const [result] = await exec.query(sql, values) as [Record<string, unknown>[], unknown];
  return result;
}

/** All authorization writes take this singleton first, then role/user locks.
 * Global monotonic version avoids userVersion+roleVersion collisions. */
export async function lockAuthorization(exec: SqlExecutor): Promise<void> {
  await exec.query('select version from platform_authorization_state where id = 1 for update');
}
export async function bumpAuthorization(exec: SqlExecutor): Promise<void> {
  await exec.query('update platform_authorization_state set version = version + 1 where id = 1');
}
export async function listRoles(exec: SqlExecutor): Promise<PlatformRole[]> {
  const data = await rows(exec, 'select role_code, name, description, enabled, built_in, version from platform_role order by built_in desc, role_code');
  const permissions = await rows(exec, 'select role_code, permission_code from platform_role_permission order by permission_code');
  return data.map(row => ({
    roleCode: String(row.role_code), name: String(row.name), description: String(row.description ?? ''),
    enabled: Number(row.enabled) === 1, builtIn: Number(row.built_in) === 1, version: Number(row.version),
    permissionCodes: permissions.filter(p => p.role_code === row.role_code)
      .map(p => String(p.permission_code)).filter(isPermissionCode),
  }));
}
export async function findRole(exec: SqlExecutor, roleCode: string): Promise<PlatformRole | null> {
  return (await listRoles(exec)).find(role => role.roleCode === roleCode) ?? null;
}
export async function saveRole(exec: SqlExecutor, role: PlatformRole, creating: boolean): Promise<void> {
  if (creating) {
    await exec.query('insert into platform_role (role_code, name, description, enabled, built_in, version) values (?, ?, ?, ?, 0, 1)',
      [role.roleCode, role.name, role.description, role.enabled ? 1 : 0]);
  } else {
    await exec.query('update platform_role set name = ?, description = ?, enabled = ?, version = version + 1 where role_code = ?',
      [role.name, role.description, role.enabled ? 1 : 0, role.roleCode]);
  }
  await exec.query('delete from platform_role_permission where role_code = ?', [role.roleCode]);
  for (const code of role.permissionCodes) {
    await exec.query('insert into platform_role_permission (role_code, permission_code) values (?, ?)', [role.roleCode, code]);
  }
}
export async function resolveAuthorizationFrom(exec: SqlExecutor, userId: string): Promise<EffectiveAuthorization> {
  // One statement gives a consistent current role/status/version snapshot. Empty roles
  // represent pending identity; do not infer readonly or handler from missing grants.
  const data = await rows(exec,
    'select s.version as authorization_version, r.role_code, p.permission_code ' +
    'from app_user u cross join platform_authorization_state s ' +
    "left join platform_role r on json_type(u.roles) = 'ARRAY' and json_length(u.roles) = 1 and r.role_code = json_unquote(json_extract(u.roles, '$[0]')) and r.enabled = 1 and u.status = 1 " +
    'left join platform_role_permission p on p.role_code = r.role_code where u.user_id = ? and s.id = 1', [userId]);
  return {
    roleCodes: [...new Set(data.flatMap(row => row.role_code ? [String(row.role_code)] : []))],
    permissionCodes: [...new Set(data.map(row => String(row.permission_code ?? '')).filter(isPermissionCode))] as PermissionCode[],
    authorizationVersion: Number(data[0]?.authorization_version ?? 0),
  };
}
