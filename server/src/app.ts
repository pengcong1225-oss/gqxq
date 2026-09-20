import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env';
import { requestContext } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { buildRouter } from './routes';

/**
 * M3（docs/2026-09-19-入站无鉴权端点防护方案.md §4.1）：声明哪些连接对端可信，
 * 让网关透传的 X-Forwarded-For 参与 req.ip 计算。
 * 不设这一项 = 网关后所有投递的 remote_ip 都是网关 IP，白名单与事后追溯同时失效（§1.4-4）。
 * 设成 true = 反过来，任何人都能用 XFF 伪造留痕 IP（§4.1 M3 失效模式②），故只在 true 时拉响警告。
 *
 * GQXQ_TRUST_PROXY 取值（默认 loopback）：
 *   off | false | none        不信任任何代理，req.ip = 连接对端地址（Express 原生默认）
 *   loopback                  只有回环对端可改写 XFF —— 本机反代形态
 *   linklocal                 只有链路本地网段可改写
 *   uniquelocal | private     只有 RFC1918/ULA 网段可改写 —— 容器 bridge 里 nginx 在宿主的形态。
 *                             （private 是别名：本仓库 proxy-addr 的 IP_RANGES 只有
 *                              linklocal/loopback/uniquelocal 三个域，直接写 private 会抛
 *                              "invalid IP address: private"，而防护方案原文用的词是 private）
 *   <IP 或 CIDR 逗号列表>       精确指定网关，如 172.18.0.1 或 10.0.0.0/8
 *   <正整数>                  信任最近 N 跳
 *   true | all                信任所有对端：XFF 可被任意来源伪造，仅排障用
 */
function applyTrustProxy(app: express.Express): void {
  const raw = env.trustProxy;
  const lowered = raw.toLowerCase();
  let value: boolean | number | string;

  if (lowered === 'off' || lowered === 'false' || lowered === 'none') {
    value = false;
  } else if (lowered === 'true' || lowered === 'all') {
    value = true;
  } else if (lowered === 'private') {
    value = 'uniquelocal';
  } else if (/^\d+$/.test(lowered)) {
    value = Number(lowered);
  } else {
    value = raw;
  }

  try {
    // Express 在 set 时就编译该值（application.js 的 compileTrust），非法值在此抛错。
    app.set('trust proxy', value);
  } catch (err) {
    throw new Error(
      '[config] GQXQ_TRUST_PROXY 取值无效：' + raw + '（' + (err instanceof Error ? err.message : String(err)) + '）。' +
        '可用：off | loopback | linklocal | uniquelocal | private | true | 跳数 | IP/CIDR 逗号列表。' +
        '绝不静默回退——否则网关后的投递会把 remote_ip 全记成网关地址。'
    );
  }

  if (value === true) {
    console.warn('[Server] 警告: trust proxy=true 会采信任意来源的 X-Forwarded-For，' +
      'complaint_source_log.remote_ip 与 x-request-id 一样可被调用方塑形，不得作为白名单判定或追溯依据');
  } else {
    console.log('[Server] trust proxy=' + JSON.stringify(value) + '（GQXQ_TRUST_PROXY=' + raw + '）');
  }
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // M3：必须在任何读取 req.ip 的中间件之前设定（本行只写 setting，不参与路由顺序）
  applyTrustProxy(app);
  app.use(cors());
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  // 与 G3 契约一致的上限。
  // verify 把**原始请求字节**缓存下来：G4 回调的签名算法要对 exactBody 求 sha256，
  // 对 JSON.parse 后再 stringify 的结果求摘要会因键序/空白/转义差异而验签失败。
  // 这个回调是纯附加的（只多挂一个 req.rawBody），不影响任何既有路由。
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf: Buffer) => {
        req.rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(requestContext);
  app.use('/api/v1', buildRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
