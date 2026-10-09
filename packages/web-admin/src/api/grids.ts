import request from './request';
import type {Paged} from '../types/api';
export interface GridCoverage {code:string;serviceGridCode:string;enterpriseCode:string;businessType:string;adminGridCodes:string[];communityCodes:string[];version:string;validFrom:string|null;validTo:string|null;geometry:{type:'FeatureCollection';features:{type:'Feature';properties:{adminGridCode:string};geometry:{type:'Polygon';coordinates:number[][][]}|{type:'MultiPolygon';coordinates:number[][][][]}}[]}|null;coordinateSystem:'WGS84'|null;geometrySources:string[];coverageState:'maintained'|'unmapped'}
export interface GridInput {code:string;enterpriseCode:string;businessType:string;adminGridCodes:string[];communityCodes:string[];validFrom:string;validTo:string|null;expectedVersion?:number;expectedBusinessTypeVersion?:number;expectedAdminVersions?:Record<string,number>;expectedCommunityVersions?:Record<string,number>}
export interface AdminGrid {code:string;name:string;districtCode:string;version:number;geometry:unknown|null;coordinateSystem:'WGS84'|null;geometrySource:string|null}
export interface Community {code:string;name:string;adminGridCode:string;version:number}
export interface GridOptions {enterprises:{enterpriseCode:string;enterpriseName:string;businessType:string;status:string}[];adminGrids:Omit<AdminGrid,'geometry'|'coordinateSystem'|'geometrySource'>[];communities:Community[];businessTypes:{value:string;label:string}[];districts:{value:string;label:string}[];businessTypeVersion:number|null;districtVersion:number|null}
export const listGrids=(page=1)=>request.get<never,Paged<GridCoverage>>('/grids',{params:{page,size:20}});
export const getGrid=(code:string)=>request.get<never,GridCoverage>('/grids/'+encodeURIComponent(code));
export const gridHistory=(code:string)=>request.get<never,GridCoverage[]>('/grids/'+encodeURIComponent(code)+'/history');
export const gridOptions=()=>request.get<never,GridOptions>('/grid-reference-options');
export const saveGrid=(input:GridInput)=>input.expectedVersion?request.patch<never,{value:GridCoverage}>('/grids/'+encodeURIComponent(input.code),input):request.post<never,{value:GridCoverage}>('/grids',input);
export const getAdminGrid=(code:string)=>request.get<never,AdminGrid>('/admin-grids/'+encodeURIComponent(code));
export const saveAdminGrid=(input:Omit<AdminGrid,'version'>&{expectedVersion:number;expectedDistrictVersion?:number})=>request.post('/admin-grids',input);
export const saveCommunity=(input:Omit<Community,'version'>&{expectedVersion:number;expectedAdminVersion?:number})=>request.post('/communities',input);
