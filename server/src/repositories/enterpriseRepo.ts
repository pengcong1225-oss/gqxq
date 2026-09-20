// 企业主数据读取。数据源是既有的 enterprise 表（已有 4 家真实企业），不是新建字典。
// 两个用途（业主 2026-09-20 裁定后）：
//   1) 纠偏页选责任单位、总账页发起交办时，企业清单从这里取——手抄 enterprise_code 一旦与登记值不一致，
//      后续交办就匹配不到同一主体；
//   2) **写路径的校验源**：confirmResponsibleEnterpriseInTx 在事务内按 enterprise_code 回查登记名称，
//      编码查不到就直接拒绝写入，enterprise_name 一律取这里的登记值（见 assignmentService）。
import { pool, type Row } from '../db/pool';
import { labelOf } from '../domain/enums';
import type {
  EnterpriseDetail,
  EnterpriseFilter,
  EnterpriseListItem,
  Paged,
} from '../types/api';
import { toNum, toStr } from './complaintMapper';
import type { Queryable } from './complaintSourceLogRepo';

const ENTERPRISE_COLUMNS = [
  'e.id',
  'e.enterprise_code',
  'e.enterprise_name',
  'e.business_type',
  'e.uscc',
  'e.legal_person',
  'e.contact_person',
  'e.contact_phone',
  'e.service_area',
  'e.annual_score',
  'e.status',
].join(', ');

type EntRow = Record<string, unknown>;

function rowToItem(r: EntRow): EnterpriseListItem {
  const businessType = String(r.business_type ?? '');
  return {
    id: Number(r.id),
    enterpriseCode: String(r.enterprise_code),
    enterpriseName: String(r.enterprise_name),
    businessType,
    businessTypeName: labelOf('business_type', businessType),
    uscc: toStr(r.uscc),
    contactPerson: toStr(r.contact_person),
    contactPhone: toStr(r.contact_phone),
    serviceArea: toStr(r.service_area),
    status: String(r.status ?? ''),
  };
}

function buildWhere(filter: EnterpriseFilter): { text: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.keyword) {
    // 与 complaintRepo 一致：用 escape '!' 而不是反斜杠（反斜杠在本机 MySQL 上会报语法错误）
    const kw = '%' + filter.keyword.replace(/[!%_]/g, (m) => '!' + m) + '%';
    parts.push("(e.enterprise_name like ? escape '!' or e.enterprise_code like ? escape '!')");
    params.push(kw, kw);
  }
  if (filter.businessType) {
    parts.push('e.business_type = ?');
    params.push(filter.businessType);
  }
  if (filter.status) {
    parts.push('e.status = ?');
    params.push(filter.status);
  }
  return { text: parts.length > 0 ? ' where ' + parts.join(' and ') : '', params };
}

export async function findEnterprises(
  filter: EnterpriseFilter,
  page: number,
  size: number
): Promise<Paged<EnterpriseListItem>> {
  const where = buildWhere(filter);
  const [countRows] = await pool.query<Row[]>(
    'select count(*) as total from enterprise e' + where.text,
    where.params
  );
  const total = Number(
    (countRows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0
  );
  const [rows] = await pool.query<Row[]>(
    'select ' + ENTERPRISE_COLUMNS + ' from enterprise e' + where.text +
      ' order by e.enterprise_code asc limit ? offset ?',
    [...where.params, size, (page - 1) * size]
  );
  return {
    content: (rows as unknown as EntRow[]).map(rowToItem),
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
  };
}

export async function findEnterpriseByCodeIn(db: Queryable, code: string): Promise<EnterpriseDetail | null> {
  const [rows] = await db.query<Row[]>(
    'select ' + ENTERPRISE_COLUMNS + ' from enterprise e where e.enterprise_code = ? limit 1',
    [code]
  );
  const row = (rows as unknown as EntRow[])[0];
  if (!row) return null;
  return {
    ...rowToItem(row),
    legalPerson: toStr(row.legal_person),
    annualScore: toNum(row.annual_score),
  };
}

/**
 * 按登记编码查企业（连接池只读）。
 * 写路径上的校验请用 findEnterpriseByCodeIn —— 校验与写入必须在同一个事务连接里，
 * 否则"校验通过后再被人换掉登记值"这段窗口无法避免。
 */
export async function findEnterpriseByCode(code: string): Promise<EnterpriseDetail | null> {
  return findEnterpriseByCodeIn(pool, code);
}
