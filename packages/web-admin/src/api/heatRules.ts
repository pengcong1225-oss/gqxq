import request from './request';
import type {StatisticsQuery} from '../types/statistics';
import type {CategoryRef,DictionaryItem} from '../types/masterData';
import type {GridCoverage} from './grids';
type GridGeometry=NonNullable<GridCoverage['geometry']>;
export type HeatLevel='green'|'blue'|'yellow'|'orange'|'red';
export interface HeatPolicy {anchor:'lower'|'upper';endpointOwner:'lower'|'upper';zero:'green'|'null';belowFirst:'green'|'null';top:'red'|'null';day:'shanghai_inclusive';classFallback:'exact_only'|'minor_then_major';noRule:'null';ruleSelection:'query_end'}
export interface HeatDraft {ruleId:string;category:CategoryRef;coefficients:string[];policyId:string;policyVersion:number;policy:Partial<HeatPolicy>;effectiveFrom:string;expectedVersion:number}
export interface HeatDraftRow {ruleId:string;editVersion:number;input:HeatDraft;approvalStatus:'confirmed'|'unconfirmed'}
export interface HeatData {query:StatisticsQuery;total:number;unlocatedCount:number;dataCutoffAt:string;partial:boolean;excludedByReason:Record<string,number>;statisticsPolicy:{label:string};selectionDate:string;ruleSelection:'query_end';days:number;category:{majorCode:string;minorCode:string|null}|null;nonAdditive:true;grids:{code:string;count:number;level:HeatLevel|null;reason:string|null;ruleVersion:string|null;policyId:string|null;policyVersion:number|null;coverages:{version:string;selectedBusinessDays:string[];geometry:GridGeometry|null;coordinateSystem:string|null;geometrySources:string[];validFrom:string|null;validTo:string|null}[]}[];points:{complaintId:string;longitude:number;latitude:number;grids:string[]}[]}
export const getHeatData=(q:StatisticsQuery)=>request.get<never,HeatData>('/heatmap/data',{params:{...q,...(q.bucket?{bucket:JSON.stringify(q.bucket)}:{})}});
export const listHeatRules=()=>request.get<never,HeatDraftRow[]>('/heat-rules');
export const heatCategoryOptions=()=>request.get<never,{dictionaryVersion:string;items:DictionaryItem[]}>('/heat-rules/categories');
export const saveHeatRule=(input:HeatDraft)=>request.post<never,HeatDraftRow>('/heat-rules',input);
export const previewHeatRule=(id:string,count:number,days:number,expectedVersion:number)=>request.post<never,{level:HeatLevel|null;reason:string|null;candidate:true;ruleVersion:string|null;policyVersion:number}>('/heat-rules/'+encodeURIComponent(id)+'/preview',{count,days,expectedVersion});
export const publishHeatRule=(id:string,expectedVersion:number)=>request.post('/heat-rules/'+encodeURIComponent(id)+'/publish',{expectedVersion});
