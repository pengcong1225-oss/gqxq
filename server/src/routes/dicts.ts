import { Router } from 'express';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { SUPPORTED_DICT_CODES, findDictItems, isSupportedDictCode } from '../repositories/dictRepo';

// GET /dicts/:code/items（G1.3）：优先读 dict_type / dict_item；
// 库中缺失的字典类型（三个状态轴、source_system）回退受控词汇表，绝不返回空数组。
export const dictsRouter = Router();

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
