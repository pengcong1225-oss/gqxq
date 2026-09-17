import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// 为每个请求生成 requestId 并回写响应头，便于把前端报错与 audit_log.request_id 对上。
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.trim() !== '' ? incoming.trim().slice(0, 64) : randomUUID();
  req.remoteIp = (req.ip ?? '').slice(0, 64);
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
