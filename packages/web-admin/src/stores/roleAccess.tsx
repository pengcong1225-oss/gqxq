// UI visibility uses current backend effective permissions. Server repeats
// enforcement for every endpoint; role labels do not imply business privileges.
import React, { useMemo } from 'react';
import { Tooltip } from 'antd';
import { useAppStore } from './appStore';

export const ROLE_ADMIN = 'admin';
export const ROLE_HANDLER = 'handler';
export const ROLE_READONLY = 'readonly';

/** 与后端 ROLE_LABELS 同步；后端 /users 响应里的 roleNames 就是它 */
export const ROLE_LABELS: Record<string, string> = {
  [ROLE_ADMIN]: '系统管理员',
  [ROLE_HANDLER]: '业务经办',
  [ROLE_READONLY]: '只读',
};

/** 与 server 的 AppError.forbidden() 默认文案逐字一致 */
export const FORBIDDEN_MESSAGE = '无权限，请联系管理员';

export const READONLY_TIP = '只读档无写权限：需要操作请由业务经办或系统管理员执行';
export const ADMIN_ONLY_TIP = '当前账号未获管理功能授权';

function labelOf(role: string): string {
  return ROLE_LABELS[role] ?? '未知角色:' + role;
}

/** 当前登录者的角色集合；未登录/未取到为 [] */
export function useRoles(): string[] {
  const userInfo = useAppStore((s) => s.userInfo);
  return useMemo(() => userInfo?.roles ?? [], [userInfo]);
}

export function useIsAdmin(): boolean {
  const roles = useRoles();
  return useMemo(() => roles.includes(ROLE_ADMIN), [roles]);
}

/** 只读档：与后端硬不变量同口径（非 GET 一律不放行） */
export function useIsReadonly(): boolean {
  const roles = useRoles();
  return useMemo(() => roles.includes(ROLE_READONLY), [roles]);
}

/** 当前档位的中文名，如 "业务经办"；未登录给 '未登录' */
export function useRoleLabel(): string {
  const roles = useRoles();
  return useMemo(() => (roles.length === 0 ? '待授权' : roles.map(labelOf).join(' / ')), [roles]);
}

/**
 * 业务写权限判定（交办 / 纠偏确认 / 归库 / 推送 / 归档 / 回填等）。
 * can=false 时 tip 直接可用于 Tooltip 文案，避免各页面各写一句。
 */
export function usePermissionAccess(code: string): {can:boolean;tip:string} {
 const user=useAppStore(s=>s.userInfo);
 const protectedCode=code==='system.users.manage'||code==='system.roles.manage';
 const can=Boolean(user&&!user.mustChangePassword&&user.permissions.includes(code)&&(!protectedCode||user.roles.includes('admin')));
 return {can,tip:can?'':'当前账号未获此功能授权'};
}
export function useWriteAccess(code='complaint.correct'): {can:boolean;tip:string} {
 const access=usePermissionAccess(code);
 const roles=useRoles();
 return roles.includes('readonly')?{can:false,tip:READONLY_TIP}:access;
}
export function useAdminAccess(code='system.users.manage'): {can:boolean;tip:string} {
 return usePermissionAccess(code);
}

/**
 * 按角色放行一个操作入口：allowed=false 时把子按钮置灰并说明原因。
 *
 * 复用既有交付模式（未实现按钮就是 disabled + Tooltip + span 包一层，
 * 见 CompanyList / DictManager），差别只在文案给的是"谁的权限"而不是"哪个批次"。
 * 外层 span 是必需的：disabled 的按钮不触发鼠标事件，Tooltip 得挂在能收事件的节点上。
 */
export const WriteGate: React.FC<{
  allowed: boolean;
  tip: string;
  children: React.ReactElement<{ disabled?: boolean }>;
}> = ({ allowed, tip, children }) => {
  if (allowed) return children;
  return (
    <Tooltip title={tip}>
      <span style={{ display: 'inline-block' }}>
        {React.cloneElement(children, { disabled: true })}
      </span>
    </Tooltip>
  );
};
