import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { findAddressCandidate, syncAddressCandidate } from '../repositories/addressCandidateRepo';
import { findLocationClues, syncLocationClues, type LocationClueRow, type LocationSyncResult } from '../repositories/locationClueRepo';
import type { Queryable } from '../repositories/complaintSourceLogRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import type { OperatorContext } from './dispatchService';
import { GQXQ_APP_CODE } from './intakeService';
import { addressInputHash, extractAddressCandidate } from './rules/addressExtract';
import { extractLocation, LOCATION_EXTRACTOR_VERSION, type ExtractedLocationClue } from './rules/locationExtract';
import { getTownshipSnapshot } from './rules/townshipGazetteer';

export type AddressBackfillErrorCategory = 'scan' | 'row' | 'audit';
export type BackfillSampleCategory = 'address' | 'township' | 'settlement' | 'conflict' | 'unresolved';
export type BackfillAction = 'create' | 'update' | 'unchanged' | 'remove' | 'no_candidate';

export interface AddressBackfillSummary {
  total: number;
  extractable: number;
  noCandidate: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  errors: Record<AddressBackfillErrorCategory, number>;
  townshipClues: number;
  settlementClues: number;
  conflicts: number;
  unresolved: number;
  clueCreated: number;
  clueUpdated: number;
  clueUnchanged: number;
  clueRemoved: number;
  recomputedForVersion: number;
}

export interface AddressBackfillPreview extends AddressBackfillSummary {
  samples: Array<{ item: number; action: BackfillAction; category: BackfillSampleCategory; value: '[已脱敏]' }>;
}

interface ComplaintRow { complaintId: string; title: string | null; content: string | null }
const PAGE_SIZE = 100;
const EMPTY = (): AddressBackfillSummary => ({
  total: 0, extractable: 0, noCandidate: 0, created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0,
  errors: { scan: 0, row: 0, audit: 0 }, townshipClues: 0, settlementClues: 0, conflicts: 0, unresolved: 0,
  clueCreated: 0, clueUpdated: 0, clueUnchanged: 0, clueRemoved: 0, recomputedForVersion: 0,
});

async function scanPage(db: Queryable, after: string): Promise<ComplaintRow[]> {
  const [rows] = await db.query(
    'select complaint_id as complaintId, title, content from complaint where complaint_id > ? order by complaint_id limit ?',
    [after, PAGE_SIZE]
  );
  return rows as ComplaintRow[];
}

function sameClueSet(before: LocationClueRow[], next: ExtractedLocationClue[], hash: string): boolean {
  return before.length === next.length && before.every((stored, index) => {
    const candidate = next[index];
    return stored.inputHash === hash && stored.kind === candidate.kind && stored.value === candidate.value &&
      stored.evidence === candidate.evidence && stored.sourceField === candidate.sourceField && stored.start === candidate.start &&
      stored.end === candidate.end && stored.townshipCode === candidate.townshipCode &&
      stored.districtCode === candidate.districtCode && stored.parentMatch === candidate.parentMatch &&
      stored.extractorVersion === candidate.extractorVersion && stored.snapshotId === candidate.snapshotId;
  });
}

function clueAction(before: LocationClueRow[], next: ExtractedLocationClue[], hash: string): BackfillAction {
  if (sameClueSet(before, next, hash)) return 'unchanged';
  if (!before.length) return next.length ? 'create' : 'unchanged';
  return next.length ? 'update' : 'remove';
}

function versionChanged(
  before: LocationClueRow[], next: ExtractedLocationClue[],
  beforeCandidate: Awaited<ReturnType<typeof findAddressCandidate>>,
  nextCandidate: ReturnType<typeof extractAddressCandidate>
): boolean {
  const locationVersion = next[0];
  const addressVersion = nextCandidate;
  const snapshotId = locationVersion?.snapshotId ?? getTownshipSnapshot().snapshotId;
  const clueVersionChanged = before.some((clue) => clue.extractorVersion !== LOCATION_EXTRACTOR_VERSION || clue.snapshotId !== snapshotId);
  const candidateVersionChanged = beforeCandidate !== null && addressVersion !== null &&
    (beforeCandidate.extractorVersion !== addressVersion.extractorVersion || beforeCandidate.snapshotId !== addressVersion.snapshotId);
  return clueVersionChanged || candidateVersionChanged;
}

function categoryOf(clues: ExtractedLocationClue[], conflict: boolean, hasAddress: boolean): BackfillSampleCategory {
  if (conflict) return 'conflict';
  if (clues.some((clue) => clue.parentMatch === 'unresolved')) return 'unresolved';
  if (clues.some((clue) => clue.kind === 'township')) return 'township';
  if (clues.some((clue) => clue.kind === 'settlement')) return 'settlement';
  return hasAddress ? 'address' : 'unresolved';
}

function countLocation(result: AddressBackfillSummary, clues: ExtractedLocationClue[], conflict: boolean): void {
  result.townshipClues += clues.filter((clue) => clue.kind === 'township').length;
  result.settlementClues += clues.filter((clue) => clue.kind === 'settlement').length;
  if (conflict) result.conflicts++;
  if (clues.length === 0 || clues.some((clue) => clue.parentMatch === 'unresolved')) result.unresolved++;
}

