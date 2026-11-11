import type { Tx } from '../db/tx';
import { EFFECTIVE_COLUMNS, parseFieldState, type EffectiveFieldState } from '../domain/effectiveFieldPolicy';
import { protectedColumnsForCorrection } from './correctionRepo';

/** Lazy legacy inference under the complaint lock; never manufacture historical source values. */
export async function loadEffectiveFieldState(tx: Tx, row: Record<string, unknown>): Promise<EffectiveFieldState> {
  const states = parseFieldState(row.effective_field_state);
  const knownColumns = new Set(Object.keys(states));
  if (EFFECTIVE_COLUMNS.every(column => states[column])) return states;
  const [corrections] = await tx.query(
    'select field_name as fieldName, status, correction_id as correctionId, new_value as newValue' +
    ' from correction_item where complaint_id = ? order by id asc', [row.complaint_id]
  );
  const [versions] = await tx.query(
    "select field_name as fieldName, new_value as newValue, change_source as changeSource from complaint_field_version" +
    " where complaint_id = ? and change_source = 'manual_edit' order by id asc", [row.complaint_id]
  );
  for (const column of EFFECTIVE_COLUMNS) {
    if (!states[column]) states[column] = { resolution: 'needs_verification', value: row[column] ?? null, version: null,
      reason: '历史保护状态或决定时有效值未证实，保留当前值待核验' };
  }
  for (const correction of corrections as Array<Record<string, unknown>>) {
    if (correction.status !== 'confirmed' && correction.status !== 'rejected') continue;
    for (const column of protectedColumnsForCorrection(String(correction.fieldName))) {
      if (knownColumns.has(column)) continue;
      // Rejected records only carry the initial old_value, not the value at decision time.
      const proven = correction.status === 'confirmed' && correction.newValue != null &&
        String(correction.newValue) === String(row[column]);
      states[column] = { resolution: proven ? 'confirmed' : 'needs_verification', value: row[column] ?? null,
        version: null, correctionId: String(correction.correctionId),
        reason: proven ? '既有确认记录与当前有效值一致' : '既有人工处置存在，历史决定值未完整证实，待核验' };
    }
  }
  const latestVersions = new Map<string, Record<string, unknown>>();
  for (const version of versions as Array<Record<string, unknown>>) latestVersions.set(String(version.fieldName), version);
  for (const version of latestVersions.values()) {
    const column = String(version.fieldName);
    if (knownColumns.has(column)) continue;
    if (states[column]) {
      const matches = String(version.newValue) === String(row[column]);
      states[column] = { resolution: matches ? 'confirmed' : 'needs_verification', value: row[column] ?? null, version: null,
        reason: matches ? '最近人工字段版本与当前值一致' : '最近人工版本与当前值不一致，保留当前值待核验' };
    }
  }
  return states;
}
