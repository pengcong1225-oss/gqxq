import request from './request';

export interface RepeatRateBucket {
  key: string;
  label: string;
  total: number;
  repeat: number;
  rate: number | null;
}

export interface RepeatRateResult {
  query: { from: string; to: string; businessType: 'water' | 'gas' | null; groupBy: 'month' | 'enterprise' | 'district' };
  overall: { total: number; repeat: number; rate: number | null };
  series: RepeatRateBucket[];
  generatedAt: string;
}

export function getRepeatRate(params: { from: string; to: string; groupBy: 'month' | 'enterprise' | 'district'; businessType?: 'water' | 'gas' }) {
  return request.get<never, RepeatRateResult>('/statistics/repeat-rate', { params });
}
