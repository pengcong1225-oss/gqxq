import request from './request';
import type {StatisticsQuery,StatisticsResult,StatisticsPage} from '../types/statistics';
export function statisticsParams(query:StatisticsQuery){return {...query,bucket:query.bucket?JSON.stringify(query.bucket):undefined};}
export function getStatisticsSummary(query:StatisticsQuery){return request.get<never,StatisticsResult>('/statistics/summary',{params:statisticsParams(query)});}
export function getStatisticsComplaints(query:StatisticsQuery,page=1,size=10){return request.get<never,StatisticsPage>('/statistics/complaints',{params:{...statisticsParams(query),page,size}});}
