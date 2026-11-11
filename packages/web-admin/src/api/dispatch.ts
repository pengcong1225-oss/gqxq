import request from './request';
import type {
  ApprovalTraceItem,
  CreateDispatchRequest,
  CreateDispatchResult,
  Csv,
  DispatchOrderDetail,
  DispatchOrderListItem,
  DispatchOrderParams,
  DispatchOrderStatus,
  DispatchRequestLogItem,
  Paged,
  PushDispatchResult,
} from '../types/api';

/** { content, total } 形状的列表响应（推送日志 / 审批轨迹共用） */
export interface ListResult<T> {
  content: T[];
  total: number;
}

/** 协议要求多值参数为「逗号分隔字符串」；此处同时接受数组，统一在 api 层序列化。 */
function toCsv<T extends string>(value: Csv<T> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 敏感交办列表：服务端分页 / 筛选。真查 dispatch_order 表，
 * 不是按敏感诉求现场生成（G1 前那版就是现场 randomItem，已废弃）。
 *
 * GET /dispatch/orders
 */
export async function listDispatchOrders(
  params: DispatchOrderParams = {}
): Promise<Paged<DispatchOrderListItem>> {
  const query = {
    page: params.page,
    size: params.size,
    keyword: params.keyword,
    status: toCsv(params.status),
    complaintId: params.complaintId,
    targetEnterpriseCode: params.targetEnterpriseCode,
    startDate: params.startDate,
    endDate: params.endDate,
  };
  return request.get<never, Paged<DispatchOrderListItem>>('/dispatch/orders', { params: query });
}

/**
 * 交办详情。
 *
 * GET /dispatch/orders/:assignmentId
 */
export async function getDispatchOrder(assignmentId: string): Promise<DispatchOrderDetail> {
  return request.get<never, DispatchOrderDetail>('/dispatch/orders/' + encode(assignmentId));
}

/**
 * 创建交办：**幂等**。同一诉求已有有效交办时后端返回 created=false 并带既有记录，
 * 调用方必须据此提示「该诉求已有交办」，不得再建第二条。
 *
 * POST /dispatch/orders
 */
export async function createDispatch(body: CreateDispatchRequest): Promise<CreateDispatchResult> {
  return request.post<never, CreateDispatchResult>('/dispatch/orders', body);
}

/**
 * 受控撤销（终态，不可复活），必须给出原因，后端写审计。
 *
 * POST /dispatch/orders/:assignmentId/cancel
 *
 * 响应形状已由后端线确认：返回 DispatchOrderDetail。
 * 但调用方仍以**重新拉取**为准（忽略响应体），这样即使未来形状变化也不影响页面正确性。
 */
export async function cancelDispatch(
  assignmentId: string,
  reason: string
): Promise<DispatchOrderDetail> {
  return request.post<never, DispatchOrderDetail>(
    '/dispatch/orders/' + encode(assignmentId) + '/cancel',
    { reason }
  );
}

/** Persist explicit intent; deliveryState is durable state, queued is not provider acceptance. */
export async function pushDispatch(assignmentId: string): Promise<PushDispatchResult> {
  return request.post<never, PushDispatchResult>(
    '/dispatch/orders/' + encode(assignmentId) + '/push'
  );
}

/**
 * 重推交办：同一 requestId、同一报文、**新 nonce + 新时间戳**。
 * 仅在服务端允许的原请求恢复或旧记录首次纳入时使用；默认unknown须人工核验。
 *
 * POST /dispatch/orders/:assignmentId/repush
 */
export async function repushDispatch(assignmentId: string): Promise<PushDispatchResult> {
  return request.post<never, PushDispatchResult>(
    '/dispatch/orders/' + encode(assignmentId) + '/repush'
  );
}

/**
 * 推送尝试日志（每次尝试一行，含 nonce / httpStatus / errorCode / taskId）。
 *
 * GET /dispatch/orders/:assignmentId/push-logs
 */
export async function getPushLogs(assignmentId: string): Promise<ListResult<DispatchRequestLogItem>> {
  return request.get<never, ListResult<DispatchRequestLogItem>>(
    '/dispatch/orders/' + encode(assignmentId) + '/push-logs'
  );
}

/**
 * 审批轨迹（签收 / 提交 / 退回 / 最终审批，批次 G4）。
 *
 * GET /dispatch/orders/:assignmentId/approval-trace
 */
export async function getApprovalTrace(assignmentId: string): Promise<ListResult<ApprovalTraceItem>> {
  return request.get<never, ListResult<ApprovalTraceItem>>(
    '/dispatch/orders/' + encode(assignmentId) + '/approval-trace'
  );
}

/** 交办状态里属于「进行中」的集合（与后端唯一有效交办约束的集合一致） */
export const ACTIVE_DISPATCH_STATUSES: readonly DispatchOrderStatus[] = [
  'pending',
  'pushed',
  'accepted',
  'processing',
  'returned',
];

/** 终态：不可再撤销 */
export const TERMINAL_DISPATCH_STATUSES: readonly DispatchOrderStatus[] = [
  'completed',
  'rejected',
  'archived',
  'cancelled',
];
