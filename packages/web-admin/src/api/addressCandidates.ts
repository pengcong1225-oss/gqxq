import request from './request';

export interface AddressBackfillSummary {
  total: number;
  extractable: number;
  noCandidate: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  errors: { scan: number; row: number; audit: number };
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
  samples: Array<{ item: number; action: 'create' | 'update' | 'unchanged' | 'remove' | 'no_candidate'; category: 'address' | 'township' | 'settlement' | 'conflict' | 'unresolved'; value: '[已脱敏]' }>;
}

export const previewAddressBackfill = () => request.post<never, AddressBackfillPreview>('/address-candidates/backfill-preview');
export const executeAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill');