function countClueAction(result: AddressBackfillSummary, action: BackfillAction): void {
  if (action === 'create') result.clueCreated++;
  else if (action === 'update') result.clueUpdated++;
  else if (action === 'remove') result.clueRemoved++;
  else result.clueUnchanged++;
}

function countAddressAction(result: AddressBackfillSummary, action: Exclude<LocationSyncResult, 'none'> | 'none'): void {
  if (action === 'created') result.created++;
  else if (action === 'updated') result.updated++;
  else if (action === 'removed') result.removed++;
  else result.unchanged++;
}

export async function previewAddressCandidateBackfill(): Promise<AddressBackfillPreview> {
  const result: AddressBackfillPreview = { ...EMPTY(), samples: [] };
  let after = '';
  for (;;) {
    const rows = await scanPage(pool, after);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.complaintId;
      result.total++;
      const input = { title: row.title ?? '', content: row.content };
      const address = extractAddressCandidate(input);
      const location = extractLocation(input);
      const hash = addressInputHash(input);
      const [existingAddress, existingClues] = await Promise.all([
        findAddressCandidate(pool, row.complaintId), findLocationClues(pool, row.complaintId),
      ]);

      if (address) result.extractable++; else result.noCandidate++;
      const action: BackfillAction = !address
        ? (existingAddress ? 'remove' : 'no_candidate')
        : !existingAddress ? 'create'
          : existingAddress.inputHash === hash && existingAddress.extractorVersion === address.extractorVersion &&
            existingAddress.value === address.value && existingAddress.evidence === address.evidence &&
            existingAddress.sourceField === address.sourceField && existingAddress.districtCode === address.districtCode &&
            existingAddress.parentMatch === address.parentMatch && existingAddress.snapshotId === address.snapshotId
            ? 'unchanged' : 'update';
      if (action === 'create') result.created++;
      else if (action === 'update') result.updated++;
      else if (action === 'remove') result.removed++;
      else result.unchanged++;

      countLocation(result, location.clues, location.conflict);
      const clueOp = clueAction(existingClues, location.clues, hash);
      countClueAction(result, clueOp);
      if (versionChanged(existingClues, location.clues, existingAddress, address)) result.recomputedForVersion++;
      if (result.samples.length < 5) result.samples.push({
        item: result.total,
        action: clueOp === 'unchanged' && action !== 'unchanged' ? action : clueOp,
        category: categoryOf(location.clues, location.conflict, Boolean(address)),
        value: '[已脱敏]',
      });
    }
  }
  return result;
}

export async function executeAddressCandidateBackfill(operator: OperatorContext): Promise<AddressBackfillSummary> {
  const result = EMPTY();
  let after = '';
  for (;;) {
    let rows: ComplaintRow[];
    try { rows = await scanPage(pool, after); }
    catch { result.failed++; result.errors.scan++; break; }
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
          if (!locked) return null;
          const input = { title: locked.title ?? '', content: locked.content };
          const extractedAddress = extractAddressCandidate(input);
          const extractedLocation = extractLocation(input);
          const hash = addressInputHash(input);
          const [beforeAddress, beforeClues] = await Promise.all([
            findAddressCandidate(tx, locked.complaintId), findLocationClues(tx, locked.complaintId),
          ]);
          const recomputedForVersion = versionChanged(beforeClues, extractedLocation.clues, beforeAddress, extractedAddress);
          const addressChange = await syncAddressCandidate(tx, locked.complaintId, input);
          const clueChange = await syncLocationClues(tx, locked.complaintId, input);
          if ((addressChange !== 'none' && addressChange !== 'unchanged') ||
              (clueChange !== 'none' && clueChange !== 'unchanged')) {
            try {
              await insertAudit(tx, {
                userId: operator.userId, appCode: GQXQ_APP_CODE, resourceCode: '/address-candidates/backfill',
                action: 'LOCATION_CLUE_BACKFILL_ROW', bizType: 'address_candidate', bizId: locked.complaintId,
                result: 'success', clientIp: operator.clientIp,
                detail: { complaintId: locked.complaintId, addressChange, clueChange, inputHash: hash },
                createdAt: new Date(),
              });
            } catch (err) {
              throw Object.assign(new Error('location clue backfill audit failed', { cause: err }), { category: 'audit' as const });
            }
          }
          return {
            extractable: Boolean(extractedAddress), clues: extractedLocation.clues, conflict: extractedLocation.conflict,
            addressChange, clueChange, recomputedForVersion,
          };
        });
        if (!change) continue;
        if (change.extractable) result.extractable++; else result.noCandidate++;
        countAddressAction(result, change.addressChange);
        countLocation(result, change.clues, change.conflict);
        countClueAction(result, change.clueChange === 'created' ? 'create' : change.clueChange === 'updated' ? 'update' :
          change.clueChange === 'removed' ? 'remove' : 'unchanged');
        if (change.recomputedForVersion) result.recomputedForVersion++;
      } catch (err) {
        result.failed++;
        if ((err as { category?: string })?.category === 'audit') result.errors.audit++;
        else result.errors.row++;
      }
    }
  }
  return result;
}
