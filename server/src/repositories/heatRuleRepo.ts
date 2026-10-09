import type {SqlExecutor} from './userRepo';
import {rowsIn} from './serviceGridRepo';
import type {HeatDraftInput,HeatConfirmation} from '../domain/heatRule';
export const heatCategoryKey=(major:string,minor:string|null)=>major+'|'+(minor??'');
export const heatJson=<T>(v:unknown):T=>(typeof v==='string'?JSON.parse(v):v) as T;
export async function readHeatDraft(db:SqlExecutor,id:string,lock=false){const r=(await rowsIn(db,'select rule_id,category_key,edit_version,content from heat_rule_draft where rule_id=?'+(lock?' for update':''),[id]))[0];return r?{ruleId:String(r.rule_id),categoryKey:String(r.category_key),editVersion:Number(r.edit_version),input:heatJson<HeatDraftInput>(r.content)}:null;}
export async function readHeatConfirmation(db:SqlExecutor,id:string,version:number):Promise<HeatConfirmation|null>{const r=(await rowsIn(db,'select fingerprint,truth_table,evidence_ref from heat_policy_confirmation where policy_id=? and policy_version=?',[id,version]))[0];return r?{policyVersion:version,fingerprint:String(r.fingerprint),truthTable:heatJson(r.truth_table),evidenceRef:String(r.evidence_ref)}:null;}
export async function readPublishedHeat(db:SqlExecutor,categoryKey:string,day:string){return (await rowsIn(db,'select version_id,content from heat_rule_published where category_key=? and effective_from<=? order by effective_from desc limit 1',[categoryKey,day]))[0]??null;}
