import { create } from 'zustand';

interface UserInfo {
  id: number;
  username: string;
  realName: string;
  roles: string[];
}

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
