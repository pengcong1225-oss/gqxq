import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { SUPPORTED_DICT_CODES, findDictItems, isSupportedDictCode } from '../repositories/dictRepo';
import { ROLE_ADMIN } from '../auth/rolePolicy';
import { requireRole } from '../middleware/requireRole';
import {
  createSensitiveWord,
  executeSensitiveRescan,
  listManagedSensitiveWords,
  previewSensitiveRescan,
  updateSensitiveWord,
  type SensitiveWordOperatorContext,
} from '../services/sensitiveWordService';

// GET /dicts/:code/items（G1.3）：优先读 dict_type / dict_item；
// 库中缺失的字典类型（三个状态轴、source_system）回退受控词汇表，绝不返回空数组。
export const dictsRouter = Router();

function ctxOf(req: Request): SensitiveWordOperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw AppError.validation(
    message,
    parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.map(String).join('.') : 'body',
      message: issue.message,
    }))
  );
}

const wordSchema = z.string().trim().min(1, '敏感词不能为空').max(128, '敏感词最长 128 个字符')
  .refine((word) => !/[,，、]/u.test(word), '敏感词不能包含逗号、中文逗号或顿号');
const itemIdSchema = z.string().trim().min(1).max(64);
const createSensitiveWordSchema = z.object({ word: wordSchema });
const updateSensitiveWordSchema = z
  .object({
    word: wordSchema.optional(),
    status: z.enum(['enabled', 'disabled']).optional(),
  })
  .refine((value) => value.word !== undefined || value.status !== undefined, {
    message: '至少给出 word 或 status 中的一项',
  });
const rescanSchema = z.object({
  previewToken: z.string().uuid('预览令牌格式不合法'),
});

/** 敏感词管理：真实 dict_item 数据，admin 独占；无 DELETE，停用代替物理删除。 */
dictsRouter.get('/dicts/sensitive-words', requireRole(ROLE_ADMIN), async (_req, res, next) => {
  try {
    ok(res, await listManagedSensitiveWords());
  } catch (err) {
    next(err);
  }
});

dictsRouter.post('/dicts/sensitive-words', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const body = parseOrThrow(
      createSensitiveWordSchema,
      req.body ?? {},
      '新增敏感词参数不合法'
    );
    ok(res, await createSensitiveWord(body, ctxOf(req)), '敏感词已新增');
  } catch (err) {
    next(err);
  }
});

dictsRouter.patch('/dicts/sensitive-words/:itemId', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const itemId = parseOrThrow(itemIdSchema, req.params.itemId, 'itemId 不合法');
    const body = parseOrThrow(
      updateSensitiveWordSchema,
      req.body ?? {},
      '更新敏感词参数不合法'
    );
    ok(res, await updateSensitiveWord(itemId, body, ctxOf(req)), '敏感词已更新');
  } catch (err) {
    next(err);
  }
});

dictsRouter.post('/dicts/sensitive-words/rescan-preview', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    ok(res, await previewSensitiveRescan(undefined, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dictsRouter.post('/dicts/sensitive-words/rescan', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const body = parseOrThrow(rescanSchema, req.body ?? {}, '历史重扫参数不合法');
    ok(res, await executeSensitiveRescan(body.previewToken, ctxOf(req)), '历史诉求重扫完成');
  } catch (err) {
    next(err);
  }
});

dictsRouter.get('/dicts/:code/items', async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!isSupportedDictCode(code)) {
      throw AppError.notFound('未知字典类型：' + code + '（支持 ' + SUPPORTED_DICT_CODES.join(' / ') + '）');
    }
    ok(res, await findDictItems(code));
  } catch (err) {
    next(err);
  }
});
