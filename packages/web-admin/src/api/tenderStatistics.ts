import request from './request';
import {statisticsParams} from './statistics';
import type {StatisticsQuery} from '../types/statistics';
import type {TenderStatisticsResult} from '../types/tenderStatistics';
export function getTenderStatistics(query:StatisticsQuery){return request.get<never,TenderStatisticsResult>('/statistics/tender',{params:statisticsParams(query)});}
