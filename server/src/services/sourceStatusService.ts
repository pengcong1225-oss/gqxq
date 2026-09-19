// G6 来源对接：只读状态同步。
//
// 三条不可让步的规则：
//   1) 适配器未启用时**不写任何业务数据**，明确报 501，绝不返回模拟的来源进度。
//   2) 适配器调用失败时**不改变任何业务状态**（尤其不动 reporting_status 与 closed_in_system），只记 sync_log。
//   3) 来源状态认不出来时**保留原状态**并留痕，不猜。
import { AppError } from '../http/errors';
import { withTransaction } from '../db/tx';
import { labelOf } from '../domain/enums';
import { mapSourceStatusDetail, overtimeFlagName } from '../domain/sourceAdapter';
import { resolveSourceAdapter } from '../adapters';
import type { OvertimeFlag } from '../domain/sourceAdapter';
import type { SourceAdapterState, SourceSyncResult } from '../types/api';
import { findComplaintForSync, insertSyncLog, updateSourceEventStatus } from '../repositories/sourceSyncRepo';

export interface OperatorContext {
  userId: string | null;
  userName: string | null;
}

export async function getSourceAdapterState(): Promise<SourceAdapterState> {
  const resolution = resolveSourceAdapter();
  return {
    adapter: resolution.adapter.name,
    enabled: resolution.adapter.enabled,
    batch: resolution.adapter.enabled ? null : 'G6',
    message: resolution.message,
    misconfigured: resolution.misconfigured,
  };
}

function nameOf(code: string | null): string | null {
  return code === null ? null : labelOf('source_event_status', code);
}

export async function syncComplaintSource(
  idOrNo: string,
  _ctx: OperatorContext
): Promise<SourceSyncResult> {
  const complaint = await findComplaintForSync(idOrNo);
  if (!complaint) throw AppError.notFound('诉求不存在');

  const complaintId = complaint.complaint_id;
  const resolution = resolveSourceAdapter();

  // ---- 1) 未启用：只留痕，不改任何业务状态，明确报未实现 ----
  if (!resolution.adapter.enabled) {
    await withTransaction((tx) =>
      insertSyncLog(tx, {
        complaintId,
        result: 'skipped_disabled',
        requestBody: null,
        responseBody: null,
        errorMessage: resolution.message,
      })
    );
    throw AppError.notImplemented(
      '宜接就办来源适配器未启用（批次 G6）：真实接口待对方提供，本平台不展示模拟的来源进度',
      'G6'
    );
  }

  const sourceId = complaint.source_id;
  if (sourceId === null || sourceId.trim() === '') {
    throw AppError.validation('该诉求没有来源业务键，无法向来源系统查询状态', [
      { field: 'sourceId', message: '缺失' },
    ]);
  }

  // ---- 2) 调用适配器：失败只记日志，不动业务状态 ----
  let snapshot = null;
  try {
    snapshot = await resolution.adapter.fetchBySourceId(sourceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTransaction((tx) =>
      insertSyncLog(tx, {
        complaintId,
        result: 'failed',
        requestBody: JSON.stringify({ sourceId }),
        responseBody: null,
        errorMessage: message.slice(0, 2000),
      })
    );
    throw new AppError('SOURCE_ADAPTER_UNAVAILABLE', '来源适配器调用失败：' + message, { cause: err });
  }

  const now = new Date();

  // ---- 3) 来源没有该事件：正常情况，不改状态 ----
  if (snapshot === null) {
    await withTransaction((tx) =>
      insertSyncLog(tx, {
        complaintId,
        result: 'not_found',
        requestBody: JSON.stringify({ sourceId }),
        responseBody: null,
        errorMessage: '来源系统没有该事件',
      })
    );
    return {
      complaintId,
      synced: true,
      adapterEnabled: true,
      rawStatus: null,
      sourceEventStatusCode: complaint.source_event_status,
      sourceEventStatusName: nameOf(complaint.source_event_status),
      // 来源这次没给任何原文，时效维度**不表态**（null ≠ "无时效信息"这个标签，而是"本次没结论"）
      overtimeFlag: null,
      overtimeFlagName: null,
      updated: false,
      message: '来源系统没有该事件，来源状态保持原值',
      syncedAt: null,
    };
  }

  // ---- 4) 状态认不出来：保留原状态**与原时效标记**并留痕，不猜 ----
  const mapping = mapSourceStatusDetail(snapshot.rawStatus);
  if (mapping === null) {
    await withTransaction((tx) =>
      insertSyncLog(tx, {
        complaintId,
        result: 'unmapped',
        requestBody: JSON.stringify({ sourceId }),
        responseBody: JSON.stringify(snapshot.raw),
        errorMessage: '来源状态「' + snapshot.rawStatus + '」无法映射到已知状态，已保留原状态',
      })
    );
    return {
      complaintId,
      synced: true,
      adapterEnabled: true,
      rawStatus: snapshot.rawStatus,
      sourceEventStatusCode: complaint.source_event_status,
      sourceEventStatusName: nameOf(complaint.source_event_status),
      // 原文认不出 -> 时效维度同样没有结论；**不写库**，所以也不谎报"无时效信息"
      overtimeFlag: null,
      overtimeFlagName: null,
      updated: false,
      message: '来源状态「' + snapshot.rawStatus + '」无法映射，已保留原状态并留痕',
      syncedAt: null,
    };
  }

  // ---- 5) 正常更新：只写 source_event_status / overtime_flag / source_synced_at 三列 ----
  // 这里**不按"状态没变"短路**：状态轴没动而时效轴从 NULL 变 1（正常结案 -> 超期结案）
  // 是真实变化，短路会把这次更正丢掉。见 sourceSyncRepo.updateSourceEventStatus 的注释。
  const overtimeFlag: OvertimeFlag = mapping.overtimeFlag;
  await withTransaction(async (tx) => {
    await updateSourceEventStatus(tx, complaintId, mapping.code, overtimeFlag, now);
    await insertSyncLog(tx, {
      complaintId,
      result: 'success',
      requestBody: JSON.stringify({ sourceId }),
      responseBody: JSON.stringify(snapshot.raw),
      errorMessage: null,
    });
  });

  return {
    complaintId,
    synced: true,
    adapterEnabled: true,
    rawStatus: snapshot.rawStatus,
    sourceEventStatusCode: mapping.code,
    sourceEventStatusName: nameOf(mapping.code),
    overtimeFlag,
    overtimeFlagName: overtimeFlagName(overtimeFlag),
    updated: true,
    message: null,
    syncedAt: now.toISOString(),
  };
}
