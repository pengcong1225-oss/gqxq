import { Router } from 'express';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import { findEnterpriseByCode, findEnterprises } from '../repositories/enterpriseRepo';

// 企业主数据（数据源是既有的 enterprise 表）。
// 总账的「匹配单位」与「发起交办」必须从真实企业列表里选，
// 手抄 enterprise_code 一旦与登记值不一致，后续交办就匹配不到同一主体。
export const enterprisesRouter = Router();

function readStr(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

enterprisesRouter.get('/enterprises', async (req, res, next) => {
  try {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const size = req.query.size === undefined ? 20 : Number(req.query.size);
    if (!Number.isInteger(page) || page < 1) {
      throw AppError.validation('page 必须是 >=1 的整数', [{ field: 'page', message: '必须 >= 1' }]);
    }
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw AppError.validation('size 必须在 1..100', [{ field: 'size', message: '必须在 1..100' }]);
    }
    const keyword = readStr(req.query.keyword);
    const result = await findEnterprises(
      {
        keyword: keyword === undefined ? undefined : keyword.slice(0, 100),
        businessType: readStr(req.query.businessType),
        status: readStr(req.query.status),
      },
      page,
      size
    );
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

enterprisesRouter.get('/enterprises/:enterpriseCode', async (req, res, next) => {
  try {
    const detail = await findEnterpriseByCode(req.params.enterpriseCode);
    if (!detail) throw AppError.notFound('企业不存在');
    ok(res, detail);
  } catch (err) {
    next(err);
  }
});
