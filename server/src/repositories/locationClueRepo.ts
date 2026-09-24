import type { Queryable } from './complaintSourceLogRepo';
import { addressInputHash, type AddressInput } from '../services/rules/addressExtract';
import { extractLocation, type ExtractedLocationClue } from '../services/rules/locationExtract';

export interface LocationClueRow extends ExtractedLocationClue {
  inputHash: string;
}

export type LocationSyncResult = 'created' | 'updated' | 'unchanged' | 'removed' | 'none';

interface LocationClueDbRow extends Record<string, unknown> {
  kind: unknown;
  value: unknown;
  evidence: unknown;
  sourceField: unknown;
  start: unknown;
  end: unknown;
  townshipCode: unknown;
  districtCode: unknown;
  parentMatch: unknown;
  extractorVersion: unknown;
  snapshotId: unknown;
  inputHash: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapLocationClue(row: LocationClueDbRow): LocationClueRow {
  return {
    kind: String(row.kind) as ExtractedLocationClue['kind'],
    value: String(row.value),
    evidence: String(row.evidence),
    sourceField: String(row.sourceField) as ExtractedLocationClue['sourceField'],
    start: Number(row.start),
    end: Number(row.end),
    townshipCode: nullableString(row.townshipCode),
    districtCode: nullableString(row.districtCode),
    parentMatch: String(row.parentMatch) as ExtractedLocationClue['parentMatch'],
    extractorVersion: String(row.extractorVersion),
    snapshotId: String(row.snapshotId),
    inputHash: String(row.inputHash),
  };
}

export async function findLocationClues(db: Queryable, complaintId: string): Promise<LocationClueRow[]> {
  const [rows] = await db.query(
    'select clue_kind as kind, clue_value as value, evidence_text as evidence, source_field as sourceField,' +
      ' source_start as start, source_end as end, township_code as townshipCode, district_code as districtCode,' +
      ' parent_match as parentMatch, extractor_version as extractorVersion, snapshot_id as snapshotId, input_hash as inputHash' +
      ' from complaint_location_clue where complaint_id = ? order by id asc',
    [complaintId]
  );
  return (rows as LocationClueDbRow[]).map(mapLocationClue);
}

function sameMachineSet(before: LocationClueRow[], next: ExtractedLocationClue[], inputHash: string): boolean {
  return before.length === next.length && before.every((stored, index) => {
    const candidate = next[index];
    return stored.inputHash === inputHash && stored.kind === candidate.kind && stored.value === candidate.value &&
      stored.evidence === candidate.evidence && stored.sourceField === candidate.sourceField && stored.start === candidate.start &&
      stored.end === candidate.end && stored.townshipCode === candidate.townshipCode &&
      stored.districtCode === candidate.districtCode && stored.parentMatch === candidate.parentMatch &&
      stored.extractorVersion === candidate.extractorVersion && stored.snapshotId === candidate.snapshotId;
  });
}

export function classifyLocationClueChange(
  before: LocationClueRow[], next: ExtractedLocationClue[], inputHash: string
): LocationSyncResult {
  if (!before.length && !next.length) return 'none';
  if (sameMachineSet(before, next, inputHash)) return 'unchanged';
  if (!before.length) return 'created';
  if (!next.length) return 'removed';
  return 'updated';
}

async function insertMachineClue(
  db: Queryable,
  complaintId: string,
  clue: ExtractedLocationClue,
  inputHash: string
): Promise<void> {
  await db.execute(
    'insert into complaint_location_clue ' +
      '(complaint_id, clue_kind, clue_value, evidence_text, source_field, source_start, source_end, township_code,' +
      ' district_code, parent_match, extractor_version, snapshot_id, input_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [complaintId, clue.kind, clue.value, clue.evidence, clue.sourceField, clue.start, clue.end, clue.townshipCode,
      clue.districtCode, clue.parentMatch, clue.extractorVersion, clue.snapshotId, inputHash]
  );
}

export async function syncLocationClues(
  db: Queryable,
  complaintId: string,
  input: AddressInput
): Promise<LocationSyncResult> {
  const next = extractLocation(input).clues;
  const inputHash = addressInputHash(input);
  const before = await findLocationClues(db, complaintId);
  const change = classifyLocationClueChange(before, next, inputHash);
  if (change === 'none' || change === 'unchanged') return change;
  await db.execute('delete from complaint_location_clue where complaint_id = ?', [complaintId]);
  for (const clue of next) await insertMachineClue(db, complaintId, clue, inputHash);
  return change;
}
