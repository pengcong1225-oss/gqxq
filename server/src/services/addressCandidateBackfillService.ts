import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { findAddressCandidate, syncAddressCandidate } from '../repositories/addressCandidateRepo';
import type { Queryable } from '../repositories/complaintSourceLogRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import type { OperatorContext } from './dispatchService';
import { GQXQ_APP_CODE } from './intakeService';
import { addressInputHash, extractAddressCandidate } from './rules/addressExtract';

export interface AddressBackfillSummary {
  total: number;
  extractable: number;
  noCandidate: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
}

interface ComplaintRow { complaintId: string; title: string | null; content: string | null }
const PAGE_SIZE = 100;
const EMPTY = (): AddressBackfillSummary => ({ total: 0, extractable: 0, noCandidate: 0,
  created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 });

async function scanPage(db: Queryable, after: string): Promise<ComplaintRow[]> {
  const [rows] = await db.query(
    'select complaint_id as complaintId, title, content from complaint where complaint_id > ? order by complaint_id limit ?',
    [after, PAGE_SIZE]
  );
  return rows as ComplaintRow[];
}

export async function previewAddressCandidateBackfill(): Promise<AddressBackfillSummary> {
  const result = EMPTY();
  let after = '';
  for (;;) {
    const rows = await scanPage(pool, after);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.complaintId;
      result.total++;
      const input = { title: row.title ?? '', content: row.content };
      const extracted = extractAddressCandidate(input);
      if (extracted) result.extractable++;
      else result.noCandidate++;
      const existing = await findAddressCandidate(pool, row.complaintId);
      if (!extracted) { if (existing) result.removed++; continue; }
      if (!existing) { result.created++; continue; }
      if (existing.inputHash === addressInputHash(input) && existing.extractorVersion === extracted.extractorVersion) result.unchanged++;
      else result.updated++;
    }
  }
  return result;
}

export async function executeAddressCandidateBackfill(operator: OperatorContext): Promise<AddressBackfillSummary> {
  const result = EMPTY();
  let after = '';
  for (;;) {
    const rows = await scanPage(pool, after);
    if (!rows.length) break;
    for (const scanned of rows) {
      after = scanned.complaintId;
      result.total++;
      try {
        const change = await withTransaction(async (tx) => {
          const [lockedRows] = await tx.query(
            'select complaint_id as complaintId, title, content from complaint where complaint_id = ? for update',
            [scanned.complaintId]
          );
          const locked = (lockedRows as ComplaintRow[])[0];
          if (!locked) return { kind: 'unchanged' as const, extractable: false };
          const input = { title: locked.title ?? '', content: locked.content };
          const extracted = extractAddressCandidate(input);
          const kind = await syncAddressCandidate(tx, locked.complaintId, input);
          return { kind, extractable: Boolean(extracted) };
        });
        if (change.extractable) result.extractable++; else result.noCandidate++;
        result[change.kind === 'none' ? 'unchanged' : change.kind]++;
      } catch {
        result.failed++;
      }
    }
  }
  await insertAudit(pool, {
    userId: operator.userId, appCode: GQXQ_APP_CODE, resourceCode: '/address-candidates/backfill',
    action: 'ADDRESS_CANDIDATE_BACKFILL', bizType: 'address_candidate', bizId: null,
    result: result.failed ? 'failed' : 'success', clientIp: operator.clientIp,
    detail: { ...result }, createdAt: new Date(),
  });
  return result;
}
