import request from './request';
import type {
  ComplaintIdOrNo,
  DispositionRequest,
  DispositionResult,
} from '../types/api';

function encode(value: ComplaintIdOrNo): string {
  return encodeURIComponent(String(value));
}

// 「匹配责任单位」的前端调用已随入口一起下线（业主 2026-09-20 裁定：收敛进纠偏入口）。
// 后端 POST /complaints/:idOrNo/assignment 仍保留给脚本/外部复用，但页面不得再直接改责任企业——
// 责任单位只能在纠偏里确认，那条路径会做主数据校验并成对写 enterprise_code + enterprise_name。

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
