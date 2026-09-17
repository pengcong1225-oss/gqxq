import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { currentUser, login } from '../services/authService';

// POST /auth/login      —— 公开；bcrypt 校验后签发 JWT
// GET  /auth/user-info  —— 需 Bearer；/auth 被挂在全局 requireAuth 之前（routes/index.ts），
//                          因此在这个 router 内部单独挂 requireAuth
export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const body = req.body === undefined || req.body === null ? {} : req.body;
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.map(String).join('.') : 'body',
        message: issue.message,
      }));
      throw AppError.validation('登录请求参数不合法', fieldErrors);
    }

    const result = await login(parsed.data.username, parsed.data.password, {
      clientIp: req.remoteIp,
      requestId: req.requestId,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/auth/user-info', requireAuth, async (req, res, next) => {
  try {
    const actor = req.user;
    if (actor === undefined) {
      throw AppError.unauthenticated('未认证或登录已过期');
    }
    ok(res, await currentUser(actor.id));
  } catch (err) {
    next(err);
  }
});
