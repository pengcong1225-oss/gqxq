// 环境变量读取与必填校验。
// 设计纪律：必填项缺失时**直接退出**，绝不用默认值兜底，
// 否则会出现"配置没配对，服务却起来了，只是数据全错"的情况。
import 'dotenv/config';

const missing: string[] = [];

function req(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    missing.push(name);
    return '';
  }
  return raw.trim();
}

function opt(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function optRaw(name: string): string {
  return process.env[name] ?? '';
}

export const env = {
  nodeEnv: opt('NODE_ENV', 'development'),
  port: Number(opt('PORT', '3100')),
  db: {
    host: opt('GQXQ_DB_HOST', '127.0.0.1'),
    port: Number(opt('GQXQ_DB_PORT', '3306')),
    user: req('GQXQ_DB_USER'),
    password: optRaw('GQXQ_DB_PASSWORD'),
    database: req('GQXQ_DB_NAME'),
    connectionLimit: Number(opt('GQXQ_DB_CONNECTION_LIMIT', '10')),
  },
  jwtSecret: req('GQXQ_JWT_SECRET'),
  jwtTtlSeconds: Number(opt('GQXQ_JWT_TTL_SECONDS', '28800')),
  bootstrapAdminUsername: opt('GQXQ_BOOTSTRAP_ADMIN_USERNAME', 'admin'),
  bootstrapAdminPassword: optRaw('GQXQ_BOOTSTRAP_ADMIN_PASSWORD'),
  /** G3 出站：向 public-utility 创建填报任务时的凭证与地址 */
  pu: {
    baseUrl: opt('GQXQ_PU_BASE_URL', 'http://localhost:8080'),
    appCode: opt('GQXQ_PU_APP_CODE', 'gqxq'),
    keyId: optRaw('GQXQ_PU_KEY_ID'),
    secret: optRaw('GQXQ_PU_SECRET'),
    timeoutMs: Number(opt('GQXQ_PU_TIMEOUT_MS', '15000')),
  },
  /** G4 入站：校验 public-utility 回调签名与 ACK 响应体 */
  callback: {
    keyId: optRaw('GQXQ_CALLBACK_KEY_ID'),
    keyVersion: opt('GQXQ_CALLBACK_KEY_VERSION', 'v1'),
    secret: optRaw('GQXQ_CALLBACK_SECRET'),
    /** NONE | BODY；BODY 时响应体必须逐字节等于 ackValue */
    ackMode: opt('GQXQ_CALLBACK_ACK_MODE', 'NONE').toUpperCase(),
    ackValue: optRaw('GQXQ_CALLBACK_ACK_VALUE'),
  },
} as const;

if (missing.length > 0) {
  console.error('[config] 缺少必填环境变量：' + missing.join(', '));
  console.error('[config] 请复制 server/.env.example 为 server/.env 并填写后重试。');
  process.exit(1);
}

if (env.nodeEnv === 'production' && env.jwtSecret.length < 32) {
  console.error('[config] 生产环境 GQXQ_JWT_SECRET 长度必须不小于 32。');
  process.exit(1);
}

export const isProd = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';
