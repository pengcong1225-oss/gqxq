/**
 * 后端 API 基址解析（唯一实现，全项目共用）。
 *
 * 为什么要动态推导：同一份产物要跑在三种部署形态下，硬编码 `/api/v1` 会在其中两种下 404，
 * 而且 404 的面板不报错、只显示空态，极难发现（实测因此拖死了 3 条标书条款）。
 *
 *   ① 开发：      http://127.0.0.1:8002/#/accept
 *                 → vite proxy 转发 `/api/v1` → 基址 `/api/v1`
 *   ② 单站部署：  http://host/gqxq/screen/#/accept   （prod/serve-prod.mjs 8080 形态）
 *                 → 基址 `/gqxq/api/v1`
 *   ③ 六域名部署：http://gqxq.sanxiacloud.net/screen/#/accept   （nginx-local 形态）
 *                 → 站点根就是 `/`，基址 `/api/v1`
 *
 * 推导规则：取页面路径中 `screen` 段之前的部分作为部署前缀。
 *   `/gqxq/screen/` → `/gqxq` → `/gqxq/api/v1`
 *   `/screen/`      → ``      → `/api/v1`
 *   `/`             → ``      → `/api/v1`
 *
 * `VITE_API_BASE` 可显式覆盖（部署到其它路径时用）。
 */
export function resolveApiBase(): string {
  const override = import.meta.env.VITE_API_BASE as string | undefined;
  if (override) return String(override).replace(/\/$/, '');

  // 去掉末尾文件名，再尝试匹配 `.../screen` 作为部署前缀边界
  const pagePath = location.pathname.replace(/\/[^/]*$/, '/').replace(/\/$/, '');
  const matched = pagePath.match(/^(.*?)\/screen$/);
  const prefix = matched ? matched[1] : '';
  return `${prefix}/api/v1`;
}

/** 当前生效的 API 基址（页面加载时确定一次；同源部署下路径不会中途变化） */
export const API_BASE = resolveApiBase();