import type {AdminGrid, Community, GridCoverage} from './serviceGrid';
export interface LocationCorrectionInput {
 complaintId:string;expectedVersion:number;districtCode:string|null;address:string|null;
 longitude:number|null;latitude:number|null;adminGridCode:string|null;communityCode:string|null;
 coordinateSystem:'WGS84'|'unknown'|null;coordinateSource:string|null;basis:string;
}
export interface LocationCandidate {adminGridCode:string;adminGridName:string;districtCode:string;communityCodes:string[]}
export interface LocationValidationResult {
 validationDate:string;spatialStatus:'verified'|'unknown';spatialReason:string;
 coverageEvidence:Array<{code:string;version:string;validFrom:string;validTo:string|null;sources:string[]}>;
 candidates:LocationCandidate[];
}
export type LocationCorrectionValue=Omit<LocationCorrectionInput,'complaintId'|'expectedVersion'|'basis'> & {districtName:string|null};
export interface LocationCorrectionResult extends LocationValidationResult {version:number;analysisEntered:boolean;location:LocationCorrectionValue}
export interface LocationFacts {districtName:string|null;admins:AdminGrid[];communities:Community[];coverages:GridCoverage[]}
export interface LocationCorrectionOptions {
 districts:Array<{code:string;name:string}>;
 adminGrids:Array<{code:string;name:string;districtCode:string}>;
 communities:Array<{code:string;name:string;adminGridCode:string}>;
}
