// complaint_field_version（追加写）：字段级旧值/新值留痕。
// 用于三处：外部重传覆盖来源快照、重传试图改写受保护字段被拒、人工/规则变更。
import { randomUUID } from 'node:crypto';
import type { Queryable } from './complaintSourceLogRepo';
import { cut } from './complaintSourceLogRepo';

export type ChangeSource = 'external_redelivery' | 'manual_edit' | 'rule_engine' | 'data_repair';

export interface FieldVersionEntry {
  complaintId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeSource: ChangeSource;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  changedAt: Date;
}

/** 把任意值转成留痕用的文本；对象/数组用规范化 JSON，避免出现 "[object Object]" */
export function toFieldText(value: unknown, canonicalJson: (v: unknown) => string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return canonicalJson(value);
  return String(value);
}

export async function insertFieldVersions(db: Queryable, entries: FieldVersionEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  for (const entry of entries) {
    await db.execute(
      'insert into complaint_field_version ' +
        '(version_id, complaint_id, field_name, old_value, new_value, change_source, reason, operator_id, operator_name, changed_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'CFV-' + randomUUID(),
        cut(entry.complaintId, 64),
        cut(entry.fieldName, 64),
        entry.oldValue,
        entry.newValue,
        entry.changeSource,
        cut(entry.reason, 500),
        cut(entry.operatorId, 64),
        cut(entry.operatorName, 64),
        entry.changedAt,
      ]
    );
  }
  return entries.length;
}
