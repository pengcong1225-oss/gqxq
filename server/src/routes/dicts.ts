import { currentAccessContext } from '../auth/accessScope';
import { dictionaryService, saveTypeSchema, saveItemSchema, parseDictionaryInput } from '../services/dictService';
import { readDictionaryType } from '../services/dictService';
import { pool } from '../db/pool';
import { categoryOptions, reviseCategory, categoryHistory } from '../services/categoryService';
import type { MasterDataContext } from '../types/masterData';
import { assertAllScope } from '../auth/accessScope';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { SUPPORTED_DICT_CODES, findDictItems, isSupportedDictCode } from '../repositories/dictRepo';
import { ROLE_ADMIN } from '../auth/rolePolicy';
import { requirePermission } from '../middleware/requireRole';
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
dictsRouter.get('/dicts/sensitive-words', requirePermission('system.dict.manage'), async (_req, res, next) => {
  try {
    ok(res, await listManagedSensitiveWords());
  } catch (err) {
    next(err);
  }
});

dictsRouter.post('/dicts/sensitive-words', requirePermission('system.dict.manage'), async (req, res, next) => {
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

dictsRouter.patch('/dicts/sensitive-words/:itemId', requirePermission('system.dict.manage'), async (req, res, next) => {
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

dictsRouter.post('/dicts/sensitive-words/rescan-preview', requirePermission('system.dict.manage'), async (req, res, next) => {
  try {
    ok(res, await previewSensitiveRescan(undefined, ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dictsRouter.post('/dicts/sensitive-words/rescan', requirePermission('system.dict.manage'), async (req, res, next) => {
  try {
    assertAllScope();
    const body = parseOrThrow(rescanSchema, req.body ?? {}, '历史重扫参数不合法');
    ok(res, await executeSensitiveRescan(body.previewToken, ctxOf(req)), '历史诉求重扫完成');
  } catch (err) {
    next(err);
  }
});

function masterContext(req:Request):MasterDataContext {return {...ctxOf(req),permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()};}
const expected=z.object({expectedVersion:z.number().int().nonnegative()}).strict();
dictsRouter.get('/dict-types',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.listTypes(masterContext(req)));}catch(e){next(e);}});
dictsRouter.post('/dict-types',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.saveType(parseDictionaryInput(saveTypeSchema,req.body),masterContext(req)));}catch(e){next(e);}});
dictsRouter.patch('/dict-types/:code',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.saveType(parseDictionaryInput(saveTypeSchema,{...req.body,code:req.params.code}),masterContext(req)));}catch(e){next(e);}});
dictsRouter.delete('/dict-types/:code',requirePermission('system.dict.manage'),async(req,res,next)=>{try{const body=parseDictionaryInput(expected,req.body);ok(res,await dictionaryService.deleteType(String(req.params.code),body.expectedVersion,masterContext(req)));}catch(e){next(e);}});
dictsRouter.get('/dict-types/:code/items',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.items(String(req.params.code),masterContext(req)));}catch(e){next(e);}});
dictsRouter.post('/dict-types/:code/items',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.saveItem(parseDictionaryInput(saveItemSchema,{...req.body,typeCode:req.params.code}),masterContext(req)));}catch(e){next(e);}});
dictsRouter.patch('/dict-types/:code/items/:itemCode',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.saveItem(parseDictionaryInput(saveItemSchema,{...req.body,typeCode:req.params.code,code:req.params.itemCode}),masterContext(req)));}catch(e){next(e);}});
dictsRouter.delete('/dict-types/:code/items/:itemCode',requirePermission('system.dict.manage'),async(req,res,next)=>{try{const body=parseDictionaryInput(expected,req.body);ok(res,await dictionaryService.deleteItem(String(req.params.code),String(req.params.itemCode),body.expectedVersion,masterContext(req)));}catch(e){next(e);}});
dictsRouter.get('/dict-types/:code/references',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.references(String(req.params.code),null,masterContext(req)));}catch(e){next(e);}});
dictsRouter.get('/dict-types/:code/items/:itemCode/references',requirePermission('system.dict.manage'),async(req,res,next)=>{try{ok(res,await dictionaryService.references(String(req.params.code),String(req.params.itemCode),masterContext(req)));}catch(e){next(e);}});
dictsRouter.get('/categories',async(_req,res,next)=>{try{ok(res,await categoryOptions());}catch(e){next(e);}});
dictsRouter.post('/complaints/:complaintId/category',requirePermission('complaint.correct'),async(req,res,next)=>{try{const body=parseOrThrow(z.object({category:z.unknown(),expectedVersion:z.number().int().positive(),basis:z.string().trim().min(1).max(500)}).strict(),req.body,'分类纠偏参数不合法');ok(res,await reviseCategory({complaintId:String(req.params.complaintId),...body,category:body.category as any},masterContext(req)));}catch(e){next(e);}});
dictsRouter.get('/complaints/:complaintId/category-history',async(req,res,next)=>{try{ok(res,await categoryHistory(String(req.params.complaintId),masterContext(req)));}catch(e){next(e);}});

dictsRouter.get('/dicts/:code/items', async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!isSupportedDictCode(code) && !(await readDictionaryType(pool,code))) {
      throw AppError.notFound('未知字典类型：' + code + '（支持 ' + SUPPORTED_DICT_CODES.join(' / ') + '）');
    }
    ok(res, await findDictItems(code));
  } catch (err) {
    next(err);
  }
});
