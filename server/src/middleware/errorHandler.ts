import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../http/errors';
import { fail } from '../http/respond';

export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 'NOT_FOUND', '接口不存在：' + req.method + ' ' + req.path, 404,
    { requestId: req.requestId });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    fail(res, err.errorCode, err.message, err.status, {
      fieldErrors: err.fieldErrors ?? undefined,
      requestId: req.requestId,
      ...(err.extra ?? {}),
    });
    return;
  }
  // 请求体超限由 express.json 抛出
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.too.large') {
    fail(res, 'PAYLOAD_TOO_LARGE', '请求体超过 1 MiB 上限', 413, { requestId: req.requestId });
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    fail(res, 'VALIDATION_FAILED', '请求体不是合法 JSON', 400, { requestId: req.requestId });
    return;
  }
  console.error('[' + req.requestId + '] 未处理异常:', err);
  fail(res, 'INTERNAL_ERROR', '服务端内部错误', 500, { requestId: req.requestId });
};
