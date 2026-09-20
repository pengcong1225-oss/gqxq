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
  /**
   * M1（docs/2026-09-19-入站无鉴权端点防护方案.md §4.1）：监听地址显式可配置，**默认只绑回环**。
   * 之前 index.ts 是 app.listen(port) 不传 host ⇒ 0.0.0.0/::，"只在内网"仅是文档承诺、代码不保证。
   * 默认值改成回环后，生产形态是"本机反代 → 127.0.0.1:PORT"；
   * 容器形态（宿主把端口发布到 127.0.0.1）必须显式设 GQXQ_HOST=0.0.0.0，
   * 否则容器内回环不通、发布端口连不上（这是配置事实，不是代码兜底）。
   */
  host: opt('GQXQ_HOST', '127.0.0.1'),
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
  /**
   * G6 来源对接：宜接就办只读状态适配器。有效形态两种：
   *   * disabled（默认）—— 不发起任何调用，同步即 501；
   *   * file —— 读 GQXQ_YJJB_FILE 指向的**仓库外**快照 JSON，当成来源系统来用
   *             （见 adapters/fileSourceAdapter.ts）。
   * 其余取值一律回退 disabled 并标记 misconfigured，绝不构造假适配器。
   */
  yijiejieban: {
    adapter: opt('GQXQ_YJJB_ADAPTER', 'disabled'),
    baseUrl: opt('GQXQ_YJJB_BASE_URL', ''),
    token: optRaw('GQXQ_YJJB_TOKEN'),
    timeoutMs: Number(opt('GQXQ_YJJB_TIMEOUT_MS', '10000')),
    /** adapter=file 时读取的快照 JSON 路径；为空表示该形态配置不完整 */
    file: opt('GQXQ_YJJB_FILE', ''),
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
