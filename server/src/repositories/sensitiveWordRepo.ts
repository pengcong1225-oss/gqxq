import type { Queryable } from './complaintSourceLogRepo';
import { parseKeywords, toBool, toStr } from './complaintMapper';

export type SensitiveWordStatus = 'enabled' | 'disabled';

export interface ManagedSensitiveWordRow {
  itemId: string;
  word: string;
  label: string;
  status: SensitiveWordStatus;
  hitCount: number;
}

function toManaged(row: Record<string, unknown>): ManagedSensitiveWordRow {
  return {
    itemId: String(row.itemId),
    word: String(row.word),
    label: String(row.label ?? row.word),
    status: row.status === 'disabled' ? 'disabled' : 'enabled',
    hitCount: Number(row.hitCount ?? 0),
  };
}

export async function listSensitiveWordRows(db: Queryable): Promise<ManagedSensitiveWordRow[]> {
  const [rows] = await db.query(
    'select d.item_id as itemId, d.item_value as word, d.item_label as label, d.status,' +
      ' count(h.id) as hitCount' +
      ' from dict_item d left join sensitive_hit h on h.dict_item_id = d.item_id' +
      " where d.dict_type = 'sensitive_word'" +
      ' group by d.id, d.item_id, d.item_value, d.item_label, d.status order by d.id asc'
  );
  return (rows as Array<Record<string, unknown>>).map(toManaged);
}

export async function findSensitiveWordById(
  db: Queryable,
  itemId: string,
  lock = false
): Promise<ManagedSensitiveWordRow | null> {
  const [rows] = await db.query(
    'select d.item_id as itemId, d.item_value as word, d.item_label as label, d.status,' +
      ' (select count(*) from sensitive_hit h where h.dict_item_id = d.item_id) as hitCount' +
      " from dict_item d where d.dict_type = 'sensitive_word' and d.item_id = ? limit 1" +
      (lock ? ' for update' : ''),
    [itemId]
  );
  const list = rows as Array<Record<string, unknown>>;
  return list.length === 0 ? null : toManaged(list[0]);
}

export async function findSensitiveWordByValue(
  db: Queryable,
  word: string,
  lock = false
): Promise<ManagedSensitiveWordRow | null> {
  const [rows] = await db.query(
    'select d.item_id as itemId, d.item_value as word, d.item_label as label, d.status,' +
      ' (select count(*) from sensitive_hit h where h.dict_item_id = d.item_id) as hitCount' +
      " from dict_item d where d.dict_type = 'sensitive_word' and d.item_value = ? limit 1" +
      (lock ? ' for update' : ''),
    [word]
  );
  const list = rows as Array<Record<string, unknown>>;
  return list.length === 0 ? null : toManaged(list[0]);
}

export async function countEnabledSensitiveWords(db: Queryable): Promise<number> {
  const [rows] = await db.query(
    "select count(*) as n from dict_item where dict_type = 'sensitive_word' and status = 'enabled'"
  );
  return Number((rows as Array<{ n?: unknown }>)[0]?.n ?? 0);
}

/** 串行化词表变更与确认重扫，避免并发停用把有效词条同时降为 0。 */
export async function lockSensitiveWordSet(db: Queryable): Promise<void> {
  await db.query(
    "select item_id from dict_item where dict_type = 'sensitive_word' order by id for update"
  );
}

export async function insertSensitiveWordRow(
  db: Queryable,
  input: { itemId: string; word: string }
): Promise<void> {
  await db.execute(
    'insert into dict_item (item_id, dict_type, item_value, item_label, status) ' +
      "values (?, 'sensitive_word', ?, ?, 'enabled')",
    [input.itemId, input.word, input.word]
  );
}

export async function updateSensitiveWordRow(
  db: Queryable,
  itemId: string,
  input: { word: string; status: SensitiveWordStatus }
): Promise<void> {
  await db.execute(
    "update dict_item set item_value = ?, item_label = ?, status = ? where dict_type = 'sensitive_word' and item_id = ?",
    [input.word, input.word, input.status, itemId]
  );
}

export interface SensitiveRescanComplaintRow {
  complaintId: string;
  title: string | null;
  content: string | null;
  address: string | null;
  isSensitive: boolean;
  sensitiveKeywords: string[];
  ruleConfidence: number | null;
  ruleVersion: string | null;
}

export async function listSensitiveRescanComplaintRows(
  db: Queryable,
  lock = false
): Promise<SensitiveRescanComplaintRow[]> {
  const [rows] = await db.query(
    'select complaint_id as complaintId, title, content, address,' +
      ' is_sensitive as isSensitive, sensitive_keywords as sensitiveKeywords,' +
      ' rule_confidence as ruleConfidence, rule_version as ruleVersion' +
      ' from complaint where coalesce(deleted, 0) = 0 order by id asc' +
      (lock ? ' for update' : '')
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    complaintId: String(row.complaintId),
    title: toStr(row.title),
    content: toStr(row.content),
    address: toStr(row.address),
    isSensitive: toBool(row.isSensitive),
    sensitiveKeywords: parseKeywords(row.sensitiveKeywords),
    ruleConfidence:
      row.ruleConfidence === null || row.ruleConfidence === undefined
        ? null
        : Number(row.ruleConfidence),
    ruleVersion: toStr(row.ruleVersion),
  }));
}

export async function updateComplaintSensitiveResult(
  db: Queryable,
  input: {
    complaintId: string;
    isSensitive: boolean;
    keywords: string | null;
    confidence: number;
    ruleVersion: string;
    updatedAt: Date;
  }
): Promise<void> {
  await db.execute(
    'update complaint set is_sensitive = ?, sensitive_keywords = ?, rule_confidence = ?,' +
      ' rule_version = ?, updated_at = ? where complaint_id = ?',
    [
      input.isSensitive ? 1 : 0,
      input.keywords,
      input.confidence,
      input.ruleVersion,
      input.updatedAt,
      input.complaintId,
    ]
  );
}
