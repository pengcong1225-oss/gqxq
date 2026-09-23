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
}

export const previewAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill-preview');
export const executeAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill');
