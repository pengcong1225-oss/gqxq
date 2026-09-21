// 前端角色口径（Task #35 三档 RBAC）—— 与 server/src/auth/rolePolicy.ts 同一套常量。
//
// **前端过滤只是体验层**：真正的判定在后端 enforceRolePolicy()，
// 前端漏藏一个按钮不会造成越权（点了也是 403 + ACCESS_DENIED 审计）；
// 但反过来，"看得见却点不动"最容易被当成系统坏了，所以：
//   * 菜单按角色过滤（MainLayout）；
//   * 写操作按钮禁用并给出原因（WriteGate / ADMIN_ONLY_TIP）；
//   * 403 统一文案（request.ts 拦截器 + 本文件的 FORBIDDEN_MESSAGE，两处同一句）。
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
export const ADMIN_ONLY_TIP = '该操作仅系统管理员可用（用户管理与字典管理属 admin 独占）';

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
  return useMemo(() => roles.length > 0 && !roles.includes(ROLE_ADMIN) && !roles.includes(ROLE_HANDLER), [roles]);
}

/** 当前档位的中文名，如 "业务经办"；未登录给 '未登录' */
export function useRoleLabel(): string {
  const roles = useRoles();
  return useMemo(() => (roles.length === 0 ? '未登录' : roles.map(labelOf).join(' / ')), [roles]);
}

/**
 * 业务写权限判定（交办 / 纠偏确认 / 归库 / 推送 / 归档 / 回填等）。
 * can=false 时 tip 直接可用于 Tooltip 文案，避免各页面各写一句。
 */
export function useWriteAccess(): { can: boolean; tip: string } {
  const roles = useRoles();
  return useMemo(() => {
    const can = roles.includes(ROLE_ADMIN) || roles.includes(ROLE_HANDLER);
    return { can, tip: can ? '' : READONLY_TIP };
  }, [roles]);
}

/** admin 独占判定（用户管理、字典管理） */
export function useAdminAccess(): { can: boolean; tip: string } {
  const roles = useRoles();
  return useMemo(() => {
    const can = roles.includes(ROLE_ADMIN);
    return { can, tip: can ? '' : ADMIN_ONLY_TIP };
  }, [roles]);
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
