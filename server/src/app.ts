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
  // 与 G3 契约一致的上限
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);
  app.use('/api/v1', buildRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
