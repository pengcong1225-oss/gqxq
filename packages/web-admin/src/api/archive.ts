import request from './request';
import type { DispatchOrderDetail } from '../types/api';

/**
 * 交办归档：写 dispatch_order.status='archived' + archived_at，并写审计（不是新增一张表）。
 *
 * 前置条件（后端校验，违反返回 409 INVALID_STATE_TRANSITION）：
 *   1. 交办已完成（填报审批最终通过）；
 *   2. 该诉求**没有未确认的纠偏项**。
 * 第 2 条被拒时调用方必须给出明确原因与纠偏入口，不能显示成泛化错误。
 *
 * POST /dispatch/orders/:assignmentId/archive
 */
export async function archiveDispatch(assignmentId: string): Promise<DispatchOrderDetail> {
  return request.post<never, DispatchOrderDetail>(
    '/dispatch/orders/' + encodeURIComponent(assignmentId) + '/archive'
  );
}
