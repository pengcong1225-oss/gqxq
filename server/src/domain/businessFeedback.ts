export interface RestorationRule {version:number;majorCodes:string[];minorCodes:string[];dictionaryVersion:string}
export interface RestorationEvent {businessType:string;restoredAt:string|null;adminGridCodes:string[];state:string;approvalState:string}
export interface RestorationComplaint {businessType:string|null;sourceReportedAt:string|null;majorCode:string|null;minorCode:string|null;dictionaryVersion:string|null;adminGridCode:string|null;locationVerified:boolean}
export function matchRestoration(event:RestorationEvent,row:RestorationComplaint,rule:RestorationRule|null):{state:'matched'|'review'|'excluded';reason:string|null;windowFrom?:string;windowTo?:string} {
 const result=(state:'matched'|'review'|'excluded',reason:string|null)=>({state,reason});
 if(event.state==='cancelled'||event.approvalState==='rejected'||event.approvalState==='cancelled')return result('excluded','EVENT_CANCELLED');
 if(event.businessType!==row.businessType)return result('excluded','BUSINESS_TYPE_DIFFERENT');
 if(!event.restoredAt||!Number.isFinite(Date.parse(event.restoredAt)))return result('review','RESTORATION_UNKNOWN');
 if(event.approvalState!=='approved')return result('review','APPROVAL_UNCONFIRMED');
 if(!rule)return result('review','RULE_UNPUBLISHED');
 if(row.dictionaryVersion!==rule.dictionaryVersion)return result('review','CATEGORY_VERSION_UNMAPPED');
 if(!row.majorCode)return result('review','CATEGORY_UNKNOWN');
 if(!(rule.majorCodes.includes(row.majorCode)||row.minorCode!==null&&rule.minorCodes.includes(row.minorCode)))return result('excluded','CATEGORY_NOT_RELATED');
 if(!row.sourceReportedAt||!Number.isFinite(Date.parse(row.sourceReportedAt)))return result('review','SOURCE_TIME_UNKNOWN');
 const from=Date.parse(event.restoredAt),to=from+86400000,time=Date.parse(row.sourceReportedAt);
 if(time<from||time>=to)return result('excluded','OUTSIDE_RESTORATION_WINDOW');
 if(!event.adminGridCodes.length)return result('review','IMPACT_UNAVAILABLE');
 if(!row.adminGridCode||!row.locationVerified)return result('review','LOCATION_UNVERIFIED');
 if(!event.adminGridCodes.includes(row.adminGridCode))return result('excluded','OUTSIDE_IMPACT');
 return {...result('matched',null),windowFrom:new Date(from).toISOString(),windowTo:new Date(to).toISOString()};
}
