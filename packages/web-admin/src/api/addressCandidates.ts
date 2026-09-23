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
}

export interface AddressBackfillPreview extends AddressBackfillSummary {
  samples: Array<{ item: number; action: 'create' | 'update' | 'unchanged' | 'remove' | 'no_candidate'; sourceField: 'title' | 'content' | null; value: '[地址已脱敏]' | '[无地址候选]' }>;
}

export const previewAddressBackfill = () => request.post<never, AddressBackfillPreview>('/address-candidates/backfill-preview');
export const executeAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill');
