import { Router } from 'express';
import type { Request } from 'express';
import { fail } from '../http/respond';
import { handleCallback } from '../services/callbackService';

// G4 入站：POST /api/v1/external/public-utility/callback
// 挂在 requireAuth **之前**（见 routes/index.ts）：本端点靠**签名**鉴权，不用 Bearer。
//
// 两个必须守住的点：
//   1) 签名要对**原始 body 字节**求 sha256。app.ts 的 express.json 用 verify 回调把原始字节
//      缓存在 req.rawBody；这里直接取字节，**严禁**对 JSON.parse 后再 stringify 的结果求摘要。
//   2) 2xx 的响应体就是 ACK 本身，必须逐字节等于订阅上配置的 ackValue：
//      用 res.type('text/plain').send(...)，**不要** res.json、不要追加换行。
//      对方 HttpCallbackTransport.ackMatches 用 MessageDigest.isEqual 逐字节比较，
//      不匹配会判成 CALLBACK_ACK_INVALID 且**不可重试** —— 等于事件被永久丢弃。
export const publicUtilityCallbackRouter = Router();

/** requestContext 已注入 requestId/remoteIp；rawBody 由 app.ts 的 verify 回调注入 */
interface CallbackRequest extends Request {
  rawBody?: Buffer;
}

function headerOf(req: Request, name: string): string | null {
  const value = req.header(name);
  return value === undefined || value === '' ? null : value;
}

publicUtilityCallbackRouter.post('/callback', async (req, res, next) => {
  try {
    const raw = (req as CallbackRequest).rawBody;
    if (raw === undefined || raw.length === 0) {
      // 没有缓存原始字节就**无法**验签。这属于服务端装配缺失（app.ts 漏配 verify 回调），
      // 不是调用方的错，因此返回 503（对方视为可重试）而不是 401（永久丢弃）。
      fail(res, 'INTERNAL_ERROR', '回调缺少原始请求体缓存，无法验签', 503, { requestId: req.requestId });
      return;
    }

    const outcome = await handleCallback({
      rawBody: raw,
      keyId: headerOf(req, 'x-public-utility-key-id'),
      keyVersion: headerOf(req, 'x-public-utility-key-version'),
      timestamp: headerOf(req, 'x-public-utility-timestamp'),
      headerEventId: headerOf(req, 'x-public-utility-event-id'),
      signature: headerOf(req, 'x-public-utility-signature'),
      remoteIp: req.remoteIp ?? null,
    });

    if (outcome.retryAfterSeconds !== null) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      // ACK：逐字节发送，不加任何包装
      res.status(outcome.status).type('text/plain').send(outcome.ackBody);
      return;
    }

    // 非 2xx：对方只看状态码（2xx 才比对 ACK），用我们的统一错误封套即可
    if (outcome.status === 401) {
      fail(res, 'UNAUTHENTICATED', outcome.message, 401, { requestId: req.requestId });
      return;
    }
    if (outcome.status === 400) {
      fail(res, 'VALIDATION_FAILED', outcome.message, 400, {
        fieldErrors: outcome.fieldErrors ?? undefined,
        requestId: req.requestId,
      });
      return;
    }
    // 503 等可重试状态：ErrorCode 联合里没有 503，用 INTERNAL_ERROR 作标签，但 HTTP 状态是真实的 503
    fail(res, 'INTERNAL_ERROR', outcome.message, outcome.status, { requestId: req.requestId });
  } catch (err) {
    next(err);
  }
});
