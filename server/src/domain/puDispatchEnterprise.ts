export interface PuDispatchEnterpriseIdentity {
 sourceSystem:'public-utility';sourceKind:'company';sourceId:string;targetEnterpriseCode:string;gqxqSubjectCode:string;
 subjectAliases:Array<{subjectId:string|number;subjectCode:string;status?:string}>;
}
function identity(snapshot:Record<string,unknown>,target:string):PuDispatchEnterpriseIdentity|null{
 const metadata=snapshot.metadata as Record<string,unknown>|undefined;
 const value=metadata?.enterpriseIdentity as PuDispatchEnterpriseIdentity|undefined;
 if(!value||value.sourceSystem!=='public-utility'||value.sourceKind!=='company'||typeof value.sourceId!=='string'||!/^[1-9][0-9]*$/.test(value.sourceId)||value.targetEnterpriseCode!==target||value.gqxqSubjectCode!=='PU-COMPANY-'+value.sourceId||!Array.isArray(value.subjectAliases))return null;
 const subjects=snapshot.enterpriseSubjects as Array<Record<string,unknown>>|undefined;
 return subjects?.length===1&&subjects[0].subjectCode===value.gqxqSubjectCode?value:null;
}
/** Immutable wire identity may differ from a per-business local enterprise key. */
export function dispatchWireSubjectMatches(snapshot:Record<string,unknown>,target:string):boolean{
 const subjects=snapshot.enterpriseSubjects as Array<Record<string,unknown>>|undefined;
 const mapped=(snapshot.metadata as Record<string,unknown>|undefined)?.enterpriseIdentity!=null;
 return mapped?identity(snapshot,target)!==null:!!subjects&&subjects.length===1&&subjects[0].subjectCode===target;
}
/** Only original source aliases frozen with this exact assignment may return facts. */
export function dispatchCallbackSubjectMatches(snapshot:Record<string,unknown>|null,target:string,returnedCode:string):boolean{
 if(!snapshot)return returnedCode===target;
 if((snapshot.metadata as Record<string,unknown>|undefined)?.enterpriseIdentity==null)return returnedCode===target;
 const value=identity(snapshot,target);
 return !!value&&value.subjectAliases.some(alias=>alias?.status==='ACTIVE'&&typeof alias.subjectCode==='string'&&alias.subjectCode===returnedCode);
}
