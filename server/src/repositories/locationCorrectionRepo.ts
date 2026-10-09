import type {Tx} from '../db/tx';
import type {MasterDataContext} from '../types/masterData';
import type {LocationFacts,LocationCorrectionOptions} from '../types/locationCorrection';
import {readAdminIn,readCommunityIn,readGridIn,readCoverageIn,rowsIn} from './serviceGridRepo';
import {canAccessComplaint,assertComplaintAccess} from '../auth/accessScope';
import {canAccessGridCoverage} from '../auth/gridScope';
import {AppError} from '../http/errors';
export interface LocationComplaint extends Record<string,unknown> {complaint_id:string;enterprise_code:string|null;district_code:string|null;business_type:string}
/** Minimal business selection under complaint scope, not grid-management permission. */
export async function readLocationOptionsIn(tx:Tx,row:LocationComplaint,ctx:MasterDataContext,districts:LocationCorrectionOptions['districts']):Promise<LocationCorrectionOptions> {
 assertComplaintAccess(row,ctx.access);
 const admins=await rowsIn(tx,'select code,name,district_code from admin_grid order by code');
 const allowed=admins.filter(a=>canAccessComplaint(ctx.access,{...row,district_code:a.district_code}));
 const communities=await rowsIn(tx,'select code,name,admin_grid_code from community order by code');
 return {districts:districts.filter(d=>canAccessComplaint(ctx.access,{...row,district_code:d.code})),
  adminGrids:allowed.map(a=>({code:String(a.code),name:String(a.name),districtCode:String(a.district_code)})),
  communities:communities.filter(c=>allowed.some(a=>a.code===c.admin_grid_code)).map(c=>({code:String(c.code),name:String(c.name),adminGridCode:String(c.admin_grid_code)}))};
}
/** Master order: dictionary (caller) -> enterprise -> admin -> community -> grid/revision -> complaint (caller).
 * Enterprise lock freezes coverage writers before dependency discovery. All final evidence uses locked/current reads. */
export async function lockLocationFactsIn(tx:Tx,probe:LocationComplaint,adminCode:string|null,communityCode:string|null,date:string,ctx:MasterDataContext):Promise<LocationFacts> {
 if(probe.enterprise_code)await rowsIn(tx,'select enterprise_code from enterprise where enterprise_code=? for update',[probe.enterprise_code]);
 const gridKeys=await rowsIn(tx,'select g.grid_code from service_grid g join grid_enterprise ge on ge.grid_code=g.grid_code where ge.enterprise_code=? and g.business_type=? order by g.grid_code',[probe.enterprise_code??'',probe.business_type]);
 const adminKeys=new Set<string>(adminCode?[adminCode]:[]),communityKeys=new Set<string>(communityCode?[communityCode]:[]);
 const grids=[];
 for(const k of gridKeys){
  const g=await readGridIn(tx,String(k.grid_code));if(!g)continue;grids.push(g);
  const current=await readCoverageIn(tx,g);const effective=await readCoverageIn(tx,g,date);
  for(const cov of [current,effective])if(cov){for(const code of cov.adminGridCodes)adminKeys.add(code);for(const code of cov.communityCodes)communityKeys.add(code);}
 }
 const communityProbe=communityCode?await readCommunityIn(tx,communityCode):null;
 if(communityProbe)adminKeys.add(communityProbe.adminGridCode);
 const admins:LocationFacts['admins']=[];for(const code of [...adminKeys].sort()){const value=await readAdminIn(tx,code,true);if(value)admins.push(value);}
 const communities=[];for(const code of [...communityKeys].sort()){const value=await readCommunityIn(tx,code,true);if(value)communities.push(value);}
 if(communityProbe&&communities.find(c=>c.code===communityCode)?.adminGridCode!==communityProbe.adminGridCode)throw AppError.conflict('小区父级已变化，请刷新核对');
 const coverages=[];
 for(const prior of grids){
  const g=await readGridIn(tx,prior.grid_code,true);if(!g||g.enterprise_code!==probe.enterprise_code||g.business_type!==probe.business_type)throw AppError.conflict('覆盖归属已变化，请刷新核对');
  const current=await readCoverageIn(tx,g,undefined,true),effective=await readCoverageIn(tx,g,date,true);
  const currentDistricts=(current?.adminGridCodes??[]).map(c=>admins.find(a=>a.code===c)?.districtCode??null);
  if(!canAccessGridCoverage(ctx.access,g.enterprise_code,currentDistricts))continue;
  if(effective){
   if(effective.adminGridCodes.some(c=>!adminKeys.has(c))||effective.communityCodes.some(c=>!communityKeys.has(c)))throw AppError.conflict('覆盖依赖已变化，请刷新核对');
   const districts=effective.adminGridCodes.map(c=>admins.find(a=>a.code===c)?.districtCode??null);
   if(canAccessGridCoverage(ctx.access,g.enterprise_code,districts))coverages.push(effective);
  }
 }
 // Only members usable under this complaint selector can become public candidates.
 const allowedAdmins=admins.filter(a=>canAccessComplaint(ctx.access,{...probe,district_code:a.districtCode}));
 return {districtName:null,admins:allowedAdmins,communities:communities.filter(c=>allowedAdmins.some(a=>a.code===c.adminGridCode)),coverages};
}
