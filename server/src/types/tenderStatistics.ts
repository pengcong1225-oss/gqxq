import type {StatisticsQuery,DimensionBucket,PeriodComparison,HouseholdEvidence,StatisticsResult} from './statistics';
export interface TenderPeriod {key:'year'|'quarter'|'month'|'yesterday';label:string;query:StatisticsQuery;total:number;demoCount:number;comparisons:PeriodComparison[];types:{bucket:DimensionBucket;count:number;comparisons:PeriodComparison[]}[]}
export interface TenderSeriesPoint {key:string;label:string;water:number;gas:number}
export interface TenderServiceStatistics {
 businessType:'water'|'gas';title:string;query:StatisticsQuery;total:number;periods:TenderPeriod[];
 categories:DimensionBucket[];districts:DimensionBucket[];enterpriseRates:(HouseholdEvidence&{name:string;count:number})[];
 months:{key:string;count:number;query:StatisticsQuery}[];
 communities:{code:string;name:string;count:number}[];communityUnavailableCount:number;sourceTimeFallbackCount:number;
}
export interface TenderStatisticsResult {
 satisfactionRate?:StatisticsResult['satisfactionRate'];timeBasis?:string;policy?:StatisticsResult['policy'];excludedByReason?:Record<string,number>;
 query:StatisticsQuery;anchorDate:string;dataCutoffAt:string;total:number;periods:TenderPeriod[];services:TenderServiceStatistics[];
 partial:boolean;dateFilterUnavailableCount:number;sourceTimeFallbackCount:number;demoCount:number;extendedDemoCount:number;
 dynamics:{hours:TenderSeriesPoint[];months:TenderSeriesPoint[];weekdays:TenderSeriesPoint[];missingTimeCount:number;unavailable:{key:string;title:string;reason:string}[]};
}
