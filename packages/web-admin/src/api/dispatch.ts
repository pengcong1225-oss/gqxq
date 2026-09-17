import request from './request';
import type {
  CreateDispatchRequest,
  CreateDispatchResult,
  Csv,
  DispatchOrderDetail,
  DispatchOrderListItem,
  DispatchOrderParams,
  DispatchOrderStatus,
  Paged,
} from '../types/api';

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
 * 注意：后端 DTO 里**没有**为 cancel 单独定义响应类型（server/src/types/api.ts 未冻结该项）。
 * 这里按最可能的形状声明为 DispatchOrderDetail，但**调用方一律忽略响应体、改以重新拉取为准**，
 * 因此即使后端返回别的形状（例如 {cancelled, order}）也不会影响页面正确性。
 * 该项属于待与后端线确认的契约缺口。
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
