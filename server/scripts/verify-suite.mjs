import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const group = process.argv[2];
const directories = { web: 'packages/web-admin/tests', screen: 'packages/appeal-screen', migrations: 'server/tests' };
if (!Object.hasOwn(directories, group)) throw new Error('Expected web|screen|migrations');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GQXQ_') || key.startsWith('VITE_')) delete env[key];
Object.assign(env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: join(root, 'server/tests/.env-disabled'), GQXQ_DB_HOST: '127.0.0.1', GQXQ_DB_PORT: '1', GQXQ_DB_USER: 'isolated-test', GQXQ_DB_NAME: 'isolated_test', GQXQ_DB_PASSWORD: '', GQXQ_JWT_SECRET: 'isolated-test-no-production-secret', GQXQ_PU_DELIVERY_WORKER_ENABLED: 'false', GQXQ_PU_UTILITY_SYNC_ENABLED: 'false', GQXQ_PU_ENTERPRISE_SYNC_ENABLED: 'false' });
if (group === 'migrations') {
  if (process.env.GQXQ_ISOLATED_MIGRATION_TEST !== '1') throw new Error('Explicit isolated MySQL opt-in required; see server/tests/README.md');
  env.GQXQ_ISOLATED_MIGRATION_TEST = '1';
}
if (existsSync(env.DOTENV_CONFIG_PATH)) throw new Error('Refusing to load an existing test dotenv file');
const directory = resolve(root, directories[group]);
const files = readdirSync(directory).filter(name => group === 'web' ? /\.test\.tsx?$/.test(name) : group === 'screen' ? /^tests-.*\.test\.js$/.test(name) : /migration\.test\.cjs$/.test(name)).filter(name => !process.argv[3] || name === process.argv[3]).sort().map(name => join(directory, name));
if (group === 'migrations') files.push(...readdirSync(join(directory, 'db')).filter(name => name.endsWith('.test.cjs')).sort().map(name => join(directory, 'db', name)));
if (!files.length) throw new Error('Empty test suite');
const loader = pathToFileURL(join(root, 'server/node_modules/tsx/dist/loader.mjs')).href;
const result = spawnSync(process.execPath, ['--import', loader, '--test', '--test-force-exit', ...(group !== 'screen' ? ['--test-concurrency=1'] : []), ...files], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
