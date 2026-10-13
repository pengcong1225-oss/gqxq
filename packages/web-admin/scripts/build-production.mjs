import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = { ...process.env };
// Optional deployment-owned env file; never log its values or copy it into dist.
if (process.argv[2]) {
  for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(VITE_TIANDITU_TK|VITE_API_BASE_URL)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
if (!env.VITE_TIANDITU_TK?.trim()) {
  console.error('生产构建缺少天地图配置 VITE_TIANDITU_TK，已停止，避免发布不可用地图。');
  process.exit(1);
}
env.VITE_API_BASE_URL = env.VITE_API_BASE_URL || '/gqxq/api/v1';
if (!process.env.npm_execpath) throw new Error('请通过 npm run build:production 执行');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
