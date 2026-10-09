import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction, type Tx } from '../db/tx';
import type { SqlExecutor } from '../repositories/userRepo';
import type { CategoryRef, MasterDataContext } from '../types/masterData';
import { readDictionaryType, readDictionaryItems } from './dictService';
import { assertComplaintAccess, buildComplaintScopeSql } from '../auth/accessScope';
import { insertFieldVersions } from '../repositories/complaintFieldVersionRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import { parseFieldState } from '../domain/effectiveFieldPolicy';
import { AppError } from '../http/errors';

export const CATEGORY_TYPE='complaint_category';
const code=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const categoryRefSchema=z.object({majorCode:code,minorCode:code.nullable(),dictionaryVersion:z.string().regex(/^[1-9][0-9]*$/)}).strict();
export function parseCategoryRef(input:unknown):CategoryRef {const parsed=categoryRefSchema.safeParse(input);if(!parsed.success)throw AppError.validation('正式分类必须提供大类、小类及字典版本');return parsed.data;}
export const CATEGORY_COLUMNS=['major_category_code','minor_category_code','category_dictionary_version'] as const;
export async function validateCategoryInTx(db:SqlExecutor,raw:CategoryRef,options:{forNewSelection:boolean}):Promise<void> {
 const ref=parseCategoryRef(raw);const type=await readDictionaryType(db,CATEGORY_TYPE,options.forNewSelection);
 if(!type)throw AppError.validation('正式分类字典不存在');
 let items=await readDictionaryItems(db,CATEGORY_TYPE,options.forNewSelection);
 if(options.forNewSelection){if(String(type.version)!==ref.dictionaryVersion)throw AppError.conflict('分类字典已变化，请重新读取选择');if(type.status!=='enabled')throw AppError.validation('分类字典已停用');}
 else if(String(type.version)!==ref.dictionaryVersion){
  const [rows]=await db.query('select snapshot from dictionary_version where type_code=? and version=?',[CATEGORY_TYPE,ref.dictionaryVersion]) as [Array<{snapshot:unknown}>,unknown];
  if(!rows[0])throw AppError.validation('历史分类字典版本不存在');let value=rows[0].snapshot;if(typeof value==='string')value=JSON.parse(value);items=(value as {items:typeof items}).items;
 }
 const major=items.find(i=>i.code===ref.majorCode);const minor=ref.minorCode?items.find(i=>i.code===ref.minorCode):null;
 if(!major||major.parentCode!==null||ref.minorCode&&(!minor||minor.parentCode!==major.code))throw AppError.validation('分类大类或父子关系不合法');
 if(options.forNewSelection&&(!major.published||major.status!=='enabled'||minor&&(!minor.published||minor.status!=='enabled')))throw AppError.validation('未发布或停用分类不可用于新选择');
}
export async function validateCategory(ref:CategoryRef,options:{forNewSelection:boolean}):Promise<void> {return withTransaction(tx=>validateCategoryInTx(tx,ref,options));}
export async function categoryOptions() {
 const type=await readDictionaryType(pool,CATEGORY_TYPE);if(!type)throw AppError.notFound('正式分类字典不存在');
 const items=await readDictionaryItems(pool,CATEGORY_TYPE);return {dictionaryVersion:String(type.version),items:type.status==='enabled'?items.filter(i=>i.published&&i.status==='enabled'&&(!i.parentCode||items.some(p=>p.code===i.parentCode&&p.published&&p.status==='enabled'))):[]};
}
export interface CategoryRevisionInput {complaintId:string;category:CategoryRef;expectedVersion:number;basis:string}
/** Mutation only, inside A1 caller's transaction and locked complaint. Does not start a transaction or bump edit version itself. */
export async function writeCategoryInTx(tx:Tx,complaint:Record<string,unknown>,raw:CategoryRef,ctx:MasterDataContext,basis:string,now:Date,options:{pendingCorrectionId?:string}={}):Promise<boolean> {
 if(!ctx.userId||!ctx.permissionCodes.includes('complaint.correct'))throw AppError.forbidden();assertComplaintAccess(complaint,ctx.access);
 const ref=parseCategoryRef(raw);await validateCategoryInTx(tx,ref,{forNewSelection:true});
 if(complaint.major_category_code===ref.majorCode&&(complaint.minor_category_code??null)===ref.minorCode&&complaint.category_dictionary_version===ref.dictionaryVersion)return false;
 await assertCategoryAnalysisGate(tx,String(complaint.complaint_id),options.pendingCorrectionId,Number(complaint.analysis_included)===1);
 const nextVersion=Number(complaint.edit_version)+1;
 await tx.execute('update complaint set major_category_code=?,minor_category_code=?,category_dictionary_version=?,updated_at=? where complaint_id=?',[ref.majorCode,ref.minorCode,ref.dictionaryVersion,now,String(complaint.complaint_id)]);
 await tx.execute('insert into complaint_category_revision (revision_id,complaint_id,old_major_code,old_minor_code,old_dictionary_version,major_code,minor_code,dictionary_version,edit_version,operator_id,basis,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)',['CAT-'+randomUUID(),String(complaint.complaint_id),complaint.major_category_code==null?null:String(complaint.major_category_code),complaint.minor_category_code==null?null:String(complaint.minor_category_code),complaint.category_dictionary_version==null?null:String(complaint.category_dictionary_version),ref.majorCode,ref.minorCode,ref.dictionaryVersion,nextVersion,ctx.userId,basis,now]);
 const values=[ref.majorCode,ref.minorCode,ref.dictionaryVersion];
 await insertFieldVersions(tx,CATEGORY_COLUMNS.map((column,index)=>({complaintId:String(complaint.complaint_id),fieldName:column,oldValue:complaint[column]==null?null:String(complaint[column]),newValue:values[index],changeSource:'manual_edit',reason:basis,operatorId:ctx.userId,operatorName:ctx.userName,changedAt:now})));
 await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:String(complaint.complaint_no),action:'CATEGORY_REVISE',bizType:'complaint',bizId:String(complaint.complaint_id),result:'success',clientIp:ctx.clientIp,createdAt:now,detail:{oldMajorCode:complaint.major_category_code??null,oldMinorCode:complaint.minor_category_code??null,oldDictionaryVersion:complaint.category_dictionary_version??null,majorCode:ref.majorCode,minorCode:ref.minorCode,dictionaryVersion:ref.dictionaryVersion,editVersion:nextVersion}});
 return true;
}
export async function reviseCategoryInTx(tx:Tx,input:CategoryRevisionInput,ctx:MasterDataContext) {
 if(!ctx.userId||!ctx.permissionCodes.includes('complaint.correct'))throw AppError.forbidden();
 if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||typeof input.basis!=='string'||!input.basis.trim()||input.basis.length>500)throw AppError.validation('分类纠偏需要有效编辑版本和核对依据');
 // Shared order: dictionary type/items -> complaint -> correction/history/audit.
 await validateCategoryInTx(tx,input.category,{forNewSelection:true});
 const [rows]=await tx.query('select complaint_id,complaint_no,enterprise_code,district_code,deleted,edit_version,effective_field_state,major_category_code,minor_category_code,category_dictionary_version,analysis_included from complaint where complaint_id=? for update',[input.complaintId]) as unknown as [Record<string,unknown>[],unknown];
 const row=rows[0];if(!row)throw AppError.notFound('诉求不存在');assertComplaintAccess(row,ctx.access);
 if(Number(row.edit_version)!==input.expectedVersion)throw AppError.conflict('该诉求已被其它窗口修改；请刷新核对后重新提交');
 const changed=await writeCategoryInTx(tx,row,input.category,ctx,input.basis.trim(),new Date());
 const editVersion=input.expectedVersion+(changed?1:0);
 if(changed){const state=parseFieldState(row.effective_field_state);const ref=parseCategoryRef(input.category);for(const [i,column] of CATEGORY_COLUMNS.entries())state[column]={resolution:'confirmed',value:[ref.majorCode,ref.minorCode,ref.dictionaryVersion][i],version:editVersion,reason:'人工分类纠偏'};
  await tx.execute('update complaint set effective_field_state=?,edit_version=? where complaint_id=?',[JSON.stringify(state),editVersion,input.complaintId]);}
 return {complaintId:input.complaintId,category:parseCategoryRef(input.category),editVersion,changed};
}
/** Locking current reads also work after an importer has opened a consistent snapshot. */
async function assertCategoryAnalysisGate(tx:Tx,complaintId:string,pendingCorrectionId?:string,flagged=false):Promise<void> {
 const [analysis]=await tx.query('select analysis_id from analysis_record where complaint_id=? limit 1 for update',[complaintId]);
 if(!(analysis as unknown[]).length&&!flagged)return;
 const [items]=await tx.query('select correction_id,status from correction_item where complaint_id=? order by correction_id for update',[complaintId]) as unknown as [Array<{correction_id:string;status:string|null}>,unknown];
 const [dispatch]=await tx.query('select assignment_id from dispatch_order where complaint_id=? limit 1 for update',[complaintId]);
 if(items.some(i=>i.correction_id!==pendingCorrectionId&&!['confirmed','rejected'].includes(i.status??''))||!(dispatch as unknown[]).length)throw AppError.conflict('已入分析库的重分类仍须全部纠偏已处理且曾有交办');
}
export async function reviseCategory(input:CategoryRevisionInput,ctx:MasterDataContext) {return withTransaction(tx=>reviseCategoryInTx(tx,input,ctx));}
/** Explicit revision interface for D1/D3; never claims future report artifacts exist. */
export async function categoryHistory(complaintId:string,ctx:MasterDataContext) {
 const scope=buildComplaintScopeSql(ctx.access,'c');const [rows]=await pool.query('select cr.revision_id as revisionId,cr.old_major_code as oldMajorCode,cr.old_minor_code as oldMinorCode,cr.old_dictionary_version as oldDictionaryVersion,cr.major_code as majorCode,cr.minor_code as minorCode,cr.dictionary_version as dictionaryVersion,cr.edit_version as editVersion,cr.created_at as createdAt from complaint_category_revision cr join complaint c on c.complaint_id=cr.complaint_id where cr.complaint_id=? and '+scope.sql+' order by cr.id',[complaintId,...scope.params]);return rows;
}
