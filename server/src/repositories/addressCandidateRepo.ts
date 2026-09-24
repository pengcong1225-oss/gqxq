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
}

function mapCandidate(row: AddressCandidateRow): AddressCandidate {
  return {
    value: String(row.candidateText),
    evidence: String(row.evidenceText),
    sourceField: row.sourceField === 'title' ? 'title' : 'content',
    extractorVersion: String(row.extractorVersion) as ExtractedAddressCandidate['extractorVersion'],
    inputHash: String(row.inputHash),
    districtCode: null,
    parentMatch: null,
    snapshotId: null,
  };
}

export async function findAddressCandidate(db: Queryable, complaintId: string): Promise<AddressCandidate | null> {
  const [rows] = await db.query(
    'select complaint_id as complaintId, candidate_text as candidateText, evidence_text as evidenceText,' +
      ' source_field as sourceField, extractor_version as extractorVersion, input_hash as inputHash' +
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
  if (existing?.inputHash === inputHash && existing.extractorVersion === extracted.extractorVersion) return 'unchanged';
  const values = [complaintId, extracted.value, extracted.evidence, extracted.sourceField, extracted.extractorVersion, inputHash];
  if (!existing) {
    await db.execute(
      'insert into complaint_address_candidate ' +
        '(complaint_id, candidate_text, evidence_text, source_field, extractor_version, input_hash) values (?, ?, ?, ?, ?, ?)',
      values
    );
    return 'created';
  }
  await db.execute(
    'update complaint_address_candidate set candidate_text = ?, evidence_text = ?, source_field = ?,' +
      ' extractor_version = ?, input_hash = ? where complaint_id = ?',
    [extracted.value, extracted.evidence, extracted.sourceField, extracted.extractorVersion, inputHash, complaintId]
  );
  return 'updated';
}
