import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const server = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[2] ?? 'unit';
if (!['unit', 'db', 'db:sensitive', 'db:callback'].includes(group)) throw new Error('Usage: node tests/run-tests.mjs unit|db|db:sensitive|db:callback');
const directory = join(server, 'tests', group === 'unit' ? '' : 'db');
const files = readdirSync(directory).filter(name => name.endsWith('.test.ts'))
 .filter(name => !process.argv[3] || name === process.argv[3])
 .filter(name => group !== 'db:sensitive' || name === 'sensitive-word-management.test.ts')
 .filter(name => group !== 'db:callback' || name !== 'sensitive-word-management.test.ts')
 .sort().map(name => join(directory, name));
if (!files.length) throw new Error('Empty test group '+group);
const env = {...process.env};
if (group === 'unit') {
 for (const key of Object.keys(env)) if (key.startsWith('GQXQ_')) delete env[key];
 Object.assign(env, {NODE_ENV:'test',DOTENV_CONFIG_PATH:join(server,'tests','.env-disabled'),GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'1',GQXQ_DB_USER:'isolated-test',GQXQ_DB_NAME:'isolated_test',GQXQ_DB_PASSWORD:'',GQXQ_JWT_SECRET:'isolated-test-no-production-secret',GQXQ_PU_BASE_URL:'http://127.0.0.1:1',GQXQ_PU_DELIVERY_WORKER_ENABLED:'false',GQXQ_PU_UTILITY_SYNC_ENABLED:'false',GQXQ_PU_ENTERPRISE_SYNC_ENABLED:'false'});
} else {
 if (env.GQXQ_RUN_DB_TESTS !== '1' || !env.DOTENV_CONFIG_PATH) throw new Error('DB group requires explicit opt-in and disabled dotenv path; see tests/README.md');
 env.DOTENV_CONFIG_PATH = resolve(env.DOTENV_CONFIG_PATH);
}
if (existsSync(env.DOTENV_CONFIG_PATH)) throw new Error('Refusing to read an existing dotenv file');
const result = spawnSync(process.execPath, ['--import','tsx','--test','--test-force-exit',...(group === 'unit' ? [] : ['--test-concurrency=1']),...files], {cwd:server,env,stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
