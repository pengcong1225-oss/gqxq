import type { AccessContext } from '../auth/accessScope';
export type BusinessEventKind = 'shutdown' | 'pipeline' | 'followup';
export interface SourceRevision {
  sourceId: string; kind: BusinessEventKind; sourceObjectId: string; sourceVersion: number; payloadHash: string;
}
export interface ApprovalNode {
  nodeId: string; at: string | null; department: string | null; operatorName: string | null; decision: string | null; notes: string | null;
}
export interface EventPayload {
  title: string; businessType: 'water' | 'gas'; applicationId: string | null;
  approvalState: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'unknown';
  state: 'planned' | 'active' | 'ended' | 'cancelled' | 'unknown';
  startsAt: string | null; endsAt: string | null; adminGridCodes: string[];
  impactDescription: string | null; emergencyPlan: string | null; sourceUrl: string | null; approvalHistory: ApprovalNode[];
}
export interface ShutdownPayload extends EventPayload {
  nature: 'planned' | 'emergency' | 'unknown'; expectedRestoredAt: string | null; restoredAt: string | null; households: number | null;
}
export interface PipelinePayload extends EventPayload { workers: number | null; reason: string | null; }
export interface SynchronizedFollowupPayload {
  complaintId: string; occurredAt: string | null; contacted: boolean | null;
  evaluation: 'satisfied' | 'dissatisfied' | null; dissatisfactionReason: string | null; operatorName: string | null; notes: string | null;
}
interface BusinessEventBase {
  sourceId: string; sourceObjectId: string; sourceVersion: number; sourceUpdatedAt: string;
  enterpriseCode: string | null; districtCode: string | null;
}
export type BusinessEventInput = BusinessEventBase & (
  { kind: 'shutdown'; payload: ShutdownPayload } | { kind: 'pipeline'; payload: PipelinePayload } |
  { kind: 'followup'; payload: SynchronizedFollowupPayload });
export type BusinessEventView = BusinessEventInput & {
  id: string; receivedAt: string; payloadHash: string; qualityReasons: string[];
};
export interface BusinessEventContext {
  userId: string; userName?: string; clientIp?: string | null; permissionCodes: readonly string[]; access: AccessContext;
}
export interface BusinessSourceConfig { sourceId: string; keyId: string; secret: string; maxSkewSeconds: number;sourceSystem?:string;complaintTargets?:{sourceSystem:string;allEnterprises?:boolean;enterpriseCodes?:string[]}[]; }

/** 预警场景（与业务规则 scene 一致）。 */
export type BusinessAlertScene = 'winter' | 'summer' | 'planned_shutdown' | 'gas_three_piece';
/** 阈值基线快照：保存/发布时冻结，用于解释阈值来源。 */
export interface AlertBaselineSnapshot { avgPerDay: number; windowBase: number; baseDays: number; daysFrom: string; daysTo: string }
/** 保障季基线使用的月份口径。 */
export interface AlertBaselineSeason { startMonth: number; endMonth: number; months: number[] }
export interface AlertBaselineSuggestion { multiplier: number; threshold: number }
/** POST /business-rules/baseline 只读预览返回。 */
export interface AlertBaselinePreview extends AlertBaselineSnapshot { season: AlertBaselineSeason | null; suggestions: AlertBaselineSuggestion[] }
/** POST /business-rules/baseline 请求体（strict）。 */
export interface AlertBaselineQueryInput {
  businessType: 'water' | 'gas';
  minorCodes: string[];
  majorCodes: string[];
  dictionaryVersion: string | null;
  windowDays: number;
  scene: BusinessAlertScene | null;
  from: string | null;
  to: string | null;
}
export interface BusinessSourceHeaders { sourceId: string; keyId: string; timestamp: string; signature: string; }
export interface BusinessEventQuery { page: number; size: number; search?: string; businessType?: 'water' | 'gas'; approvalState?: string; state?: string; from?: string; to?: string; }
