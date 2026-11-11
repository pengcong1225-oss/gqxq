import type { SupportGrid, SupportCommunity, SupportPipeline } from './tenderSupport';
export type ScreenState = 'available' | 'partial' | 'unavailable';
export interface ScreenSection<T> { state: ScreenState; reason: string | null; data: T }
export interface ScreenTimeCount { date: string; count: number }
export interface ScreenBucket { code: string; count: number; evidenceKey?: string }
export interface ScreenEnterpriseRate { id: string; name: string | null; count: number; households: number | null; per10k: number | null; reason: string | null; version: string | null; at: string }
export interface ScreenCommunityRank { id: string; name: string | null; count: number; rank: number }
export interface ScreenEvaluation { evaluatedCount: number | null; satisfiedCount: number | null; unsatisfiedCount: number | null; unevaluatedCount: number | null; percent: number | null }
export interface ScreenDuration { key: string; count: number | null; evaluation: ScreenEvaluation }
export interface ScreenSeason { kind: string; years: { year: number; from: string; to: string; count: number; evidenceKey?: string }[]; months: { month: number; currentRange: { from: string; to: string }; previousRange: { from: string; to: string }; currentCount: number; previousCount: number; currentEvidenceKey?: string; previousEvidenceKey?: string }[]; topGrids: { id: string; name: string; count: number; previousCount: number; currentEvidenceKey?: string; previousEvidenceKey?: string }[] }
export interface ScreenEvent { id: string; kind: string; eventType: string | null; gridIds: string[]; title: string; businessType: string; enterpriseId: string; districtCode: string; startsAt: string; endsAt: string; approvalStatus: string; reason: string | null; area: string | null; plan: string | null; housing: string | null; households: number | null; workers: number | null; revision: number; updatedAt: string; sourceRevision: string | null; hasGrid: boolean; hasCategories: boolean; spatialState: string }
export interface ScreenSupply { enterpriseRates: ScreenEnterpriseRate[]; communities: ScreenCommunityRank[]; monthly: ScreenTimeCount[]; regions: ScreenBucket[] }
export interface ScreenDynamic { evaluation: ScreenEvaluation; unsatisfiedBusiness: { businessType: string; count: number | null; percent: number | null }[]; duration: ScreenDuration[]; hourly: { hour: number; count: number }[]; weekly: ScreenTimeCount[]; monthly: ScreenTimeCount[] }
export interface ScreenSections {
  supply: ScreenSection<ScreenSupply>;
  dynamic: ScreenSection<ScreenDynamic>;
  top3: ScreenSection<{ items: ScreenBucket[]; from: string; to: string; coverage: string }>;
  warnings: ScreenSection<{ items: { scenario: string; from: string | null; to: string | null; count: number | null; triggered: boolean | null; threshold:number|null; days:number|null; enabled:boolean|null; ruleVersion:string|null; evidenceKey?: string }[] }>;
  research: ScreenSection<{ seasons: ScreenSeason[] }>;
  spatial: ScreenSection<{ grids: SupportGrid[]; communities: SupportCommunity[]; events: ScreenEvent[]; pipelines: SupportPipeline[] }>;
}

export interface ScreenHeat {days:number|null;thresholds:number[]|null;coefficients:string[]|null;policyId:string|null;ruleVersion:string|null;grids:{code:string;count:number;level:string|null;reason:string|null;ruleVersion:string|null}[]}
