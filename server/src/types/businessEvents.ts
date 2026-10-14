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
export interface BusinessSourceConfig { sourceId: string; keyId: string; secret: string; maxSkewSeconds: number; }
export interface BusinessSourceHeaders { sourceId: string; keyId: string; timestamp: string; signature: string; }
export interface BusinessEventQuery { page: number; size: number; search?: string; businessType?: 'water' | 'gas'; approvalState?: string; state?: string; from?: string; to?: string; }
