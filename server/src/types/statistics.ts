export type StatisticsDataset='ledger'|'analysis';
export type StatisticsProjection='current'|'entry_snapshot';
export type PeriodKind='month'|'quarter'|'year'|'custom';
export interface BucketSelection {dimension:'business'|'category'|'enterprise'|'district'|'grid';code:string|null;level?:'major'|'minor';dictionaryVersion?:string|null}
export interface StatisticsQuery {
 dataset:StatisticsDataset;projection:StatisticsProjection;periodKind:PeriodKind;from:string;to:string;comparisonPolicyId:'candidate-calendar-v1';
 businessType?:string;majorCode?:string;minorCode?:string;enterpriseCode?:string;districtCode?:string;serviceGridCode?:string;bucket?:BucketSelection;
}
export interface DimensionBucket extends BucketSelection {name:string;count:number}
export interface ComparisonPeriod {kind:'yoy'|'mom';label:string;from:string|null;to:string|null;currentDays:number;baselineDays:number|null;truncated:boolean;reason:string|null}
export interface PeriodComparison extends ComparisonPeriod {baselineCount:number|null;currentCount:number;changePercent:number|null}
export interface StatisticsFacts {
 complaintId:string;complaintNo:string;title:string|null;businessType:string|null;complaintType:string|null;
 majorCode:string|null;minorCode:string|null;dictionaryVersion:string|null;districtCode:string|null;districtName:string|null;enterpriseCode:string|null;enterpriseName:string|null;
 longitude:number|null;latitude:number|null;coordinateSystem:'WGS84'|'unknown'|null;coordinateSource:string|null;adminGridCode:string|null;communityCode:string|null;
 sourceReportedAt:string|null;receivedAt:string|null;editVersion:number;enteredAt:string|null;
}
export interface StatisticsComplaint extends StatisticsFacts {
 id:number;analysisId:string|null;businessAt:string|null;businessDay:string|null;timeSource:'source_reported_at'|'received_fallback'|'unavailable';timeReason:string|null;
 grids:string[];locationReason:string|null;snapshotReason:string|null;
}
export interface HouseholdEvidence {enterpriseCode:string;at:string;households:number|null;validFrom:string|null;validTo:string|null;version:string|null;value:number|null;reason:string|null;label:string}
export interface StatisticsResult {
 query:StatisticsQuery;policy:{id:string;version:number;status:'candidate';label:string};timezone:'Asia/Shanghai';timeBasis:string;
 total:number;partial:boolean;dateFilterUnavailableCount:number;sourceTimeFallbackCount:number;unlocatedCount:number;multiGridCount:number;
 excludedByReason:Record<string,number>;dimensions:DimensionBucket[];comparisons:PeriodComparison[];dataCutoffAt:string;
 projectionCapabilities:{businessDate:string|null;category:string|null;location:string|null};
 trend:{date:string;count:number}[];rates:HouseholdEvidence[];overallRate:{value:null;reason:string};satisfactionRate:{value:null;reason:string};
}
export interface StatisticsPage {query:StatisticsQuery;content:StatisticsComplaint[];total:number;page:number;size:number;totalPages:number;partial:boolean;dateFilterUnavailableCount:number;dataCutoffAt:string}
