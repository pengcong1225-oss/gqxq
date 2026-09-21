import request from './request';
import type {
  CreateUserRequest,
  UpdateUserRequest,
  UpdateUserResult,
  UserAdminFilter,
  UserAdminItem,
  UserAdminListResult,
} from '../types/api';

/**
 * 用户管理接口（Task #35 摘掉 /users 的 501 桩）。
 *
 * 三条都是 **admin 独占**：后端 enforceRolePolicy() 按策略表 U1–U3 判定，
 * router 上另挂 requireRole('admin') 作第二道闸。其他人调用得到 403
 * 「无权限，请联系管理员」——由 request.ts 统一提示，不跳登录页。
 *
 * 这里刻意**没有** deleteUser：后端不提供删除端点，
 * 下线一个账号用 updateUser(userId, { status: 0 })（禁用代替，保住审计到人的可查性）。
 */

/** GET /users?page&size&keyword&role&status */
export async function listUsers(
  filter: UserAdminFilter & { page?: number; size?: number } = {}
): Promise<UserAdminListResult> {
  return request.get<never, UserAdminListResult>('/users', { params: filter });
}

/** POST /users —— 建号；初始口令只在请求里出现一次，响应不回显 */
export async function createUser(body: CreateUserRequest): Promise<UserAdminItem> {
  return request.post<never, UserAdminItem>('/users', body);
}

/** PATCH /users/:userId —— 改姓名 / 角色 / 启停 */
export async function updateUser(
  userId: string,
  body: UpdateUserRequest
): Promise<UpdateUserResult> {
  return request.patch<never, UpdateUserResult>('/users/' + encodeURIComponent(userId), body);
}
