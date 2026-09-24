import type { Queryable } from './complaintSourceLogRepo';
import { addressInputHash, extractAddressCandidate, type ExtractedAddressCandidate } from '../services/rules/addressExtract';

export interface AddressCandidate extends ExtractedAddressCandidate {
  inputHash: string;
}

interface AddressCandidateRow extends Record<string, unknown> {
  complaintId: unknown;
  candidateText: unknown;
  evidenceText: unknown;
  sourceField: unknown;
  extractorVersion: unknown;
  inputHash: unknown;
  districtCode: unknown;
  parentMatch: unknown;
  snapshotId: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapCandidate(row: AddressCandidateRow): AddressCandidate {
  return {
    value: String(row.candidateText),
    evidence: String(row.evidenceText),
    sourceField: row.sourceField === 'title' ? 'title' : 'content',
    extractorVersion: String(row.extractorVersion) as ExtractedAddressCandidate['extractorVersion'],
    inputHash: String(row.inputHash),
    districtCode: nullableString(row.districtCode),
    parentMatch: nullableString(row.parentMatch) as AddressCandidate['parentMatch'],
    snapshotId: nullableString(row.snapshotId),
  };
}

export async function findAddressCandidate(db: Queryable, complaintId: string): Promise<AddressCandidate | null> {
  const [rows] = await db.query(
    'select complaint_id as complaintId, candidate_text as candidateText, evidence_text as evidenceText,' +
    ' source_field as sourceField, extractor_version as extractorVersion, input_hash as inputHash,' +
      ' district_code as districtCode, parent_match as parentMatch, snapshot_id as snapshotId' +
      ' from complaint_address_candidate where complaint_id = ? limit 1',
    [complaintId]
  );
  const list = rows as AddressCandidateRow[];
  return list.length ? mapCandidate(list[0]) : null;
}

export async function syncAddressCandidate(
  db: Queryable,
  complaintId: string,
  input: { title: string; content: string | null }
): Promise<'created' | 'updated' | 'unchanged' | 'removed' | 'none'> {
  const extracted = extractAddressCandidate(input);
  const existing = await findAddressCandidate(db, complaintId);
  if (!extracted) {
    if (!existing) return 'none';
    await db.execute('delete from complaint_address_candidate where complaint_id = ?', [complaintId]);
    return 'removed';
  }
  const inputHash = addressInputHash(input);
  const same = existing?.inputHash === inputHash && existing.extractorVersion === extracted.extractorVersion &&
    existing.value === extracted.value && existing.evidence === extracted.evidence && existing.sourceField === extracted.sourceField &&
    existing.districtCode === extracted.districtCode && existing.parentMatch === extracted.parentMatch &&
    existing.snapshotId === extracted.snapshotId;
  if (same) return 'unchanged';
  const values = [complaintId, extracted.value, extracted.evidence, extracted.sourceField, extracted.extractorVersion, inputHash,
    extracted.districtCode, extracted.parentMatch, extracted.snapshotId];
  if (!existing) {
    await db.execute(
      'insert into complaint_address_candidate ' +
      '(complaint_id, candidate_text, evidence_text, source_field, extractor_version, input_hash, district_code, parent_match, snapshot_id)' +
        ' values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values
    );
    return 'created';
  }
  await db.execute(
    'update complaint_address_candidate set candidate_text = ?, evidence_text = ?, source_field = ?,' +
      ' extractor_version = ?, input_hash = ?, district_code = ?, parent_match = ?, snapshot_id = ? where complaint_id = ?',
    [extracted.value, extracted.evidence, extracted.sourceField, extracted.extractorVersion, inputHash,
      extracted.districtCode, extracted.parentMatch, extracted.snapshotId, complaintId]
  );
  return 'updated';
}
