import request from './request';
import type {
  CloseComplaintRequest,
  CloseComplaintResult,
  ComplaintIdOrNo,
  CorrectionBatchResult,
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

/** 交办轴筛选：dispatched=只看交办过的，undispatched=只看没交办过的，不传=全部 */
export type DispatchedFilter = 'dispatched' | 'undispatched';

export interface PendingCorrectionParams {
  page?: number;
  size?: number;
  /** 只看某个诉求的待纠偏项 */
  complaintId?: string;
  /** 只看某条交办轴上的诉求 */
  dispatched?: DispatchedFilter;
}

function encode(value: ComplaintIdOrNo): string {
  return encodeURIComponent(String(value));
}

/**
 * 待纠偏队列（服务端分页）。返回的是**逐字段**的纠偏项，不是"诉求列表"——
 * 一个诉求可能同时有多项待纠偏（企业名称/地址/分类/坐标/摘要/企业处置结果）。
 *
 * 口径（业主 2026-09-20 裁定）：纠偏覆盖**所有**诉求，与是否交办、是否审批通过无关；
 * 每条项带 hasDispatch 标记，用于区分"纠偏轴 × 交办轴"的交叉状态。
 *
 * GET /corrections/pending
 */
export async function listPendingCorrections(
  params: PendingCorrectionParams = {}
): Promise<Paged<CorrectionItem>> {
  return request.get<never, Paged<CorrectionItem>>('/corrections/pending', {
    params: {
      page: params.page,
      size: params.size,
      complaintId: params.complaintId,
      dispatched: params.dispatched,
    },
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
 * 为单条诉求生成纠偏待办（幂等，可手工补生成）。
 *
 * 口径（业主 2026-09-20 裁定）：**只要是诉求就能纠偏**——不再有"必须审批通过""必须有交办单"两道前置，
 * 没交办过的诉求 assignmentId 为 null，一样进队列。G4 回调只是三个入口之一。
 *
 * **幂等**：已有纠偏项时后端返回 created=false 并带上既有的 items，
 * 调用方必须据此提示「该诉求已有纠偏项」，不得重复生成。
 *
 * POST /complaints/:idOrNo/corrections/generate
 */
export async function generateCorrections(idOrNo: ComplaintIdOrNo): Promise<CorrectionGenerateResult> {
  return request.post<never, CorrectionGenerateResult>(
    '/complaints/' + encode(idOrNo) + '/corrections/generate'
  );
}

/**
 * 批量补挂：给所有还没有纠偏清单的诉求生成待办（幂等，可反复执行）。
 * 存量 464 条与新入站尚未被覆盖的诉求都靠这个入口收敛进纠偏口径。
 *
 * 调用方**必须看 uncoveredComplaints 与 errors**：不为 0 / 非空就是没补全，不能当成功收口。
 *
 * POST /corrections/generate-batch
 */
export async function generateCorrectionBatch(): Promise<CorrectionBatchResult> {
  return request.post<never, CorrectionBatchResult>('/corrections/generate-batch');
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
