import type {AccessContext} from '../auth/accessScope';
import type {ScreenEvidenceRecord} from './screenEvidence';
import type {buildScreen} from '../domain/screen';
export interface ScreenContext {
 owner:string;
 scope:string;
 expires:number;
 details:ReturnType<typeof buildScreen>['details'];
 eventDemandTimes:ReturnType<typeof buildScreen>['eventDemandTimes'];
 capturedAt:number;
 periodDetails:ReturnType<typeof buildScreen>['periodDetails'];
 events:ReturnType<typeof buildScreen>['events'];
 gridCodes:string[];
 heatGridDetails?:Map<string,ReturnType<typeof buildScreen>['details']>;
 evidence:Record<string,ScreenEvidenceRecord>;
 mode:'real'|'simulation';
}
export const screenContexts=new Map<string,ScreenContext>();
export const screenScopeKey=(access:AccessContext)=>JSON.stringify([access.scopeVersion,access.rules]);
