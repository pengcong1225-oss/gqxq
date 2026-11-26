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
  /** 高德地图 Web 服务 Key（标书 1.2.12 指定的地图服务商）。 */
  amapKey: optRaw('GQXQ_AMAP_KEY'),
  amapBaseUrl: opt('GQXQ_AMAP_BASE_URL', 'https://restapi.amap.com'),
  /**
   * 区县边界本地快照（高德不可用时的降级数据源）。
   * 区县边界准静态，快照可长期使用；高德只回来一部分时按 code 补缺，不覆盖实时值。
   * 生成/更新：npm run boundary:districts
   */
  districtSnapshot: opt('GQXQ_DISTRICT_SNAPSHOT', 'data/boundaries/yichang-districts-snapshot.geojson'),
  /**
   * 区县边界数据源模式：
   *   snapshot（默认）—— 政务网形态：运行时只读本地快照，完全不访问高德（无外网出口也不等超时）；
   *   live            —— 有外网的环境：实时优先，失败回退快照；
   *   auto            —— 快照优先，快照缺失才打高德。
   * 快照刷新走离线命令：npm run boundary:districts。
   */
  districtSource: opt('GQXQ_DISTRICT_SOURCE', 'snapshot'),
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
  /** 离线近似边界推导脚本的坐标核验选项。大屏点位固定使用已抖动成果。 */
  screenCoordSource: (opt('GQXQ_SCREEN_COORD_SOURCE', 'original') === 'jitter' ? 'jitter' : 'original') as
    | 'jitter'
    | 'original',
  /**
   * 街道缓冲近似面的半径（米）。留空=按网格点位密度自适应（推荐）；
   * 填数字则所有街道统一用该固定半径，仅用于调参 / 验收截图对比。
   */
  streetBufferMeters: opt('GQXQ_STREET_BUFFER_METERS', ''),
  /**
   * 边界数据包（Boundary Pack）：街道/社区级边界的**可替换数据源**。
   *
   * 为什么做成文件而不是写死后端：
   *   高德免费接口街道不返回 polyline、admin_grid.geometry 全 NULL；OSM 只是过渡底稿，
   *   后续要换甲方 SHP 导出 / 高德企业智图 street&village / 天地图数据时，
   *   只换文件 + 改这一个环境变量即可，路由与前端契约不变（见 boundaryPackService.ts）。
   *
   * 留空 = 不启用（退回 official → buffer 逻辑）。
   * 相对路径按 server 根目录解析；产物由 scripts/fetch-osm-boundaries.mjs 生成。
   */
  boundaryPack: opt('GQXQ_BOUNDARY_PACK', ''),
  /** 数据包大小上限（MB），防止误配超大文件把进程内存打爆 */
  boundaryPackMaxMb: Number(opt('GQXQ_BOUNDARY_PACK_MAX_MB', '32')),
  /**
   * CIM 行政区划栅格服务（《CIM-配置2》给的 token + 内网网关）。
   * 只用于「出图」的边界参考层：实测该网关没有要素/属性通道（queryable=false），
   * 五色热力仍需 CIM 开数据服务或矢量瓦片 —— 详见 services/cimGridOverlayService.ts 顶部说明。
   */
  cimToken: optRaw('GQXQ_CIM_TOKEN'),
  cimMapBase: opt('GQXQ_CIM_BASE', 'http://10.55.69.155:8885/gtis/map/rest'),
  /** 边界图磁盘缓存目录（相对 server 根；留空用 .dev-logs/cim-overlay-cache） */
  cimOverlayCacheDir: opt('GQXQ_CIM_CACHE_DIR', ''),
  /** 缓存 TTL（毫秒），默认 6 小时 */
  cimOverlayCacheTtlMs: Number(opt('GQXQ_CIM_CACHE_TTL_MS', '21600000')),
  /** 上游出图超时（毫秒） */
  cimOverlayTimeoutMs: Number(opt('GQXQ_CIM_TIMEOUT_MS', '20000')),
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
