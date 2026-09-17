import request from './request';
import type {
  AnalysisRecordItem,
  ApprovalTraceItem,
  ComplaintDetail,
  CorrectionItem,
  Csv,
  DispatchOrderDetail,
  Paged,
  ReportTodoItem,
  ReportTodoStatus,
  BusinessType,
} from '../types/api';

/** { content, total } 形状的列表响应（与 api/dispatch.ts 的 ListResult 同形） */
export interface ListResult<T> {
  content: T[];
  total: number;
}

export interface AnalysisRecordParams {
  page?: number;
  size?: number;
  districtCode?: string;
  businessType?: Csv<BusinessType>;
  enterpriseCode?: string;
}

export interface ReportTodoParams {
  page?: number;
  size?: number;
  status?: Csv<ReportTodoStatus>;
}

/**
 * 分析库单条的**可回查关联**。
 *
 * ⚠️ 形状来自 2026-09-17 端到端实测，不是猜测：
 * 顶层是**嵌套**形状 { record, complaint, dispatch, approvalTraces, corrections, reportTodo }。
 * 分析记录本身在 record 里，不是把记录字段平铺到顶层；审批轨迹字段名是 approvalTraces（复数）。
 */
export interface AnalysisRecordDetail {
  /** 分析记录本身（**不是**平铺在顶层——实测为嵌套形状） */
  record: AnalysisRecordItem;
  complaint: ComplaintDetail | null;
  dispatch: DispatchOrderDetail | null;
  /** 注意是复数：approvalTraces */
  approvalTraces: ApprovalTraceItem[];
  corrections: CorrectionItem[];
  reportTodo: ReportTodoItem | null;
}

function toCsv<T extends string>(value: Csv<T> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 分析库列表（服务端分页 + 筛选）。
 *
 * **口径（务必在页面上写清）**：只有**纠偏闭环完成**的诉求才会出现在这里。
 * 「无需交办归库」「误报归库」的诉求不纳入分析口径。
 *
 * GET /analysis/records
 */
export async function listAnalysisRecords(
  params: AnalysisRecordParams = {}
): Promise<Paged<AnalysisRecordItem>> {
  return request.get<never, Paged<AnalysisRecordItem>>('/analysis/records', {
    params: {
      page: params.page,
      size: params.size,
      districtCode: params.districtCode,
      businessType: toCsv(params.businessType),
      enterpriseCode: params.enterpriseCode,
    },
  });
}

/**
 * 分析库单条 + 可回查关联（诉求 / 交办 / 审批轨迹 / 纠偏项）。
 *
 * GET /analysis/records/:analysisId
 */
export async function getAnalysisRecord(analysisId: string): Promise<AnalysisRecordDetail> {
  return request.get<never, AnalysisRecordDetail>('/analysis/records/' + encode(analysisId));
}

/**
 * 待查报告待办队列。
 *
 * 注意：报告**如何形成、是否需要审批与发布，规则待业务方确认**；
 * 本接口只提供「待查入口」，不代表报告已生成。
 *
 * GET /report-todos
 */
export async function listReportTodos(
  params: ReportTodoParams = {}
): Promise<Paged<ReportTodoItem>> {
  return request.get<never, Paged<ReportTodoItem>>('/report-todos', {
    params: { page: params.page, size: params.size, status: toCsv(params.status) },
  });
}
