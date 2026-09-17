// 规则引擎：业务类型 / 诉求类型 / 紧急程度。
// 纯函数、无 I/O，便于单独验证与复用（口径来自落地计划 §5 G2 任务 2 的历史实现）。
// 返回值一律是 domain/enums.ts 里的小写码。

export type BusinessType = 'water' | 'gas' | 'lpg';
export type ComplaintType = 'complaint' | 'consult' | 'suggest' | 'report';
export type UrgencyLevel = 'normal' | 'urgent' | 'critical';

export interface Classification {
  businessType: BusinessType;
  complaintType: ComplaintType;
  urgencyLevel: UrgencyLevel;
  /** 命中的关键词（仅用于可解释性，不落库） */
  matched: string[];
  ruleVersion: string;
}

// 会与敏感词表版本拼进 complaint.rule_version（varchar(32)），必须保持短：'classify.v1+dict/3'
export const CLASSIFY_RULE_VERSION = 'classify.v1';

const LPG = /液化气|钢瓶|瓶装气/;
const GAS = /燃气|天然气|漏气|气压|停气/;

const REPORT = /举报|违法|偷水|盗气/;
const CONSULT = /咨询|请问|如何|查询/;
const SUGGEST = /建议|希望|优化/;

const CRITICAL = /爆炸|泄漏|中毒|大面积停|伤亡|群体/;
const URGENT = /爆管|断裂|污染|火灾|安全隐患/;

/** 参与判定的文本：标题 + 正文 + 地址，空值不参与拼接（避免出现 "null"） */
export function buildRuleText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ');
}

export function classify(text: string): Classification {
  const matched: string[] = [];

  let businessType: BusinessType = 'water';
  if (LPG.test(text)) {
    businessType = 'lpg';
    matched.push('business_type:lpg');
  } else if (GAS.test(text)) {
    businessType = 'gas';
    matched.push('business_type:gas');
  }

  let complaintType: ComplaintType = 'complaint';
  if (REPORT.test(text)) {
    complaintType = 'report';
    matched.push('complaint_type:report');
  } else if (CONSULT.test(text)) {
    complaintType = 'consult';
    matched.push('complaint_type:consult');
  } else if (SUGGEST.test(text)) {
    complaintType = 'suggest';
    matched.push('complaint_type:suggest');
  }

  let urgencyLevel: UrgencyLevel = 'normal';
  if (CRITICAL.test(text)) {
    urgencyLevel = 'critical';
    matched.push('urgency_level:critical');
  } else if (URGENT.test(text)) {
    urgencyLevel = 'urgent';
    matched.push('urgency_level:urgent');
  }

  return { businessType, complaintType, urgencyLevel, matched, ruleVersion: CLASSIFY_RULE_VERSION };
}
