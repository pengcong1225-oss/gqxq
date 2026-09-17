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

export {};
