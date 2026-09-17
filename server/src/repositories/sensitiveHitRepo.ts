// sensitive_hit（追加写）：敏感词命中证据。
//
// 设计要点（落地计划 G2 任务 2「敏感识别可追溯」）：
//   * 词条真源是 dict_item（dict_type='sensitive_word'），命中证据逐条落在本表，
//     记录 keyword 与 dict_item_id，因此词表换版后仍能回查"当时命中的是哪一条词条"；
//   * matched_field 记录命中发生在 title/content/address 哪个字段，matched_text 保存命中处原文（截断 500）；
//   * 本表只 insert，不 update、不 delete（与 complaint_source_log / complaint_field_version 同一纪律）。
import type { Queryable } from './complaintSourceLogRepo';
import { cut } from './complaintSourceLogRepo';

/** 敏感词条真源：dict_item 的 item_id 与 item_value */
export interface SensitiveWordItem {
  itemId: string;
  keyword: string;
}

export const SENSITIVE_WORD_DICT_TYPE = 'sensitive_word';

/** 参与判定的字段（与 rules/classify.ts 的 buildRuleText 同一批） */
export type MatchedField = 'title' | 'content' | 'address';

export interface HitField {
  field: MatchedField;
  text: string | null;
}

export interface SensitiveHitInput {
  complaintId: string;
  /** 与 complaint.rule_version 的敏感词部分同源 */
  ruleVersion: string | null;
  matchedAt: Date;
  fields: HitField[];
}

/** 读取启用的敏感词条（含 item_id）。按 id 稳定排序，保证同一文本多次判定顺序一致。 */
export async function loadSensitiveWordItems(db: Queryable): Promise<SensitiveWordItem[]> {
  const [rows] = await db.query(
    'select item_id, item_value from dict_item where dict_type = ? and status = ? order by id',
    [SENSITIVE_WORD_DICT_TYPE, 'enabled']
  );
  const list: SensitiveWordItem[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<{ item_id?: unknown; item_value?: unknown }>) {
    const keyword = row.item_value === null || row.item_value === undefined ? '' : String(row.item_value).trim();
    if (keyword === '' || seen.has(keyword)) continue;
    seen.add(keyword);
    list.push({ itemId: String(row.item_id ?? ''), keyword });
  }
  return list;
}

/**
 * 逐条写入命中证据：同一词条命中多个字段会各记一行（证据粒度到字段）。
 * 返回实际写入的行数；未命中或词表为空时返回 0（不写空行、不造假）。
 *
 * 注意：本表没有唯一键，重复调用会产生重复行。调用方必须只在"规则判定确实发生/关键词确实变化"时调用，
 * 不要在每个请求路径上无脑调用。
 */
export async function recordSensitiveHits(db: Queryable, input: SensitiveHitInput): Promise<number> {
  const items = await loadSensitiveWordItems(db);
  if (items.length === 0) return 0;

  const rows: unknown[][] = [];
  for (const field of input.fields) {
    const text = field.text;
    if (text === null || text === undefined || text === '') continue;
    for (const item of items) {
      if (!text.includes(item.keyword)) continue;
      rows.push([
        cut(input.complaintId, 64),
        cut(item.keyword, 128),
        cut(item.itemId === '' ? null : item.itemId, 64),
        field.field,
        cut(text, 500),
        cut(input.ruleVersion, 32),
        input.matchedAt,
      ]);
    }
  }
  if (rows.length === 0) return 0;

  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
  await db.query(
    'insert into sensitive_hit ' +
      '(complaint_id, keyword, dict_item_id, matched_field, matched_text, rule_version, created_at) values ' +
      placeholders,
    rows.flat()
  );
  return rows.length;
}

export interface SensitiveHitRow {
  keyword: string;
  dictItemId: string | null;
  matchedField: string | null;
  matchedText: string | null;
  ruleVersion: string | null;
  createdAt: unknown;
}

/** 按诉求回查命中证据（详情/审计用；按时间与主键稳定排序） */
export async function listHitsByComplaint(db: Queryable, complaintId: string): Promise<SensitiveHitRow[]> {
  const [rows] = await db.query(
    'select keyword, dict_item_id as dictItemId, matched_field as matchedField,' +
      ' matched_text as matchedText, rule_version as ruleVersion, created_at as createdAt' +
      ' from sensitive_hit where complaint_id = ? order by created_at asc, id asc',
    [complaintId]
  );
  return rows as unknown as SensitiveHitRow[];
}
