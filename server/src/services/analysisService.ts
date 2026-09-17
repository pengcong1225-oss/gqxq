// G5 分析库与待查报告：只读 + 下钻。
// 入库逻辑在 correctionService.maybeEnterAnalysis（唯一入口），本文件不写任何业务表。
import type {
  AnalysisRecordItem,
  ApprovalTraceItem,
  ComplaintDetail,
  CorrectionItem,
  DispatchOrderDetail,
  Paged,
  ReportTodoItem,
} from '../types/api';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { findAnalysisByAnalysisId, findAnalysisPage } from '../repositories/analysisRepo';
import { findTodoByAnalysisId, findTodoPage, isReportTodoStatus } from '../repositories/reportTodoRepo';
import { listByComplaint } from '../repositories/correctionRepo';
import { listTracesByAssignment } from '../repositories/approvalTraceRepo';
import { findByIdOrNo } from '../repositories/complaintRepo';
import { rowToDetail } from '../repositories/complaintMapper';
import { findOrderByAssignmentId, rowToDispatchDetail } from '../repositories/dispatchRepo';
import { parsePageQuery, queryText } from './correctionService';

/**
 * 分析记录的下钻组合对象。
 *
 * 说明：组合类型不属于跨系统契约，因此定义在本服务里而不是 types/api.ts。
 * 若前端需要，再提升到 types/api.ts 并两侧对齐。
 */
export interface AnalysisDrilldown {
  record: AnalysisRecordItem;
  complaint: ComplaintDetail | null;
  dispatch: DispatchOrderDetail | null;
  approvalTraces: ApprovalTraceItem[];
  corrections: CorrectionItem[];
  reportTodo: ReportTodoItem | null;
}

export async function listAnalysisRecords(
  query: Record<string, unknown>
): Promise<Paged<AnalysisRecordItem>> {
  const { page, size } = parsePageQuery(query);
  const districtCode = queryText(query.districtCode, 'districtCode', 64);
  const businessType = queryText(query.businessType, 'businessType', 32);
  const enterpriseCode = queryText(query.enterpriseCode, 'enterpriseCode', 64);
  const { content, total } = await findAnalysisPage(
    pool,
    { districtCode, businessType, enterpriseCode },
    page,
    size
  );
  return { content, total, page, size, totalPages: Math.ceil(total / size) };
}

/** 单条分析记录 + 诉求 / 交办 / 审批轨迹 / 纠偏项 / 待查待办，全部真实数据，失败即抛错。 */
export async function getAnalysisDrilldown(analysisId: string): Promise<AnalysisDrilldown> {
  const record = await findAnalysisByAnalysisId(pool, analysisId);
  if (!record) throw AppError.notFound('分析记录不存在');

  const complaintRow = await findByIdOrNo(record.complaintId);
  const complaint: ComplaintDetail | null = complaintRow ? rowToDetail(complaintRow) : null;

  let dispatch: DispatchOrderDetail | null = null;
  if (record.assignmentId !== null) {
    const orderRow = await findOrderByAssignmentId(pool, record.assignmentId);
    if (orderRow) dispatch = rowToDispatchDetail(orderRow);
  }

  const approvalTraces =
    record.assignmentId === null ? [] : await listTracesByAssignment(pool, record.assignmentId);
  const corrections = await listByComplaint(pool, record.complaintId);
  const reportTodo = await findTodoByAnalysisId(pool, analysisId);

  return { record, complaint, dispatch, approvalTraces, corrections, reportTodo };
}

export async function listReportTodos(query: Record<string, unknown>): Promise<Paged<ReportTodoItem>> {
  const { page, size } = parsePageQuery(query);
  const status = queryText(query.status, 'status', 16);
  if (status !== undefined && !isReportTodoStatus(status)) {
    throw AppError.validation('参数 status 只能是 pending / in_progress / done', [
      { field: 'status', message: '取值 pending / in_progress / done' },
    ]);
  }
  const { content, total } = await findTodoPage(pool, { status }, page, size);
  return { content, total, page, size, totalPages: Math.ceil(total / size) };
}
