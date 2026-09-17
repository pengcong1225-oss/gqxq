// 枚举唯一真源（**小写**，与 gqxq_service 现有数据一致）。
// 约定来源：docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md §3.2。
// 字典的可展示标签优先从数据库 dict_type/dict_item 读取（见 repositories/dictRepo.ts），
// 本文件同时作为「校验用合法集合」与「数据库不可用时的标签兜底」。

export const DICT = {
  business_type: { water: '供水', gas: '燃气', lpg: '液化气' },
  complaint_type: {
    complaint: '投诉',
    consult: '咨询',
    suggest: '建议',
    report: '举报',
  },
  urgency_level: { normal: '一般', urgent: '紧急', critical: '特急' },
  correction_status: {
    none: '无需纠偏',
    pending: '待纠偏',
    corrected: '已纠偏',
    failed: '纠偏失败',
  },
  source_event_status: {
    unknown: '未接入',
    accepted: '已受理',
    processing: '处置中',
    completed: '来源已办结',
    closed: '来源已关闭',
  },
  // 督办交办状态：与 G2 的 dispatch_order 生成列「进行中」集合必须逐字一致
  supervision_status: {
    none: '未交办',
    pending_match: '待匹配单位',
    pending: '待推送',
    pushed: '已推送待签收',
    accepted: '企业已签收',
    processing: '企业办理中',
    returned: '审批退回待补正',
    completed: '填报审批最终通过',
    rejected: '审批不同意',
    archived: '已归档',
    cancelled: '已受控撤销',
  },
  reporting_status: {
    not_started: '未推送',
    pushed: '已推送',
    accepted: '企业已签收',
    submitted: '企业已提交',
    returned: '退回补正',
    approved: '最终同意',
    rejected: '审批不同意',
  },
  /** 交办类型与触发类型：此前只有码没有中文名，前端只能显示 auto/sensitive_word */
  dispatch_type: { auto: '自动交办', manual: '人工交办' },
  trigger_type: { sensitive_word: '敏感词命中', manual_flag: '人工标记' },
  intake_result: {
    created: '已接收',
    duplicate_same: '重复投递',
    updated: '重传覆盖',
    rejected: '报文被拒',
  },
} as const;

export type DictCode = keyof typeof DICT;

/**
 * 督办状态里代表「进行中」的集合。
 * 硬约束：必须与 G2 给 dispatch_order 加的唯一约束生成列里的集合逐字一致，
 * 否则「一个诉求同一轮只能有一条有效交办」会失效。
 */
export const ACTIVE_SUPERVISION_STATUSES = [
  'pending',
  'pushed',
  'accepted',
  'processing',
  'returned',
] as const;

export const TERMINAL_SUPERVISION_STATUSES = [
  'completed',
  'rejected',
  'archived',
  'cancelled',
] as const;

/** 外部重传可覆盖的来源快照列（其余列一律受保护，见迁移设计 §4.6 与 intakeService） */
export const REDELIVERY_OVERWRITABLE_FIELDS = [
  'title',
  'content',
  'source_channel',
  'address',
  'district_code',
  'district_name',
  'location_lng',
  'location_lat',
] as const;

/** 人工/业务结论：外部重传**不得**覆盖 */
export const MANUAL_PROTECTED_FIELDS = [
  'enterprise_code',
  'enterprise_name',
  'corrected_address',
  'correction_status',
  'supervision_status',
  'reporting_status',
  'source_event_status',
  'closed_in_system',
  'analysis_included',
] as const;

export function isValidCode(dict: DictCode, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICT[dict], code);
}

export function labelOf(dict: DictCode, code: string | null | undefined): string {
  if (!code) return '';
  const table = DICT[dict] as Record<string, string>;
  return table[code] ?? code;
}
