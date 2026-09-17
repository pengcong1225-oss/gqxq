import request from './request';
import type {
  ComplaintDetail,
  ComplaintIdOrNo,
  ComplaintListParams,
  ComplaintListResult,
  Csv,
  TimelineResult,
} from '../types/api';

/** 协议要求多值参数为「逗号分隔字符串」；此处同时接受数组，统一在 api 层序列化。 */
function toCsv<T extends string>(value: Csv<T> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

/** 协议上 isSensitive 为 0/1；此处同时接受 boolean 并归一为 0/1。 */
function toFlag(value: 0 | 1 | boolean | undefined): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * 诉求总账列表：服务端分页 / 筛选，并返回当前筛选条件下的全量统计 stats
 * （stats 不受分页影响，避免卡片数字与表格对不上）。
 *
 * GET /complaints
 */
export async function listComplaints(
  params: ComplaintListParams = {}
): Promise<ComplaintListResult> {
  const query = {
    page: params.page,
    size: params.size,
    keyword: params.keyword,
    businessType: toCsv(params.businessType),
    complaintType: toCsv(params.complaintType),
    urgencyLevel: toCsv(params.urgencyLevel),
    supervisionStatus: toCsv(params.supervisionStatus),
    sourceEventStatus: toCsv(params.sourceEventStatus),
    reportingStatus: toCsv(params.reportingStatus),
    isSensitive: toFlag(params.isSensitive),
    correctionStatus: params.correctionStatus,
    districtCode: params.districtCode,
    enterpriseCode: params.enterpriseCode,
    startDate: params.startDate,
    endDate: params.endDate,
    sort: params.sort,
  };

  return request.get<never, ComplaintListResult>('/complaints', { params: query });
}

/**
 * 诉求详情：idOrNo 为纯数字时按数值 id 查，否则按 complaint_no 查。
 *
 * 未命中时服务端返回 HTTP 404（code = NOT_FOUND），调用方必须展示「不存在」，
 * 不得回退到任何示例数据。
 *
 * GET /complaints/:idOrNo
 */
export async function getComplaint(idOrNo: ComplaintIdOrNo): Promise<ComplaintDetail> {
  return request.get<never, ComplaintDetail>(
    `/complaints/${encodeURIComponent(String(idOrNo))}`
  );
}

/**
 * 详情时间线：INTAKE / FIELD_CHANGE / OPERATION / APPROVAL 四类真实事件按时间合并。
 * 无事件时返回 { content: [], total: 0 }，调用方展示空态。
 *
 * GET /complaints/:idOrNo/timeline
 */
export async function getComplaintTimeline(idOrNo: ComplaintIdOrNo): Promise<TimelineResult> {
  return request.get<never, TimelineResult>(
    `/complaints/${encodeURIComponent(String(idOrNo))}/timeline`
  );
}
