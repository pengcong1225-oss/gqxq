export interface Polygon {type:'Polygon';coordinates:number[][][]}
export interface MultiPolygon {type:'MultiPolygon';coordinates:number[][][][]}
export type BoundaryGeometry=Polygon|MultiPolygon;
export interface GridGeometry {type:'FeatureCollection';features:{type:'Feature';properties:{adminGridCode:string};geometry:BoundaryGeometry}[]}
export interface AdminGrid {code:string;name:string;districtCode:string;version:number;geometry:BoundaryGeometry|null;coordinateSystem:'WGS84'|null;geometrySource:string|null}
export interface Community {code:string;name:string;adminGridCode:string;version:number}
export interface GridCoverage {code:string;serviceGridCode:string;enterpriseCode:string;businessType:string;adminGridCodes:string[];communityCodes:string[];version:string;validFrom:string|null;validTo:string|null;geometry:GridGeometry|null;coordinateSystem:'WGS84'|null;geometrySources:string[];coverageState:'maintained'|'unmapped'|'draft'}
