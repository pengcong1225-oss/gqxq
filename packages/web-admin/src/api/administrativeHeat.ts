import request from './request';
import {statisticsParams} from './statistics';
import type {StatisticsQuery,StatisticsPage} from '../types/statistics';
import type {HeatData} from './heatRules';
export interface AdministrativeHeatData extends Omit<HeatData,'grids'>{administrative:true;simulation?:boolean;simulationCoefficients?:boolean;approximateCount?:number;demoCount?:number;coveredCount:number;coefficients:string[]|null;grids:(HeatData['grids'][number]&{name:string;communities:string[]})[]}
export const getAdministrativeHeat=(q:StatisticsQuery,simulation=false)=>request.get<never,AdministrativeHeatData>('/heatmap/administrative-data',{params:{...statisticsParams(q),simulation}});
export const getAdministrativeComplaints=(q:StatisticsQuery,adminGridCode:string,page:number,size:number,simulation=false)=>request.get<never,StatisticsPage>('/heatmap/administrative-complaints',{params:{...statisticsParams(q),adminGridCode,page,size,simulation}});
