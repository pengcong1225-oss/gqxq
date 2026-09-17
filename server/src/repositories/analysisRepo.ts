// analysis_record（分析库）。
//
// 硬门规（落地计划 G5）：**未纠偏不得进入分析库**。
// 本表用 uk_ar_complaint 保证"一个诉求只入分析库一次"，
// 并发场景下即使两条确认请求同时判定"可以入库"，也只有一条能插入成功，
// 另一条捕获重复键后返回既有记录（不报 500）。
import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx';
import type { AnalysisRecordItem } from '../types/api';
import { labelOf } from '../domain/enums';
import { cut, type Queryable } from './complaintSourceLogRepo';
import { toIso } from './complaintMapper';
import { isDuplicateKey } from './dispatchRepo';

export interface AnalysisRow {
  id: number;
  analysisId: string;
  complaintId: string;
  assignmentId: string | null;
  businessType: string | null;
  complaintType: string | null;
  districtCode: string | null;
  districtName: string | null;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  summary: string | null;
  disposalResult: string | null;
  confirmedAt: unknown;
  createdAt: unknown;
}

export function rowToAnalysisItem(r: AnalysisRow): AnalysisRecordItem {
  const businessTypeCode = r.businessType === null || r.businessType === undefined ? '' : String(r.businessType);
  const complaintTypeCode = r.complaintType === null || r.complaintType === undefined ? '' : String(r.complaintType);
  return {
    id: Number(r.id),
    analysisId: String(r.analysisId),
    complaintId: String(r.complaintId),
    assignmentId: r.assignmentId === null || r.assignmentId === undefined ? null : String(r.assignmentId),
    businessTypeCode,
    businessTypeName: labelOf('business_type', businessTypeCode),
    complaintTypeCode,
    complaintTypeName: labelOf('complaint_type', complaintTypeCode),
    districtCode: r.districtCode === null || r.districtCode === undefined ? null : String(r.districtCode),
    districtName: r.districtName === null || r.districtName === undefined ? null : String(r.districtName),
    enterpriseCode: r.enterpriseCode === null || r.enterpriseCode === undefined ? null : String(r.enterpriseCode),
    enterpriseName: r.enterpriseName === null || r.enterpriseName === undefined ? null : String(r.enterpriseName),
    summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
    disposalResult: r.disposalResult === null || r.disposalResult === undefined ? null : String(r.disposalResult),
    confirmedAt: toIso(r.confirmedAt),
    createdAt: toIso(r.createdAt),
  };
}

const SELECT_COLUMNS =
  'id, analysis_id as analysisId, complaint_id as complaintId, assignment_id as assignmentId,' +
  ' business_type as businessType, complaint_type as complaintType,' +
  ' district_code as districtCode, district_name as districtName,' +
  ' enterprise_code as enterpriseCode, enterprise_name as enterpriseName,' +
  ' summary, disposal_result as disposalResult, confirmed_at as confirmedAt, created_at as createdAt';

export interface InsertAnalysisInput {
  complaintId: string;
  assignmentId: string | null;
  businessType: string | null;
  complaintType: string | null;
  districtCode: string | null;
  districtName: string | null;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  summary: string | null;
  disposalResult: string | null;
  payload: Record<string, unknown> | null;
  /** 纠偏全部确认的时间，即分析记录的成立时点 */
  confirmedAt: Date;
  createdAt: Date;
}

export interface InsertAnalysisOutcome {
  analysisId: string;
  created: boolean;
}

/**
 * 插入分析记录。**幂等**：撞 uk_ar_complaint 时回读既有记录并返回 created=false。
 * 调用方必须已在同一事务内校验过"该诉求纠偏项全部不再 pending"。
 */
export async function insertAnalysisIfAbsent(
  tx: Tx,
  input: InsertAnalysisInput
): Promise<InsertAnalysisOutcome> {
  const analysisId = 'ANA-' + randomUUID();
  try {
    await tx.execute(
      'insert into analysis_record ' +
        '(analysis_id, complaint_id, assignment_id, business_type, complaint_type,' +
        ' district_code, district_name, enterprise_code, enterprise_name, summary, disposal_result,' +
        ' confirmed_at, payload, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        analysisId,
        cut(input.complaintId, 64),
        cut(input.assignmentId, 64),
        cut(input.businessType, 32),
        cut(input.complaintType, 32),
        cut(input.districtCode, 64),
        cut(input.districtName, 128),
        cut(input.enterpriseCode, 64),
        cut(input.enterpriseName, 255),
        cut(input.summary, 1000),
        input.disposalResult,
        input.confirmedAt,
        input.payload === null ? null : JSON.stringify(input.payload),
        input.createdAt,
      ]
    );
    return { analysisId, created: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const [rows] = await tx.query(
      'select analysis_id as analysisId from analysis_record where complaint_id = ? limit 1',
      [input.complaintId]
    );
    const row = (rows as unknown as Array<{ analysisId: string }>)[0];
    if (!row) throw err;
    return { analysisId: String(row.analysisId), created: false };
  }
}

export async function findAnalysisByAnalysisId(
  db: Queryable,
  analysisId: string
): Promise<AnalysisRecordItem | null> {
  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from analysis_record where analysis_id = ? limit 1',
    [analysisId]
  );
  const row = (rows as unknown as AnalysisRow[])[0];
  return row ? rowToAnalysisItem(row) : null;
}

export async function findAnalysisByComplaint(
  db: Queryable,
  complaintId: string
): Promise<AnalysisRecordItem | null> {
  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from analysis_record where complaint_id = ? limit 1',
    [complaintId]
  );
  const row = (rows as unknown as AnalysisRow[])[0];
  return row ? rowToAnalysisItem(row) : null;
}

export interface AnalysisFilter {
  districtCode?: string;
  businessType?: string;
  enterpriseCode?: string;
}

export async function findAnalysisPage(
  db: Queryable,
  filter: AnalysisFilter,
  page: number,
  size: number
): Promise<{ content: AnalysisRecordItem[]; total: number }> {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.districtCode !== undefined) {
    parts.push('district_code = ?');
    params.push(filter.districtCode);
  }
  if (filter.businessType !== undefined) {
    parts.push('business_type = ?');
    params.push(filter.businessType);
  }
  if (filter.enterpriseCode !== undefined) {
    parts.push('enterprise_code = ?');
    params.push(filter.enterpriseCode);
  }
  const where = parts.length > 0 ? ' where ' + parts.join(' and ') : '';

  const [countRows] = await db.query('select count(*) as total from analysis_record' + where, params);
  const total = Number((countRows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from analysis_record' + where +
      ' order by confirmed_at desc, id desc limit ? offset ?',
    [...params, size, (page - 1) * size]
  );
  return { content: (rows as unknown as AnalysisRow[]).map(rowToAnalysisItem), total };
}

/** 判断某诉求是否走过督办链路（有交办单）。这是"是否纳入分析口径"的硬条件。 */
export async function hasDispatchOrder(db: Queryable, complaintId: string): Promise<boolean> {
  const [rows] = await db.query(
    'select 1 as ok from dispatch_order where complaint_id = ? limit 1',
    [complaintId]
  );
  return (rows as unknown[]).length > 0;
}
