/**
 * 内部凭据统一：启动时从数据服务中心拉取点对点调用的 HMAC 密钥。
 *
 * 为什么要有这一步：原先 GQXQ_PU_SECRET 是 env 明文，和服务中心的 app key 各管一套，
 * 轮换、到期、泄露处置都没法统一。改成启动时向服务中心取，env 只作为兜底。
 *
 * 失败策略：拉不到就用 env（打日志），**绝不因为服务中心不可用而让诉求平台起不来**。
 */
import { env } from '../config/env';

export interface SecretFetchResult {
  applied: boolean;
  reason: string;
}

export async function hydratePuSecret(): Promise<SecretFetchResult> {
  const cfg = env.dataCenter;
  if (!cfg.enabled) return { applied: false, reason: 'disabled' };
  if (!cfg.baseUrl || !cfg.appId || !cfg.apiKey) return { applied: false, reason: 'incomplete_config' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(new URL('/api/v1/internal/secrets/' + encodeURIComponent(cfg.secretName), cfg.baseUrl).href, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'X-App-Id': cfg.appId, 'X-API-Key': cfg.apiKey },
    });
    if (!res.ok) {
      console.error('[dc-secret] 拉取失败 http_' + res.status + '，回退环境变量');
      return { applied: false, reason: 'http_' + res.status };
    }
    const payload = (await res.json()) as { secret?: string };
    const secret = typeof payload.secret === 'string' ? payload.secret : '';
    if (secret.length < 16) {
      console.error('[dc-secret] 返回的密钥长度异常，回退环境变量');
      return { applied: false, reason: 'invalid_secret' };
    }
    // env 是 as const 的只读对象，运行时替换需要一个显式断言
    (env.pu as { secret: string }).secret = secret;
    console.info('[dc-secret] 已从数据服务中心加载填报密钥：' + cfg.secretName);
    return { applied: true, reason: 'ok' };
  } catch (error) {
    console.error('[dc-secret] 拉取异常，回退环境变量：', error instanceof Error ? error.message : error);
    return { applied: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}