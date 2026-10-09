export type FieldResolution = 'unresolved' | 'confirmed' | 'no_correction' | 'needs_verification';
export type IncomingOrder = 'newer' | 'same' | 'older' | 'unknown';
export interface EffectiveFieldInput {
  field: string;
  sourceValue: unknown;
  effectiveValue: unknown;
  resolution: FieldResolution;
  incomingOrder: IncomingOrder;
}
export interface EffectiveFieldDecision {
  action: 'apply_source' | 'retain_effective' | 'hold_for_review';
  reason: string;
}
export const EffectiveFieldPolicy = {
  decide(input: EffectiveFieldInput): EffectiveFieldDecision {
    if (input.resolution === 'confirmed' || input.resolution === 'no_correction') {
      return { action: 'retain_effective', reason: input.field + '：保留人工决定的有效值（' + input.resolution + '）' };
    }
    if (input.resolution === 'needs_verification') {
      return { action: 'hold_for_review', reason: input.field + '：历史人工决定无法完整核实，保留当前有效值待核验' };
    }
    if (input.incomingOrder === 'newer') {
      return { action: 'apply_source', reason: input.field + '：可信来源顺序更新且尚未人工处理' };
    }
    if (input.incomingOrder === 'same' || Object.is(input.sourceValue, input.effectiveValue)) {
      return { action: 'retain_effective', reason: input.field + '：同版本或相同取值无需写回' };
    }
    return { action: 'hold_for_review', reason: input.field + (input.incomingOrder === 'older'
      ? '：来源旧版本不得倒退有效值' : '：来源顺序未知，本次收到的快照差异待人工核验') };
  },
};

export const EFFECTIVE_COLUMNS = [
  'title', 'content', 'address', 'district_code', 'district_name', 'location_lng', 'location_lat',
  'business_type', 'complaint_type', 'urgency_level', 'is_sensitive', 'sensitive_keywords', 'rule_confidence', 'rule_version',
] as const;
export interface EffectiveFieldStateEntry {
  resolution: FieldResolution;
  value: unknown;
  version: number | null;
  reason: string;
  correctionId?: string;
}
export type EffectiveFieldState = Record<string, EffectiveFieldStateEntry>;
export function parseFieldState(raw: unknown): EffectiveFieldState {
  let parsed = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return {}; } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const states: EffectiveFieldState = {};
  for (const [field, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const state = entry as EffectiveFieldStateEntry;
    if (['unresolved', 'confirmed', 'no_correction', 'needs_verification'].includes(state.resolution)) states[field] = state;
  }
  return states;
}
