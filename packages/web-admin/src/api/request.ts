import { authStorage } from '../stores/sessionStorage';
import {systemMessage} from '../utils/chineseDisplay';
import axios from 'axios';
import { message } from 'antd';
import type { ApiError, ApiErrorCode, FieldError } from '../types/api';
import { FORBIDDEN_MESSAGE } from '../stores/roleAccess';
import { qiankunWindow } from 'vite-plugin-qiankun/dist/helper';

/**
 * Vite 注入的构建期环境变量。
 *
 * 本仓库没有 vite-env.d.ts，也没有在 tsconfig 中 include "vite/client"，
 * 而本次改动不允许新增 .d.ts 文件，因此在模块内补一个最小的全局声明：
 * 既让 import.meta.env 通过类型检查，又保持 Vite 对
 * import.meta.env.VITE_API_BASE_URL 的静态替换有效。
 */
declare global {
  interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_PLATFORM_PORTAL_ORIGINS?: string;
    /** Vite 内建：由 vite.config.ts 的 base 在构建期静态注入（dev 为 '/'） */
    readonly BASE_URL?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/**
 * 子路径部署的公共基址，与 vite base / import.meta.env.BASE_URL 同源。
 *
 * 剥掉尾部斜杠便于直接拼接：
 *   * dev（base '/'）→ ''，拼接结果与改动前逐字节一致；
 *   * 生产（base '/gqxq/'）→ '/gqxq'，登录跳转与路由 basename 都跟着走子路径。
 * 真源只有一个：改挂载点只需改 vite.config.ts 的 base，勿在别处硬编码 '/gqxq'。
 */
export const BASE_PATH: string = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');

/**
 * 作为 qiankun 子应用嵌入统一门户时，页面源是门户而不是本应用，
 * 相对 '/api/v1' 会打到门户后端。此时改用与 vite base 同源的子路径
 * （例如 '/gqxq/api/v1'），由门户按前缀反代回本应用后端；
 * 独立运行时保持原有 '/api/v1'，行为不变。
 */
// 必须用 qiankun 助手提供的 window 代理读取标记：沙箱内直接读 window 可能拿不到该属性，
// 会导致内嵌时仍走 '/api/v1' 打到门户后端，被 401 拦截器清掉令牌并显示"未登录"。
const embeddedByQiankun = Boolean(qiankunWindow.__POWERED_BY_QIANKUN__);
const defaultApiBase = embeddedByQiankun && BASE_PATH ? `${BASE_PATH}/api/v1` : '/api/v1';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? defaultApiBase;

const request = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});

request.interceptors.request.use((config) => {
  const token = authStorage.getItem('token');
  // Preserve a caller's originating session across asynchronous file reads.
  if(config.headers.Authorization&&config.headers.Authorization!==`Bearer ${token??''}`)throw new Error('登录身份已改变，请重新操作');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

request.interceptors.response.use(
  // 成功分支：保持既有封套语义不变 —— code !== 200 视为失败，成功时返回 data.data
  (response) => {
    if (response.config.responseType === 'blob') return response.data;
    const { data } = response;
    if (data?.code !== 200) {
      console.error('API Error:', data?.message);
      const err = new Error(systemMessage(data?.message)) as ApiError;
      err.code = data?.code;
      err.fieldErrors = data?.data?.fieldErrors?.map((f:FieldError)=>({...f,message:systemMessage(f.message,'请检查填写内容')}));
      err.status = response.status;
      return Promise.reject(err);
    }
    return data.data;
  },
  // 失败分支：把 code / fieldErrors / status 附加到原始错误对象上。
  // 直接在 axios 错误上赋值（而不是新建 Error），可保留 response / config / stack。
  (error) => {
    const status: number | undefined = error?.response?.status;
    const body = error?.response?.data as
      | {
          code?: ApiErrorCode | number;
          message?: string;
          data?: { fieldErrors?: FieldError[] } | null;
        }
      | undefined;

    const apiError = error as ApiError;
    apiError.code = body?.code ?? status;
    apiError.fieldErrors = body?.data?.fieldErrors?.map(f=>({...f,message:systemMessage(f.message,'请检查填写内容')}));
    apiError.status = status;
    apiError.message = systemMessage(body?.message ?? error?.message);

    // 登录接口自身的 401 不跳转，交给登录页提示；其余 401 仍清 token 并跳 /login
    // 前缀必须跟 BASE_PATH：子路径部署（/gqxq/）下硬跳 '/login' 会跳出挂载点
    const url: string = error?.config?.url ?? '';

    // 403：令牌没问题，是角色不够（后端 enforceRolePolicy / requireRole 给的）。
    // **不清 token、不跳登录页** —— 跳了等于告诉用户"你被登出了"，而事实是"你没这个权限"。
    // 真判定在后端，前端的菜单/按钮过滤只是让这一发少出现；出现了就得说清楚该找谁。
    if (status === 403) {
      apiError.message = FORBIDDEN_MESSAGE;
      message.warning(FORBIDDEN_MESSAGE);
      return Promise.reject(apiError);
    }

    if (status === 401 && !url.includes('/auth/login')) {
      authStorage.removeItem('token');
      window.location.href = `${BASE_PATH}/login`;
    }
    return Promise.reject(apiError);
  }
);

export default request;
