// G6 来源对接：宜接就办只读状态适配器的**契约**。
//
// 设计立场（落地计划 G6）：
//   * 本批次只定义契约与禁用开关，**不实现投机性的 HTTP 客户端**——真实接口尚未提供，
//     照猜测写一个客户端只会在联调时全部作废，还会诱导人以为"已经对接了"。
//   * 适配器未启用时，source_event_status 必须保持 unknown，UI 显示"未接入"，
//     绝不展示任何模拟的来源进度。
//   * 适配器失败**不得**改变填报结果（reporting_status）或本系统办结（closed_in_system）。

/** 与 domain/enums.ts 的 source_event_status 完全一致 */
export type SourceEventStatusCode = 'unknown' | 'accepted' | 'processing' | 'completed' | 'closed';

/**
 * 来源系统状态 -> 我们的状态枚举。
 *
 * 认不出来的**返回 null 而不是猜**：把未知状态映射成某个已知状态，
 * 等于用编造的信息覆盖真实状态。调用方拿到 null 时应保留原状态并记日志。
 */
const SOURCE_STATUS_MAP: Record<string, SourceEventStatusCode> = {
  ACCEPTED: 'accepted',
  ASSIGNED: 'accepted',
  RECEIVED: 'accepted',
  PROCESSING: 'processing',
  HANDLING: 'processing',
  IN_PROGRESS: 'processing',
  COMPLETED: 'completed',
  FINISHED: 'completed',
  DONE: 'completed',
  CLOSED: 'closed',
};

export function mapSourceStatus(rawStatus: string): SourceEventStatusCode | null {
  const key = rawStatus.trim().toUpperCase();
  if (key === '') return null;
  return SOURCE_STATUS_MAP[key] ?? null;
}

/** 适配器返回的一条来源状态快照 */
export interface SourceStatusSnapshot {
  /** 来源系统业务主键 */
  sourceId: string;
  /** 来源系统给的原始状态字符串，原样留痕，不加工 */
  rawStatus: string;
  /** 来源系统声明的时间，可能没有 */
  updatedAt: string | null;
  /** 原文，便于追溯 */
  raw: Record<string, unknown>;
}

export interface SourceStatusAdapter {
  readonly name: string;
  /** 关闭时不发起任何外部调用，调用即 501 */
  readonly enabled: boolean;
  /** 返回 null 表示来源系统没有该事件（正常情况，不是错误） */
  fetchBySourceId(sourceId: string): Promise<SourceStatusSnapshot | null>;
}
