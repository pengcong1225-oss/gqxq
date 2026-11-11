import request from './request';
export interface BusinessRuleInput {ruleId:string;kind:'seasonal'|'alert';expectedVersion:number;name:string;businessType:'water'|'gas';dictionaryVersion:string;majorCodes:string[];minorCodes:string[];effectiveFrom:string;effectiveTo:string;scene:'winter'|'summer'|'planned_shutdown'|'gas_three_piece'|null;startMonth:number|null;endMonth:number|null;threshold:number|null;windowDays:number|null;definitionBasis:string;definitionConfirmed:boolean;enabled:boolean}
export interface BusinessRuleRow {input:BusinessRuleInput;editVersion:number;publishedVersion:number}
export const businessRules=()=>request.get<never,BusinessRuleRow[]>('/business-rules');
export const saveBusinessRule=(v:BusinessRuleInput)=>request.post<never,{editVersion:number}>('/business-rules',v);
export const publishBusinessRule=(id:string,expectedVersion:number)=>request.post('/business-rules/'+encodeURIComponent(id)+'/publish',{expectedVersion});
export interface AssessmentDetail {complaintId:string;complaintNo:string;adminGridCode:string|null;businessAt:string|null;majorCode:string|null;dictionaryVersion:string|null}
export interface AssessmentMeta {snapshotId:string;timezone:string;timeBasis:string;dataCutoffAt:string;coverageNote:string;sourceTimeFallbackCount:number}
export interface ComparisonResult extends AssessmentMeta {totals:Record<string,number>;categories:{code:string;dictionaryVersion:string;count:number;counts:Record<string,number>;highest:string[]}[];grids:{code:string;name:string;version:number;hasGeometry:boolean}[];unlocatedCount:number;partial:boolean;details:AssessmentDetail[]|null}
export interface HistoricalResult extends AssessmentMeta {calendarAlignment:string;closureBasis:string;years:{year:number;from:string;to:string;count:number|null;top3:{code:string;name?:string;dictionaryVersion:string;count:number}[];status:string;categoryUnknownCount:number;details:AssessmentDetail[]|null}[]}
export interface SeasonalResult extends Partial<AssessmentMeta> {status:string;reason?:string;rule?:{ruleId:string;version:number;name:string;definitionBasis:string};seasons?:{year:number;from:string;to:string;observedTo?:string;truncated?:boolean;count:number|null;status:string}[];previousMonths?:{month:string;count:number|null;status:string}[];top6?:{code:string;name:string;count:number;previousCount:number|null}[];unlocatedCount?:number;details?:AssessmentDetail[]|null}
export const comparisonGrids=()=>request.get<never,{code:string;name:string;version:number;hasGeometry:boolean}[]>('/assessment/admin-grids');
export const gridComparison=(params:Record<string,unknown>)=>request.get<never,ComparisonResult>('/assessment/grid-comparison',{params});
export const historicalAssessment=(params:Record<string,unknown>)=>request.get<never,HistoricalResult>('/assessment/historical',{params});
export const seasonalAssessment=(params:Record<string,unknown>)=>request.get<never,SeasonalResult>('/assessment/seasonal',{params});
export interface BusinessAlert {alertId:string;ruleId:string;ruleVersion:number;from:string;to:string;enterpriseCode:string;districtCode:string;adminGridCode:string;quantity:number;threshold:number;state:string;createdAt:string;scene:string;ruleName:string;definitionBasis:string;complaintIds:string[]|null;dataCutoffAt:string}
export const businessAlerts=()=>request.get<never,BusinessAlert[]>('/business-alerts');
export const evaluateAlerts=(day:string)=>request.post<never,{created:number;statuses:{ruleId:string;name:string;status:string;reason:string|null;count?:number}[];unconfiguredScenes:string[]}>('/business-alerts/evaluate',{day});
export const alertAction=(id:string,action:string,notes:string)=>request.post('/business-alerts/'+id+'/actions',{action,notes});
export const alertHistory=(id:string)=>request.get<never,{action:string;notes:string;user_id:string;created_at:string}[]>('/business-alerts/'+id+'/history');
