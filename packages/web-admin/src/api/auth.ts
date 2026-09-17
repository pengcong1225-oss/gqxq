import request from './request';
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
