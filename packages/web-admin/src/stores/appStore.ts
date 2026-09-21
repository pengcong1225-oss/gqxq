import { create } from 'zustand';
import type { UserInfo } from '../types/api';

/**
 * 登录态。
 *
 * userInfo.roles 是前端 RBAC 过滤（菜单 / 操作按钮）的唯一依据，
 * 由登录响应或 GET /auth/user-info 写入 —— 见 MainLayout 的补水逻辑：
 * 本 store 只在内存里，刷新后 token 还在 localStorage 而 userInfo 没了，
 * 不补水就会出现"有令牌却看不出自己是什么档"的错觉。
 */
interface AppState {
  collapsed: boolean;
  userInfo: UserInfo | null;
  token: string | null;
  setCollapsed: (collapsed: boolean) => void;
  setUserInfo: (userInfo: UserInfo) => void;
  setToken: (token: string) => void;
  logout: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  collapsed: false,
  userInfo: null,
  token: localStorage.getItem('token'),
  setCollapsed: (collapsed) => set({ collapsed }),
  setUserInfo: (userInfo) => set({ userInfo }),
  setToken: (token) => {
    localStorage.setItem('token', token);
    set({ token });
  },
  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, userInfo: null });
  },
}));
