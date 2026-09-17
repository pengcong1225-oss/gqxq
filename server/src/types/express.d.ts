import type { AuthUser } from '../http/errors';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      remoteIp: string;
      user?: AuthUser;
    }
  }
}

/**
 * express.json 的 verify 回调收到的是 **Node 的 IncomingMessage**，不是 Express 的 Request，
 * 所以 rawBody 必须增强在 node:http 上；又因为 Express.Request 继承 IncomingMessage，
 * 路由里的 req.rawBody 也就随之可用。
 *
 * 为什么需要它：G4 回调签名要对**原始请求字节**求 sha256，
 * 对 JSON.parse 之后再 stringify 的结果求摘要会因键序/空白/转义差异而验签失败。
 */
declare module 'node:http' {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

export {};
