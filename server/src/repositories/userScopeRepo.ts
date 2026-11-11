import type { SqlExecutor } from './userRepo';
import type { ScopeRule } from '../auth/accessScope';
export async function readUserScope(db:SqlExecutor,userId:string):Promise<{scopeVersion:number;rules:ScopeRule[]}> {
 const [rows]=await db.query('select scope_version, scope_rules from app_user where user_id = ?',[userId]) as [Array<{scope_version:unknown;scope_rules:unknown}>,unknown];
 const r=rows[0];let value:unknown=r?.scope_rules;
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{value=[];}}
 const rules:ScopeRule[]=Array.isArray(value)?value.filter((v):v is ScopeRule=>{
  if(!v||typeof v!=='object')return false;
  if(v.kind==='all')return true;
  return v.kind==='restricted'&&Array.isArray(v.enterpriseCodes)&&v.enterpriseCodes.every((s:unknown)=>typeof s==='string')&&Array.isArray(v.districtCodes)&&v.districtCodes.every((s:unknown)=>typeof s==='string');
 }):[];
 return {scopeVersion:Number(r?.scope_version??0),rules};
}
export async function saveUserScope(db:SqlExecutor,userId:string,rules:ScopeRule[]):Promise<void> {
 await db.query('update app_user set scope_rules = ?, scope_version = scope_version + 1, scope_provenance = ? where user_id = ?',[JSON.stringify(rules),'administrator-configured',userId]);
}
