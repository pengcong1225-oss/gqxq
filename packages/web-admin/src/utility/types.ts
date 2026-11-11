export type UtilityMode = 'simulation' | 'real';
export type UtilityKind = 'shutdown' | 'pipeline';
export interface UtilityEvent {
  id: string;
  kind: UtilityKind;
  title: string;
  businessType: 'water' | 'gas';
  enterpriseId: string;
  gridIds: string[];
  districtCode: string;
  startsAt: string;
  endsAt: string;
  restoredAt: string | null;
  households: number;
  workers: number;
  reason: string;
  area: string;
  plan: string;
  housing: string;
  sourceApplicationNo: string;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  approvalNote: string;
  approvedBy: string;
  approvedAt: string | null;
  relatedTypes: string[];
  revision: number;
  updatedAt: string;
  mode: UtilityMode;
  sourceSystem?: 'public-utility';
  sourceRevision?: string;
  sourceStatus?: string;
  approvalTraces?: unknown[];
}
export interface UtilityOptions {
  enterprises: {id: string; name: string; businessType: 'water' | 'gas'}[];
  grids: {id: string; name: string; districtCode: string}[];
}
export interface UtilityList {
  revision: number;
  events: UtilityEvent[];
  options: UtilityOptions;
  source: string;
  integration?: {enabled:boolean;running:boolean;lastError:string|null;syncedAt:string|null;mapped:number;pendingMapping:number;unclassifiedCount:number;sourceRevision:number};
  sourceRows?: {sourceApplicationNo:string;kind:string;sourceRevision:string;sourceStatus:string;syncStatus:string;issues:string[];fields:Record<string,unknown>;approvalTraces:unknown[]}[];
}
export interface UtilityComplaint {id: string; title: string; type: string; occurredAt: string; gridId: string}
export interface UtilityHistory {revision: number; updatedAt: string; event: UtilityEvent}
export interface UtilityDetail {event: UtilityEvent; history: UtilityHistory[]; complaints: UtilityComplaint[]}
export interface TimeoutItem {sourceSystem?:'public-utility';
  id: string; eventId: string; eventTitle: string; from: string; to: string;
  complaints: UtilityComplaint[];
  status: 'pending' | 'failed' | 'simulated' | 'blocked' | 'sent' | 'superseded';
  attempts: {at: string; result: string; message: string}[];
  eventRevision: number;
}
export interface UtilityTimeouts {revision: number; items: TimeoutItem[]; evaluatedAt: string; windowDescription: string}
