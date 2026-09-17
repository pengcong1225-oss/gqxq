import { createApp } from './app';
import { env } from './config/env';
import { assertDbReachable, closePool } from './db/pool';

async function main(): Promise<void> {
  // 反 Mock 回退门禁：数据库不可达时拒绝启动，绝不回落内存数据
  try {
    await assertDbReachable();
  } catch (err) {
    console.error('[startup] 数据库不可达，拒绝启动。' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log('[Server] 诉求平台 API 已启动');
    console.log('[Server] 地址: http://localhost:' + env.port);
    console.log('[Server] 基础路径: http://localhost:' + env.port + '/api/v1');
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
