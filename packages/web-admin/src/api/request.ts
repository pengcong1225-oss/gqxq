import axios from 'axios';
import type { ApiError, ApiErrorCode, FieldError } from '../types/api';

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

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
  timeout: 15000,
});

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

request.interceptors.response.use(
  // 成功分支：保持既有封套语义不变 —— code !== 200 视为失败，成功时返回 data.data
  (response) => {
    const { data } = response;
    if (data?.code !== 200) {
      console.error('API Error:', data?.message);
      const err = new Error(data?.message || 'API Error') as ApiError;
      err.code = data?.code;
      err.fieldErrors = data?.data?.fieldErrors;
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
    apiError.fieldErrors = body?.data?.fieldErrors;
    apiError.status = status;
    if (body?.message) {
      apiError.message = body.message;
    }

    // 登录接口自身的 401 不跳转，交给登录页提示；其余 401 仍清 token 并跳 /login
    // 前缀必须跟 BASE_PATH：子路径部署（/gqxq/）下硬跳 '/login' 会跳出挂载点
    const url: string = error?.config?.url ?? '';
    if (status === 401 && !url.includes('/auth/login')) {
      localStorage.removeItem('token');
      window.location.href = `${BASE_PATH}/login`;
    }
    return Promise.reject(apiError);
  }
);

export default request;
