import type {Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {canAccessEnterprise} from '../auth/enterpriseScope';
import {canAccessSpatialMaster,canAccessGridCoverage} from '../auth/gridScope';
import {readEnterpriseIn} from './enterpriseService';
import {readAdminIn,readCommunityIn,readGridIn,readCoverageIn,rowsIn} from '../repositories/serviceGridRepo';
import type {MasterDataContext} from '../types/masterData';
import type {ImportDetail,ImportScopeFact,ImportScopeProof,ImportScopeReference,MasterDataImportKind} from '../types/masterDataImport';

const enterpriseFact=async(tx:Tx,code:string,current=false):Promise<ImportScopeFact[]>=>{
 const e=await readEnterpriseIn(tx,code,current);return e?[{type:'enterprise',enterpriseCode:e.enterpriseCode,districtCode:e.districtCode??null}]:[];
};
const spatialFact=async(tx:Tx,code:string,current=false):Promise<ImportScopeFact>=>({type:'spatial',districtCode:(await readAdminIn(tx,code,current))?.districtCode??null});
async function memberDistricts(tx:Tx,admins:string[],communities:string[],current=false):Promise<(string|null)[]>{
 const districts:(string|null)[]=[];
 for(const code of admins)districts.push((await readAdminIn(tx,code,current))?.districtCode??null);
 for(const code of communities){const c=await readCommunityIn(tx,code,current);districts.push(c?(await readAdminIn(tx,c.adminGridCode,current))?.districtCode??null:null);}
 return districts;
}
async function referenceFacts(tx:Tx,r:ImportScopeReference,current=false):Promise<ImportScopeFact[]>{
 if(r.type==='enterprise')return enterpriseFact(tx,r.code,current);
 if(r.type==='admin'){const a=await readAdminIn(tx,r.code,current);return a?[{type:'spatial',districtCode:a.districtCode}]:[];}
 if(r.type==='community'){const c=await readCommunityIn(tx,r.code,current);return c?[await spatialFact(tx,c.adminGridCode,current)]:[];}
 if(r.type==='mapping'){
  const m=(await rowsIn(tx,'select enterprise_code from enterprise_department_mapping where source_system=? and source_department_code=?'+(current?' for update':''),[r.sourceSystem,r.sourceDepartmentCode]))[0];
  return m?enterpriseFact(tx,String(m.enterprise_code),current):[];
 }
 if(r.type==='grid_members')return [{type:'grid',enterpriseCode:r.enterpriseCode,districts:await memberDistricts(tx,r.adminCodes,r.communityCodes,current)}];
 const g=await readGridIn(tx,r.code,current);if(!g)return [];
 const coverage=await readCoverageIn(tx,g,undefined,current);
 return [...(g.import_state==='draft'?[{type:'all'} as const]:[]),{type:'grid',enterpriseCode:g.enterprise_code,districts:await memberDistricts(tx,coverage?.adminGridCodes??[],coverage?.communityCodes??[],current)}];
}

/** Capture authorization facts from actual locked objects and canonical validated
 * inputs, before commit can replace ownership. Never retain names, geometry,
 * household totals, source values, or arbitrary before JSON in the proof.
 * Every capture read is current: successful plan/prelock already hold these
 * master locks in order. Ordinary RR reads could return a pre-validator snapshot. */
export async function captureImportScopeProofs(tx:Tx,details:ImportDetail[],kind:MasterDataImportKind):Promise<ImportScopeProof[]>{
 const proofs:ImportScopeProof[]=[];
 for(const d of details){
  const p:ImportScopeProof={version:1,original:[],proposed:[],references:[]};const input=d.input;
  // An unsuccessful validator supplies no canonical ownership. Error correction
  // remains available to explicit all; restricted historical scope is unproven.
  if(['dictionary_type','dictionary_item','category'].includes(kind)){proofs.push(p);continue;}
  if(d.action==='error'){p.original=[{type:'all'}];proofs.push(p);continue;}
  if(['enterprise','household','department_mapping'].includes(kind)){
   const code=String(input.enterpriseCode);p.references.push({type:'enterprise',code});p.original.push(...await enterpriseFact(tx,code,true));
   if(kind==='enterprise'){
    const e=await readEnterpriseIn(tx,code,true);p.proposed.push({type:'enterprise',enterpriseCode:code,districtCode:'districtCode' in input?input.districtCode==null?null:String(input.districtCode):e?.districtCode??null});
   }else p.proposed.push(...await enterpriseFact(tx,code,true));
   if(kind==='department_mapping'){
    const r:ImportScopeReference={type:'mapping',sourceSystem:String(input.sourceSystem),sourceDepartmentCode:String(input.sourceDepartmentCode)};
    p.references.push(r);p.original.push(...await referenceFacts(tx,r,true));
   }
  }else if(kind==='admin_grid'||kind==='grid_boundary'){
   const code=String(input.code);const old=await readAdminIn(tx,code,true);p.references.push({type:'admin',code});if(old)p.original.push({type:'spatial',districtCode:old.districtCode});p.proposed.push({type:'spatial',districtCode:String(input.districtCode)});
  }else if(kind==='community'){
   const code=String(input.code);const old=await readCommunityIn(tx,code,true);p.references.push({type:'community',code});
   if(old){p.original.push(await spatialFact(tx,old.adminGridCode,true));p.references.push({type:'admin',code:old.adminGridCode});}
   const parent=String(input.adminGridCode);p.proposed.push(await spatialFact(tx,parent,true));p.references.push({type:'admin',code:parent});
  }else if(kind==='service_grid'||kind==='grid_coverage'){
   const code=String(input.code);const r:ImportScopeReference={type:'grid',code};p.references.push(r);p.original.push(...await referenceFacts(tx,r,true));
   const old=await readGridIn(tx,code,true);const coverage=old?await readCoverageIn(tx,old,undefined,true):null;
   if(old)p.references.push({type:'grid_members',enterpriseCode:old.enterprise_code,adminCodes:coverage?.adminGridCodes??[],communityCodes:coverage?.communityCodes??[]});
   if(kind==='service_grid')p.proposed.push({type:'all'}); // registration always requires explicit all
   else{
    const members:ImportScopeReference={type:'grid_members',enterpriseCode:String(input.enterpriseCode),adminCodes:input.adminGridCodes as string[],communityCodes:input.communityCodes as string[]};
    p.references.push(members);p.proposed.push(...await referenceFacts(tx,members,true));
   }
  }
  proofs.push(p);
 }
 return proofs;
}

function permits(ctx:MasterDataContext,f:ImportScopeFact):boolean{
 if(f.type==='all')return ctx.access.rules.some(r=>r.kind==='all');
 if(f.type==='enterprise')return canAccessEnterprise(ctx.access,f);
 if(f.type==='spatial')return canAccessSpatialMaster(ctx.access,f.districtCode);
 if(f.type==='grid')return canAccessGridCoverage(ctx.access,f.enterpriseCode,f.districts);
 return false;
}
export async function authorizeImportScopeProofs(tx:Tx,proofs:ImportScopeProof[],ctx:MasterDataContext){
 const denied=()=>AppError.notFound('批次对象不在当前授权范围内');
 // Old proposal-only proofs cannot reconstruct erased original ownership.
 if(!Array.isArray(proofs)||!proofs.length)throw denied();
 for(const p of proofs){
  if(p?.version!==1||!Array.isArray(p.original)||!Array.isArray(p.proposed)||!Array.isArray(p.references))throw denied();
  if(![...p.original,...p.proposed].every(f=>permits(ctx,f)))throw denied();
  for(const r of p.references)if(!(await referenceFacts(tx,r)).every(f=>permits(ctx,f)))throw denied();
 }
}
