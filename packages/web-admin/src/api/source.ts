import request from './request';
import type { ComplaintIdOrNo, SourceAdapterState, SourceSyncResult } from '../types/api';

/**
 * G6 来源对接（宜接就办只读状态适配器）。
 *
 * 适配器**默认关闭**，所以这两个接口的「正常」形态就是：
 *   * GET  /source-status                   -> enabled=false、batch="G6"、message 说明未接入
 *   * POST /complaints/:idOrNo/source-sync  -> HTTP 501 NOT_IMPLEMENTED（data.batch="G6"）
 *
 * 501 在这里是**设计如此，不是故障**：真实接口待对方提供，本平台不展示模拟的来源进度。
 * 因此调用方必须把 501 单独识别出来，显示「适配器未启用」，而不是当成泛化错误。
 */

/** 适配器当前状态。/source-status 返回它，UI 据此如实显示「未接入」。 */
export async function getSourceAdapterState(): Promise<SourceAdapterState> {
  return request.get<never, SourceAdapterState>('/source-status');
}

/**
 * 从来源适配器同步一次只读状态。
 * 适配器关闭时服务端返回 501（且只写 sync_log 留痕，不改任何业务状态）。
 */
export async function syncSource(idOrNo: ComplaintIdOrNo): Promise<SourceSyncResult> {
  return request.post<never, SourceSyncResult>(
    '/complaints/' + encodeURIComponent(String(idOrNo)) + '/source-sync'
  );
}
