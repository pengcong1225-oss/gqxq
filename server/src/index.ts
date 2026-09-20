import { createApp } from './app';
import { env } from './config/env';
import { assertDbReachable, closePool } from './db/pool';

/**
 * 判定监听地址是否为回环（M1 的默认值）。
 * 只认回环字面量：0.0.0.0、::、空串、内网 IP 一律按"非回环"处理，
 * 因为本函数的唯一用途是决定要不要拉响"暴露面变大"的警告，宁可多报不能漏报。
 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

async function main(): Promise<void> {
  // 反 Mock 回退门禁：数据库不可达时拒绝启动，绝不回落内存数据
  try {
    await assertDbReachable();
  } catch (err) {
    console.error('[startup] 数据库不可达，拒绝启动。' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const app = createApp();
  // M1（防护方案 §4.1）：显式绑定 env.host（默认 127.0.0.1），不再让 Express 走 0.0.0.0/::。
  // 生产形态 = 只绑回环 + 本机反代转发；对外暴露由 M2 安全组与 M3 网关白名单收口。
  const server = app.listen(env.port, env.host, () => {
    const addr = server.address();
    const bound =
      addr && typeof addr === 'object' ? addr.address + ':' + addr.port : String(env.host) + ':' + env.port;
    console.log('[Server] 诉求平台 API 已启动');
    console.log('[Server] 监听地址: ' + bound + '  (GQXQ_HOST=' + env.host + ', PORT=' + env.port + ')');
    console.log('[Server] 基础路径: http://localhost:' + env.port + '/api/v1');
    if (!isLoopbackHost(env.host)) {
      console.warn('[Server] 警告: 监听地址 ' + env.host + ' 不是回环地址 —— 任何能连通 ' + env.port +
        '/api/v1/external/yijiejieban/appeal 在应用层不校验任何凭证（新增/改写真实诉求数据），' +
        '该端口可达即人人可写。生产须只绑回环由本机反代转发，或已落实安全组放行（M2）+ 网关白名单与限流（M3）。' +
        '依据: docs/2026-09-19-入站无鉴权端点防护方案.md §1.2、§4.1');
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log('[Server] 收到 ' + signal + '，正在关闭…');
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
