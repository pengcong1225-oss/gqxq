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
  /**
   * 平台统一身份（住新工作服务平台）。
   * 启用后，诉求平台接受平台以 RS256 签发的令牌，按 platform_identity 绑定解析本地用户；
   * 未绑定一律拒绝，绝不按用户名/姓名自动合并账号。
   */
  platformIdentityEnabled: opt('GQXQ_PLATFORM_IDENTITY_ENABLED', 'false') === 'true',
  platformIdentityIssuer: opt('GQXQ_PLATFORM_IDENTITY_ISSUER', 'zhuxin-platform'),
  platformIdentityJwksUrl: opt('GQXQ_PLATFORM_IDENTITY_JWKS_URL', ''),
  platformIdentityAutoBindUsername: opt('GQXQ_PLATFORM_IDENTITY_AUTO_BIND_USERNAME', 'false') === 'true',
  port: Number(opt('PORT', '3100')),
  /**
   * M1（docs/2026-09-19-入站无鉴权端点防护方案.md §4.1）：监听地址显式可配置，**默认只绑回环**。
   * 之前 index.ts 是 app.listen(port) 不传 host ⇒ 0.0.0.0/::，"只在内网"仅是文档承诺、代码不保证。
   * 默认值改成回环后，生产形态是"本机反代 → 127.0.0.1:PORT"；
   * 容器形态（宿主把端口发布到 127.0.0.1）必须显式设 GQXQ_HOST=0.0.0.0，
   * 否则容器内回环不通、发布端口连不上（这是配置事实，不是代码兜底）。
   */
  host: opt('GQXQ_HOST', '127.0.0.1'),
  businessSources: optRaw('GQXQ_BUSINESS_SOURCES_JSON') || '[]',
  publicBaseUrl: opt('GQXQ_PUBLIC_BASE_URL',''),
  /**
   * M3（防护方案 §4.1）：套网关**必须**同时声明哪些对端可信，否则 req.ip 与
   * complaint_source_log.remote_ip 一律退化成网关 IP —— 白名单与事后追溯同时失效。
   * 默认 loopback：与 M1 的默认回环绑定配套，只有同机反代能改写 X-Forwarded-For，
   * 远程直连者给的 XFF 一律不采信。取值语义见 app.ts 的 applyTrustProxy。
   */
  trustProxy: opt('GQXQ_TRUST_PROXY', 'loopback'),
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
    deliveryWorkerEnabled: opt('GQXQ_PU_DELIVERY_WORKER_ENABLED','true')==='true',
    recoveryMode: opt('GQXQ_PU_RECOVERY_MODE','manual'),
    recoveryContractVersion: opt('GQXQ_PU_RECOVERY_CONTRACT_VERSION',''),
    reconciliationEnabled: opt('GQXQ_PU_RECONCILIATION_ENABLED','false')==='true',
    reconciliationIntervalMs: Number(opt('GQXQ_PU_RECONCILIATION_INTERVAL_MS','60000')),
    sceneCode: opt('GQXQ_PU_SCENE_CODE','GQXQ_SENSITIVE_DISPATCH'),
    templateCode: opt('GQXQ_PU_TEMPLATE_CODE','GQXQ_SENSITIVE_DISPATCH'),
    templateVersion: Number(opt('GQXQ_PU_TEMPLATE_VERSION','1')),
    approvalCode: opt('GQXQ_PU_APPROVAL_CODE','GQXQ_SUPERVISION_APPROVAL'),
    approvalVersion: Number(opt('GQXQ_PU_APPROVAL_VERSION','1')),
    callbackSubscription: opt('GQXQ_PU_CALLBACK_SUBSCRIPTION','GQXQ_TASK_RESULT'),
    organizationCode: opt('GQXQ_PU_ORGANIZATION_CODE',''),
    configurationVersion: opt('GQXQ_PU_CONFIGURATION_VERSION','1'),
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
  /**
   * 数据服务中心 · 内部链路（可选）。
   *   enabled=true 时：投递结果回报审计；启用 secretName 时启动后从服务中心拉取填报 HMAC 密钥，
   *   拉取成功则覆盖 GQXQ_PU_SECRET，失败则回退 env（绝不因服务中心不可用而中断业务）。
   */
  dataCenter: {
    enabled: opt('GQXQ_DC_ENABLED', 'false') === 'true',
    baseUrl: opt('GQXQ_DC_BASE_URL', ''),
    appId: opt('GQXQ_DC_APP_ID', ''),
    apiKey: optRaw('GQXQ_DC_API_KEY'),
    secretName: opt('GQXQ_DC_SECRET_NAME', 'gqxq.pu.secret'),
    timeoutMs: Number(opt('GQXQ_DC_TIMEOUT_MS', '2000')),
  },
  /** 小区定位（高德 Web 服务地理编码）与坐标抖动（数据服务中心异步任务）。
   * 抖动结果只用于地图展示，服务层绝不回写 location_*。 */
  /** 高德地图 Web 服务 Key（标书 1.2.12 指定的地图服务商；优先于天地图）。 */
  amapKey: optRaw('GQXQ_AMAP_KEY'),
  amapBaseUrl: opt('GQXQ_AMAP_BASE_URL', 'https://restapi.amap.com'),
  jitter: {
    baseUrl: opt('GQXQ_JITTER_BASE_URL', ''),
    appId: opt('GQXQ_JITTER_APP_ID', ''),
    apiKey: optRaw('GQXQ_JITTER_API_KEY'),
    insecureTls: opt('GQXQ_JITTER_INSECURE_TLS', 'false') === 'true',
    batchSize: Number(opt('GQXQ_JITTER_BATCH_SIZE', '200')),
    timeoutMs: Number(opt('GQXQ_JITTER_TIMEOUT_MS', '30000')),
    pollMs: Number(opt('GQXQ_JITTER_POLL_MS', '2000')),
    pollMax: Number(opt('GQXQ_JITTER_POLL_MAX', '120')),
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