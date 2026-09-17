import request from './request';
import type {
  CloseComplaintRequest,
  CloseComplaintResult,
  ComplaintIdOrNo,
  CorrectionConfirmRequest,
  CorrectionGenerateResult,
  CorrectionItem,
  CorrectionRejectRequest,
  Paged,
} from '../types/api';

/** { content, total } 形状的列表响应（与 api/dispatch.ts 的 ListResult 同形） */
export interface ListResult<T> {
  content: T[];
  total: number;
}

export interface PendingCorrectionParams {
  page?: number;
  size?: number;
  /** 只看某个诉求的待纠偏项 */
  complaintId?: string;
}

function encode(value: ComplaintIdOrNo): string {
  return encodeURIComponent(String(value));
}

/**
 * 待纠偏队列（服务端分页）。返回的是**逐字段**的纠偏项，不是"诉求列表"——
 * 一个诉求可能同时有多项待纠偏（企业名称/地址/分类/坐标/摘要/企业处置结果）。
 *
 * GET /corrections/pending
 */
export async function listPendingCorrections(
  params: PendingCorrectionParams = {}
): Promise<Paged<CorrectionItem>> {
  return request.get<never, Paged<CorrectionItem>>('/corrections/pending', {
    params: { page: params.page, size: params.size, complaintId: params.complaintId },
  });
}

/**
 * 某个诉求的全部纠偏项（含已确认/已判定无需的），用于右侧闭环面板。
 *
 * ⚠️ 形状注意（2026-09-17 端到端实测）：本接口返回的是**裸数组** CorrectionItem[]，
 * 不是 {content,total} 分页封套——分页封套只用于 /corrections/pending。
 * 这是实测结论，不是猜测。
 *
 * GET /complaints/:idOrNo/corrections
 */
export async function listComplaintCorrections(idOrNo: ComplaintIdOrNo): Promise<CorrectionItem[]> {
  return request.get<never, CorrectionItem[]>('/complaints/' + encode(idOrNo) + '/corrections');
}

/**
 * 生成纠偏待办。上游触发点是**最终回传之后**（G4 的 task_approved + agreed）；
 * 本按钮用于补生成。
 *
 * **幂等**：已有纠偏项时后端返回 created=false 并带上既有的 items，
 * 调用方必须据此提示「该诉求已有纠偏项」，不得重复生成。
 *
 * 按业主确认的口径：只对**走过督办链路**的诉求生成——「无需交办归库」「误报归库」的诉求不纳入。
 *
 * POST /complaints/:idOrNo/corrections/generate
 */
export async function generateCorrections(idOrNo: ComplaintIdOrNo): Promise<CorrectionGenerateResult> {
  return request.post<never, CorrectionGenerateResult>(
    '/complaints/' + encode(idOrNo) + '/corrections/generate'
  );
}

/**
 * 确认/无需纠偏的响应形状（2026-09-17 端到端实测）：{ item: CorrectionItem }。
 * 调用方以**重新拉取**为准，不依赖响应体，这样形状变化不影响页面正确性。
 */
export interface CorrectionMutationResult {
  item: CorrectionItem;
  /**
   * 后端判定：本次处置后该诉求是否**已进入分析库**。
   * 2026-09-17 端到端实测确认存在该字段——所以「已进入分析库」的提示必须用它，
   * 不要在前端靠"数还有没有 pending 项"来推断。
   */
  analysisEntered?: boolean;
  analysisId?: string | null;
  analysisReason?: string | null;
  /** 是否已把纠偏后的取值回写到诉求主表 */
  writtenBack?: boolean;
}

/**
 * 确认一项纠偏：可同时给出新的取值与依据。后端记录确认人、时间与依据。
 *
 * POST /corrections/:correctionId/confirm
 */
export async function confirmCorrection(
  correctionId: string,
  body: CorrectionConfirmRequest
): Promise<CorrectionMutationResult> {
  return request.post<never, CorrectionMutationResult>(
    '/corrections/' + encode(correctionId) + '/confirm',
    body
  );
}

/**
 * 判定该项无需纠偏（例如自动生成的建议经核对不成立）。
 *
 * POST /corrections/:correctionId/reject
 */
export async function rejectCorrection(
  correctionId: string,
  body: CorrectionRejectRequest
): Promise<CorrectionMutationResult> {
  return request.post<never, CorrectionMutationResult>(
    '/corrections/' + encode(correctionId) + '/reject',
    body
  );
}

/**
 * 本系统办结：独立标记，**不得据此改写来源事件状态**。
 * 规格要求确认人/时间/依据三者缺一不可，所以 basis 必填。
 *
 * POST /complaints/:idOrNo/close
 */
export async function closeComplaint(
  idOrNo: ComplaintIdOrNo,
  body: CloseComplaintRequest
): Promise<CloseComplaintResult> {
  return request.post<never, CloseComplaintResult>(
    '/complaints/' + encode(idOrNo) + '/close',
    body
  );
}
