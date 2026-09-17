import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env';
import { requestContext } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { buildRouter } from './routes';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
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
