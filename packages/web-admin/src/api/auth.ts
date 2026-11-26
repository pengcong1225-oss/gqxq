import request, { API_BASE_URL } from './request';
import type { LoginResult, UserInfo } from '../types/api';

/**
 * 登录。失败统一返回 401 UNAUTHENTICATED，不区分「用户不存在 / 口令错误」。
 *
 * 注意：响应拦截器对 /auth/login 自身的 401 不做跳转，由登录页展示提示。
 *
 * POST /auth/login
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  return request.post<never, LoginResult>('/auth/login', { username, password });
}

/**
 * 当前登录用户信息（Bearer）。
 *
 * GET /auth/user-info
 */
export async function getUserInfo(): Promise<UserInfo> {
  return request.get<never, UserInfo>('/auth/user-info');
}

export function changePassword(currentPassword:string,newPassword:string){return request.post<never,{changed:boolean}>('/auth/change-password',{currentPassword,newPassword});}

let oidcStatus: Promise<{ enabled: boolean; startUrl?: string }> | undefined;
export function getOidcStatus(): Promise<{ enabled: boolean; startUrl?: string }> {
  if (!oidcStatus) {
    oidcStatus = fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/oidc/status`, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    }).then(async (response) => {
      if (response.status === 401 || response.status === 404) return { enabled: false };
      const body = await response.json();
      if (!response.ok || body.code !== 200 || typeof body.data?.enabled !== 'boolean')
        throw new Error('无法确认住新统一登录配置');
      return { enabled: body.data.enabled, startUrl: body.data.startUrl };
    }).catch((error) => {
      oidcStatus = undefined;
      throw error;
    });
  }
  return oidcStatus;
}

export const oidcStartUrl = `${API_BASE_URL.replace(/\/$/, '')}/auth/oidc/start`;

export async function readOidcSession(): Promise<LoginResult> {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/oidc/session`, {
    credentials: 'same-origin', redirect: 'error', cache: 'no-store',
  });
  const body = await response.json();
  if (!response.ok || body.code !== 200 || !body.data?.token || !body.data?.userInfo)
    throw new Error(body.message ?? '住新统一登录会话已失效');
  return body.data as LoginResult;
}

export async function logoutOidc(): Promise<void> {
  await fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/oidc/logout`, {
    method: 'POST', credentials: 'same-origin', redirect: 'error', keepalive: true,
  });
}

export async function exchangePlatformToken(token: string): Promise<LoginResult> {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/platform-session`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store',
  });
  const body = await response.json();
  if (!response.ok || body.code !== 200 || typeof body.data?.token !== 'string' || !body.data?.userInfo) {
    throw new Error(typeof body.message === 'string' ? body.message : '门户授权暂不可用');
  }
  return body.data as LoginResult;
}
