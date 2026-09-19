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
 * 「超期时效」派生标记（complaint.overtime_flag，M11）。三态，**NULL 不等于 0**：
 *   null = 来源没有给出时效信息（未同步 / 正常在办 / 认不出 / 历史未回填）
 *   0    = 来源明确「未超期」
 *   1    = 来源明确「超期」
 */
export type OvertimeFlag = 0 | 1 | null;

/**
 * 把库里的原始值收敛成三态。认不出（含 null / 意外取值）一律回 null = "无时效信息"，
 * 不猜成 0——0 是一句肯定的业务结论（"来源明确说没超期"）。
 */
export function toOvertimeFlag(v: unknown): OvertimeFlag {
  if (v === 1 || v === '1' || v === true) return 1;
  if (v === 0 || v === '0' || v === false) return 0;
  return null;
}

/** 三态标签（对外与 /complaints 的 *Name 约定一致：前端不自建翻译表，三态都有服务端文案） */
export function overtimeFlagName(flag: OvertimeFlag): string {
  if (flag === 1) return '超期';
  if (flag === 0) return '未超期';
  return '无时效信息';
}

/** 一条来源状态的映射结果：**状态轴 + 时效轴**两个维度，彼此独立 */
export interface SourceStatusMapping {
  code: SourceEventStatusCode;
  overtimeFlag: OvertimeFlag;
}

/**
 * 来源系统状态 -> 我们的（状态码, 时效标记）。
 *
 * 认不出来的**返回 null 而不是猜**：把未知状态映射成某个已知状态，
 * 等于用编造的信息覆盖真实状态。调用方拿到 null 时应保留原状态并记日志。
 *
 * 时效维度同理：来源没说的就是 null，**不因"没提超期"就断言未超期**。
 * 只有快照里明确写了「正常结案 / 超期结案」这类带时效口径的取值才落 0 / 1。
 */
const SOURCE_STATUS_MAP: Record<string, SourceStatusMapping> = {
  // 英文/通用码位：真实接口尚未提供，这些取值只带状态、**不带时效**，故 overtimeFlag 全为 null。
  ACCEPTED: { code: 'accepted', overtimeFlag: null },
  ASSIGNED: { code: 'accepted', overtimeFlag: null },
  RECEIVED: { code: 'accepted', overtimeFlag: null },
  PROCESSING: { code: 'processing', overtimeFlag: null },
  HANDLING: { code: 'processing', overtimeFlag: null },
  IN_PROGRESS: { code: 'processing', overtimeFlag: null },
  COMPLETED: { code: 'completed', overtimeFlag: null },
  FINISHED: { code: 'completed', overtimeFlag: null },
  DONE: { code: 'completed', overtimeFlag: null },
  CLOSED: { code: 'closed', overtimeFlag: null },
  // 宜接就办**导出快照**的中文口径（GQXQ_YJJB_ADAPTER=file，见 adapters/fileSourceAdapter.ts）。
  // 「超期结案」映射为 completed：超期是**时效**维度、不是状态维度，由 overtimeFlag 单独承载（D20）。
  // 原文仍原样保留在 SourceStatusSnapshot.rawStatus 与 sync_log.response_body 里，事实不丢。
  '正常在办': { code: 'processing', overtimeFlag: null },
  '正常结案': { code: 'completed', overtimeFlag: 0 },
  '超期结案': { code: 'completed', overtimeFlag: 1 },
};

/**
 * 完整映射（状态 + 时效）。同步落库走这个函数。
 * 返回 null 表示认不出——调用方保留原状态**并保留原时效标记**，绝不猜。
 */
export function mapSourceStatusDetail(rawStatus: string): SourceStatusMapping | null {
  const key = rawStatus.trim().toUpperCase();
  if (key === '') return null;
  return SOURCE_STATUS_MAP[key] ?? null;
}

/**
 * 只要状态码（G6-1 契约既有形态，保持不变）。
 * 需要时效标记的调用方请用 mapSourceStatusDetail，别在这里"顺带推断"。
 */
export function mapSourceStatus(rawStatus: string): SourceEventStatusCode | null {
  return mapSourceStatusDetail(rawStatus)?.code ?? null;
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
