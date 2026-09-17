import type { Response } from 'express';
import type { ErrorCode } from './errors';

// 响应封套：{ code, message, data }
// 前端 packages/web-admin/src/api/request.ts 依赖 data.code === 200 并返回 data.data。
// 失败时 HTTP 状态码与 code 相同（见方案 §5.1）。

export function ok<T>(res: Response, data: T, message = 'success'): void {
  res.status(200).json({ code: 200, message, data });
}

export function fail(
  res: Response,
  errorCode: ErrorCode,
  message: string,
  status: number,
  body: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    code: status,
    message,
    data: body === null ? null : { errorCode, ...body },
  });
}
