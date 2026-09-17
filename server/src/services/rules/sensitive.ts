// 敏感词判定：词条**从数据库 dict_item 读取**（dict_type = 'sensitive_word' 且 status = 'enabled'）。
// 硬约束：不得在代码里硬编码词表；词表为空时返回空命中并给出告警，绝不退化成内置数组。
// 词表变更不需要改代码、不需要发版。
import type { Queryable } from '../../repositories/complaintSourceLogRepo';

export interface SensitiveResult {
  isSensitive: boolean;
  keywords: string[];
  /** decimal(5,2)，保留 2 位 */
  confidence: number;
  ruleVersion: string;
  /** 词表缺失等可上报的异常，最终进入响应 warnings 与 complaint_source_log.message */
  warning: string | null;
}

/** 命中词表时的置信度；与旧实现保持一致，便于新旧数据可比 */
const CONFIDENCE_HIT = 0.88;
const CONFIDENCE_MISS = 0.72;

export const SENSITIVE_DICT_TYPE = 'sensitive_word';

/** 读取启用的敏感词表（按 id 稳定排序，保证同一文本多次判定结果一致） */
export async function loadSensitiveWords(db: Queryable): Promise<string[]> {
  const [rows] = await db.query(
    'select item_value from dict_item where dict_type = ? and status = ? order by id',
    [SENSITIVE_DICT_TYPE, 'enabled']
  );
  const list = (rows as Array<{ item_value?: unknown }>)
    .map((row) => (row.item_value === null || row.item_value === undefined ? '' : String(row.item_value).trim()))
    .filter((word) => word !== '');
  return Array.from(new Set(list));
}

export async function detectSensitive(db: Queryable, text: string): Promise<SensitiveResult> {
  const words = await loadSensitiveWords(db);
  const ruleVersion = SENSITIVE_DICT_TYPE + '/' + words.length;

  if (words.length === 0) {
    return {
      isSensitive: false,
      keywords: [],
      confidence: CONFIDENCE_MISS,
      ruleVersion,
      warning: 'dict_item 中没有启用的 sensitive_word 词条，本次按空词表判定',
    };
  }

  const keywords = words.filter((word) => text.includes(word));
  return {
    isSensitive: keywords.length > 0,
    keywords,
    confidence: keywords.length > 0 ? CONFIDENCE_HIT : CONFIDENCE_MISS,
    ruleVersion,
    warning: null,
  };
}
