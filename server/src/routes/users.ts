// GET/POST/PATCH /users —— 用户管理（映射表 U1–U3，**admin 独占**）。
//
// 这里原来在 routes/legacy.ts 里是 501 桩（"G1.6 之后"），本批摘掉。
// 两道闸（同时生效，取更严的一方）：
//   1) 全局 enforceRolePolicy() 按 ROLE_POLICY 的 U1–U3 判定；
//   2) 本 router 自己再挂 requireRole('admin') —— 用户管理是最高危端点，
//      不能只靠"策略表里那一行没被误改"。
//
// 没有 DELETE：禁用（PATCH status=0）代替删除，否则 operation_audit_log 里的
// user_id 会变成查无此人的孤号，"审计到人"这条链就断了。
// 没有改口令端点：本批只做建号时的初始口令（映射表 §5 已记为遗留）。
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { requireRole } from '../middleware/requireRole';
import { ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY } from '../auth/rolePolicy';
import { createUser, listUsers, updateUserByAdmin } from '../services/userService';
import type { OperatorContext } from '../services/dispatchService';

export const usersRouter = Router();

/** 操作者上下文：真实登录者（JWT sub/username），与业务写路径同一口径 */
function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

const roleSchema = z.enum([ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY]);

/** 列宽上限对齐 app_user（M1 迁移）：username/real_name 都是 varchar(64) */
const usernameSchema = z
  .string()
  .trim()
  .min(2, '用户名至少 2 个字符')
  .max(64, '用户名最长 64 字符（与 app_user.username 列宽一致）')
  .regex(/^[A-Za-z0-9._-]+$/, '用户名只允许字母、数字与 . _ -');

const realNameSchema = z.string().trim().min(1, '姓名必填').max(64, '姓名最长 64 字符');

/**
 * 口令 8..72：下限是策略，上限是 bcrypt 的既有事实——超过 72 字节会被静默截断，
 * 与其悄悄按截断后的口令校验，不如直接拒掉（契约上限对齐实现约束）。
 */
const passwordSchema = z
  .string()
  .min(8, '初始口令至少 8 个字符')
  .max(72, '初始口令最长 72 字符（bcrypt 的输入上限，超出会被截断）');

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, message: string): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw AppError.validation(
    message,
    parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.map(String).join('.') : 'body',
      message: issue.message,
    }))
  );
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(64).optional(),
  role: roleSchema.optional(),
  status: z.coerce.number().int().refine((v) => v === 0 || v === 1).optional(),
});

usersRouter.get('/users', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const q = parseOrThrow(querySchema, req.query, '用户列表查询参数不合法');
    ok(
      res,
      await listUsers(
        {
          keyword: q.keyword === undefined || q.keyword === '' ? undefined : q.keyword,
          role: q.role,
          status: q.status as 0 | 1 | undefined,
        },
        q.page,
        q.size
      )
    );
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  username: usernameSchema,
  realName: realNameSchema,
  role: roleSchema,
  password: passwordSchema,
});

usersRouter.post('/users', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const body = req.body === undefined || req.body === null ? {} : req.body;
    const input = parseOrThrow(createSchema, body, '建号请求参数不合法');
    ok(res, await createUser(input, ctxOf(req)), '用户已创建');
  } catch (err) {
    next(err);
  }
});

const updateSchema = z
  .object({
    realName: realNameSchema.optional(),
    role: roleSchema.optional(),
    status: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .refine((v) => v.realName !== undefined || v.role !== undefined || v.status !== undefined, {
    message: '至少给出一个要改的字段（realName / role / status）',
  });

const userIdSchema = z.string().trim().min(1).max(64);

usersRouter.patch('/users/:userId', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const targetUserId = parseOrThrow(userIdSchema, req.params.userId, 'userId 不合法');
    const body = req.body === undefined || req.body === null ? {} : req.body;
    const input = parseOrThrow(updateSchema, body, '改号请求参数不合法');
    const result = await updateUserByAdmin(targetUserId, input, ctxOf(req));
    ok(res, result, result.changed.length > 0 ? '用户已更新' : '无字段变化');
  } catch (err) {
    next(err);
  }
});
