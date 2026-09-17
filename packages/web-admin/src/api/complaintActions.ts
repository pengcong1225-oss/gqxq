import request from './request';
import type {
  AssignEnterpriseRequest,
  AssignEnterpriseResult,
  ComplaintIdOrNo,
  DispositionRequest,
  DispositionResult,
} from '../types/api';

function encode(value: ComplaintIdOrNo): string {
  return encodeURIComponent(String(value));
}

/**
 * 匹配 / 调整责任单位：写 complaint 的责任企业，并追加 complaint_assignment 留痕
 * （保存前后值、原因、操作者）。
 *
 * POST /complaints/:idOrNo/assignment
 */
export async function assignEnterprise(
  idOrNo: ComplaintIdOrNo,
  body: AssignEnterpriseRequest
): Promise<AssignEnterpriseResult> {
  return request.post<never, AssignEnterpriseResult>(
    '/complaints/' + encode(idOrNo) + '/assignment',
    body
  );
}

/**
 * 归库处置：
 *   - no_dispatch_needed  无需交办归库
 *   - false_positive      误报归库。**注意：不会取消敏感标记**——is_sensitive 保留自动命中的事实，
 *                       误报判定记在 complaint_disposition.is_sensitive_before/reason 里，便于回查。
 * 两者都必须留痕，且都不产生交办记录。
 *
 * POST /complaints/:idOrNo/disposition
 */
export async function applyDisposition(
  idOrNo: ComplaintIdOrNo,
  body: DispositionRequest
): Promise<DispositionResult> {
  return request.post<never, DispositionResult>(
    '/complaints/' + encode(idOrNo) + '/disposition',
    body
  );
}
