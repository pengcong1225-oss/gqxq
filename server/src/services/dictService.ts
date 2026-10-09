import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction, type Tx } from '../db/tx';
import type { SqlExecutor } from '../repositories/userRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import { buildComplaintScopeSql } from '../auth/accessScope';
import { DICT } from '../domain/enums';
import { AppError } from '../http/errors';
import type { DictionaryType, DictionaryItem, DictionaryChange, MasterDataContext, SaveItemInput, SaveTypeInput } from '../types/masterData';

export const STATE_TYPES = ['status','correction_status','supervision_status','reporting_status','source_event_status','dispatch_type','trigger_type','intake_result'];
export const FIXED_TYPES = ['business_type','complaint_type','urgency_level'];
const codeSchema=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const itemCodeSchema=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const versionSchema=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const saveTypeSchema=z.object({code:codeSchema,name:z.string().trim().min(1).max(128),expectedVersion:versionSchema,status:z.enum(['enabled','disabled']).optional(),published:z.boolean().optional(),cascadeDisable:z.boolean().optional()}).strict();
export const saveItemSchema=z.object({typeCode:codeSchema,code:itemCodeSchema,label:z.string().trim().min(1).max(128),expectedVersion:versionSchema,expectedTypeVersion:versionSchema.optional(),parentCode:itemCodeSchema.nullable().optional(),sort:z.number().int().min(-1000000).max(1000000).optional(),status:z.enum(['enabled','disabled']).optional(),published:z.boolean().optional(),cascadeDisable:z.boolean().optional()}).strict();
export function parseDictionaryInput<T>(schema:z.ZodType<T>,value:unknown):T {
 const result=schema.safeParse(value);if(!result.success)throw AppError.validation('字典参数不合法',result.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));return result.data;
}
export function assertMasterPermission(ctx:MasterDataContext):void {if(!ctx.userId||!ctx.permissionCodes.includes('system.dict.manage'))throw AppError.forbidden();}
export function assertMutableType(code:string):void {
 if(STATE_TYPES.includes(code))throw AppError.forbidden('状态机枚举只读，不能由字典维护修改');
 if(code==='sensitive_word')throw AppError.validation('敏感词须使用专用维护入口');
}
type HierarchyItem=Pick<DictionaryItem,'code'|'parentCode'|'status'>;
/** Two levels only. This is also the import validator; no automatic reparent/cascade. */
export function validateItemHierarchy(input:HierarchyItem,items:readonly HierarchyItem[]):void {
 if(!input.parentCode)return;
 if(input.parentCode===input.code)throw AppError.validation('父子关系不能成环');
 const parent=items.find(i=>i.code===input.parentCode);
 if(!parent)throw AppError.validation('父项不存在');
 if(parent.parentCode)throw AppError.validation('字典仅支持两级，不能形成环或第三层');
 if(items.some(i=>i.parentCode===input.code))throw AppError.validation('已有子项的父项不能改为小类（两级限制）');
 if(input.status==='enabled'&&parent.status!=='enabled')throw AppError.validation('停用父项不能保留启用子项');
}
const typeColumns='dict_type as code,dict_name as name,status,version,published';
const itemColumns='item_id as itemId,dict_type as typeCode,item_value as code,item_label as label,parent_code as parentCode,sort_order as sort,status,version,published';
function typeView(r:Record<string,unknown>):DictionaryType {return {code:String(r.code),name:String(r.name),status:r.status==='enabled'?'enabled':'disabled',version:Number(r.version),published:Boolean(Number(r.published)),readOnly:STATE_TYPES.includes(String(r.code)),fixedCodes:FIXED_TYPES.includes(String(r.code))};}
function itemView(r:Record<string,unknown>):DictionaryItem {return {itemId:String(r.itemId),typeCode:String(r.typeCode),code:String(r.code),label:String(r.label),parentCode:r.parentCode==null?null:String(r.parentCode),sort:Number(r.sort),status:r.status==='enabled'?'enabled':'disabled',version:Number(r.version),published:Boolean(Number(r.published))};}
export async function readDictionaryType(db:SqlExecutor,code:string,lock=false):Promise<DictionaryType|null> {
 const [rows]=await db.query('select '+typeColumns+' from dict_type where dict_type = ?'+(lock?' for update':''),[code]) as [Record<string,unknown>[],unknown];return rows[0]?typeView(rows[0]):null;
}
export async function readDictionaryItems(db:SqlExecutor,code:string,lock=false):Promise<DictionaryItem[]> {
 const [rows]=await db.query('select '+itemColumns+' from dict_item where dict_type = ? order by item_value'+(lock?' for update':''),[code]) as [Record<string,unknown>[],unknown];return rows.map(itemView).sort((a,b)=>a.sort-b.sort||a.code.localeCompare(b.code));
}
async function reserveCode(tx:Tx,typeCode:string,itemCode:string):Promise<void> {
 try{await tx.execute('insert into dictionary_code_registry (type_code,item_code) values (?,?)',[typeCode,itemCode]);}
 catch(e){if((e as {code?:string}).code==='ER_DUP_ENTRY')throw AppError.conflict('编码已使用或曾使用，不能重复使用');throw e;}
}
async function snapshot(tx:Tx,type:DictionaryType):Promise<void> {
 const items=await readDictionaryItems(tx,type.code);
 await tx.execute('insert into dictionary_version (type_code,version,snapshot,created_at) values (?,?,?,?)',[type.code,type.version,JSON.stringify({type,items}),new Date()]);
}
async function audit(tx:Tx,action:string,key:string,type:DictionaryType,ctx:MasterDataContext,item?:DictionaryItem):Promise<void> {
 await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:type.code,action,bizType:'dictionary',bizId:key,result:'success',clientIp:ctx.clientIp,createdAt:new Date(),detail:{typeCode:type.code,itemCode:item?.code??null,label:item?.label??type.name,parentCode:item?.parentCode??null,status:item?.status??type.status,version:item?.version??type.version,dictionaryVersion:type.version,published:item?.published??type.published}});
}
/** Lock order for all B4 operations: type -> all items by stable code -> dependencies/history -> mutation/audit. */
export class DictionaryService {
 async listTypes(ctx:MasterDataContext):Promise<DictionaryType[]> {
  assertMasterPermission(ctx);const [rows]=await pool.query('select '+typeColumns+' from dict_type order by dict_type') as unknown as [Record<string,unknown>[],unknown];
  const types=rows.map(typeView).filter(t=>t.code!=='sensitive_word');
  for(const code of STATE_TYPES)if(!types.some(t=>t.code===code))types.push({code,name:code,status:'enabled',version:0,published:true,readOnly:true,fixedCodes:false});return types;
 }
 async items(code:string,ctx:MasterDataContext):Promise<{type:DictionaryType;items:DictionaryItem[]}> {
  assertMasterPermission(ctx);const type=await readDictionaryType(pool,code);
  if(STATE_TYPES.includes(code))return {type:type??{code,name:code,status:'enabled',version:0,published:true,readOnly:true,fixedCodes:false},items:Object.entries((DICT as Record<string,Record<string,string>>)[code]??{}).map(([value,label])=>({itemId:value,typeCode:code,code:value,label,parentCode:null,sort:0,status:'enabled',version:0,published:true}))};
  if(!type)throw AppError.notFound('字典类型不存在');return {type,items:await readDictionaryItems(pool,code)};
 }
 async saveType(input:SaveTypeInput,ctx:MasterDataContext) {return withTransaction(tx=>this.saveTypeInTx(tx,input,ctx));}
 async validateTypeInTx(tx:Tx,raw:SaveTypeInput,ctx:MasterDataContext) {
  assertMasterPermission(ctx);const input=parseDictionaryInput(saveTypeSchema,raw);assertMutableType(input.code);
  const before=await readDictionaryType(tx,input.code,true);
  if((before?.version??0)!==input.expectedVersion)throw AppError.conflict('字典版本已变化，请刷新核对');
  const type:DictionaryType={code:input.code,name:input.name,status:input.status??before?.status??'enabled',version:before?.version??0,published:before?.published||input.published===true,readOnly:false,fixedCodes:FIXED_TYPES.includes(input.code)};
  const items=before?await readDictionaryItems(tx,input.code,true):[];
  if(type.status==='disabled'&&items.some(i=>i.status==='enabled')&&!input.cascadeDisable)throw AppError.validation('停用类型需明确确认停用全部子项');
  return {input,before,type,items,dependency:{typeCode:type.code,version:before?.version??0}};
 }
 async saveTypeInTx(tx:Tx,raw:SaveTypeInput,ctx:MasterDataContext):Promise<DictionaryChange<DictionaryType>> {
  const {input,before,type,items}=await this.validateTypeInTx(tx,raw,ctx);
  if(before&&type.name===before.name&&type.status===before.status&&type.published===before.published)return {key:type.code,changed:false,version:type.version,dictionaryVersion:type.version,value:type};
  if(type.status==='disabled'&&items.some(i=>i.status==='enabled')){
   if(!input.cascadeDisable)throw AppError.validation('停用类型需明确确认停用全部子项');
   await tx.execute("update dict_item set status='disabled',version=version+1 where dict_type=? and status='enabled'",[type.code]);
  }
  if(!before){await reserveCode(tx,type.code,'');type.version=1;await tx.execute('insert into dict_type (dict_type,dict_name,status,version,published) values (?,?,?,?,?)',[type.code,type.name,type.status,type.version,Number(type.published)]);}
  else{type.version++;await tx.execute('update dict_type set dict_name=?,status=?,version=?,published=? where dict_type=?',[type.name,type.status,type.version,Number(type.published),type.code]);}
  await snapshot(tx,type);await audit(tx,'DICTIONARY_TYPE_SAVE',type.code,type,ctx);
  return {key:type.code,changed:true,version:type.version,dictionaryVersion:type.version,value:type};
 }
 /** Validates inside caller transaction; locks stay held for a following saveItemInTx. */
 async validateItemInTx(tx:Tx,raw:SaveItemInput,ctx:MasterDataContext) {
  assertMasterPermission(ctx);const input=parseDictionaryInput(saveItemSchema,raw);assertMutableType(input.typeCode);
  const type=await readDictionaryType(tx,input.typeCode,true);if(!type)throw AppError.notFound('字典类型不存在');
  if(input.expectedTypeVersion!==undefined&&input.expectedTypeVersion!==type.version)throw AppError.conflict('字典依赖版本已变化');
  const items=await readDictionaryItems(tx,input.typeCode,true);const before=items.find(i=>i.code===input.code);
  if((before?.version??0)!==input.expectedVersion)throw AppError.conflict('条目版本已变化，请刷新核对');
  const item:DictionaryItem={itemId:before?.itemId??'DICT-'+randomUUID(),typeCode:type.code,code:input.code,label:input.label,parentCode:input.parentCode===undefined?before?.parentCode??null:input.parentCode,sort:input.sort??before?.sort??0,status:input.status??before?.status??'enabled',version:before?.version??0,published:before?.published||input.published===true};
  if(type.fixedCodes&&(!Object.hasOwn((DICT as Record<string,Record<string,string>>)[type.code]??{},item.code)||item.parentCode))throw AppError.validation('协议编码固定，仅可维护合法码标签、排序和停用');
  if(item.status==='enabled'&&type.status!=='enabled')throw AppError.validation('字典类型已停用');
  validateItemHierarchy(item,items);
  const parent=item.parentCode?items.find(i=>i.code===item.parentCode):null;
  if(item.published&&parent&&!parent.published)throw AppError.validation('小类发布前需发布父项');
  const children=items.filter(i=>i.parentCode===item.code&&i.status==='enabled');
  if(item.status==='disabled'&&children.length&&!input.cascadeDisable)throw AppError.validation('停用父项需明确确认同时停用子项');
  return {input,type,item,before,children,dependency:{typeCode:type.code,version:type.version,parentCode:parent?.code??null,parentVersion:parent?.version??null}};
 }
 async saveItem(input:SaveItemInput,ctx:MasterDataContext) {return withTransaction(tx=>this.saveItemInTx(tx,input,ctx));}
 async saveItemInTx(tx:Tx,raw:SaveItemInput,ctx:MasterDataContext):Promise<DictionaryChange<DictionaryItem>> {
  const {input,type,item,before}=await this.validateItemInTx(tx,raw,ctx);
  if(before&&['label','parentCode','sort','status','published'].every(k=>before[k as keyof DictionaryItem]===item[k as keyof DictionaryItem]))return {key:type.code+':'+item.code,changed:false,version:item.version,dictionaryVersion:type.version,value:item};
  if(!before)await reserveCode(tx,type.code,item.code);
  item.version++;
  if(!before)await tx.execute('insert into dict_item (item_id,dict_type,item_value,item_label,parent_code,sort_order,status,version,published) values (?,?,?,?,?,?,?,?,?)',[item.itemId,type.code,item.code,item.label,item.parentCode,item.sort,item.status,item.version,Number(item.published)]);
  else await tx.execute('update dict_item set item_label=?,parent_code=?,sort_order=?,status=?,version=?,published=? where dict_type=? and item_value=?',[item.label,item.parentCode,item.sort,item.status,item.version,Number(item.published),type.code,item.code]);
  if(item.status==='disabled'&&input.cascadeDisable)await tx.execute("update dict_item set status='disabled',version=version+1 where dict_type=? and parent_code=? and status='enabled'",[type.code,item.code]);
  type.version++;await tx.execute('update dict_type set version=? where dict_type=?',[type.version,type.code]);
  await snapshot(tx,type);await audit(tx,'DICTIONARY_ITEM_SAVE',type.code+':'+item.code,type,ctx,item);
  return {key:type.code+':'+item.code,changed:true,version:item.version,dictionaryVersion:type.version,value:item};
 }
 async setItemStatus(typeCode:string,code:string,enabled:boolean,expectedVersion:number,ctx:MasterDataContext,cascadeDisable=false) {
  return withTransaction(async tx=>{const type=await readDictionaryType(tx,typeCode,true);if(!type)throw AppError.notFound('字典类型不存在');const items=await readDictionaryItems(tx,typeCode,true);const item=items.find(i=>i.code===code);if(!item)throw AppError.notFound('字典项不存在');return this.saveItemInTx(tx,{typeCode,code,label:item.label,status:enabled?'enabled':'disabled',expectedVersion,cascadeDisable},ctx);});
 }
 async references(typeCode:string,code:string|null,ctx:MasterDataContext) {
  assertMasterPermission(ctx);const scope=buildComplaintScopeSql(ctx.access,'c');const ref=referencePredicate(typeCode,code,'c');
  const [rows]=await pool.query('select c.complaint_id as complaintId,c.complaint_no as complaintNo from complaint c where '+ref.sql+' and '+scope.sql+' order by c.complaint_id limit 100',[...ref.params,...scope.params]);
  const items=await readDictionaryItems(pool,typeCode);return {complaints:rows,children:items.filter(i=>code===null||i.parentCode===code).map(i=>i.code),limited:true};
 }
 async deleteItem(typeCode:string,code:string,expectedVersion:number,ctx:MasterDataContext) {return withTransaction(tx=>this.deleteInTx(tx,typeCode,code,expectedVersion,ctx));}
 async deleteType(typeCode:string,expectedVersion:number,ctx:MasterDataContext) {return withTransaction(tx=>this.deleteInTx(tx,typeCode,null,expectedVersion,ctx));}
 async deleteInTx(tx:Tx,typeCode:string,code:string|null,expectedVersion:number,ctx:MasterDataContext):Promise<{key:string;changed:true}> {
  assertMasterPermission(ctx);assertMutableType(typeCode);if(FIXED_TYPES.includes(typeCode)||typeCode==='complaint_category'&&code===null)throw AppError.validation('正式或协议字典类型不能删除');
  const type=await readDictionaryType(tx,typeCode,true);if(!type)throw AppError.notFound('字典类型不存在');
  const items=await readDictionaryItems(tx,typeCode,true);const target=code===null?type:items.find(i=>i.code===code);if(!target)throw AppError.notFound('字典项不存在');
  if(target.version!==expectedVersion)throw AppError.conflict('字典版本已变化');
  if(target.published)throw AppError.conflict('已发布条目须停用并保留历史');
  if(items.some(i=>code===null||i.parentCode===code))throw AppError.conflict('存在子项，不能删除');
  const ref=referencePredicate(typeCode,code,'c');const [references]=await tx.query('select c.complaint_id from complaint c where '+ref.sql+' order by c.complaint_id limit 1 for update',ref.params);
  if((references as unknown[]).length)throw AppError.conflict('存在历史引用，不能删除');
  if(code===null)await tx.execute('delete from dict_type where dict_type=?',[typeCode]);
  else{await tx.execute('delete from dict_item where dict_type=? and item_value=?',[typeCode,code]);type.version++;await tx.execute('update dict_type set version=? where dict_type=?',[type.version,typeCode]);await snapshot(tx,type);}
  await audit(tx,code===null?'DICTIONARY_TYPE_DELETE':'DICTIONARY_ITEM_DELETE',typeCode+(code?':'+code:''),type,ctx,code===null?undefined:target as DictionaryItem);
  return {key:typeCode+(code?':'+code:''),changed:true};
 }
}
/** Current and explicit category history references remain protected even after soft delete. */
function referencePredicate(typeCode:string,code:string|null,alias:string):{sql:string;params:unknown[]} {
 if(typeCode==='complaint_category')return {sql:'('+alias+'.major_category_code '+(code===null?'is not null':'= ?')+' or '+alias+'.minor_category_code '+(code===null?'is not null':'= ?')+' or '+alias+'.source_major_category_code '+(code===null?'is not null':'= ?')+' or '+alias+'.source_minor_category_code '+(code===null?'is not null':'= ?')+' or exists (select 1 from complaint_category_revision cr where cr.complaint_id='+alias+'.complaint_id'+(code===null?'':' and (cr.major_code=? or cr.minor_code=? or cr.old_major_code=? or cr.old_minor_code=?)')+'))',params:code===null?[]:Array(8).fill(code)};
 const column:Record<string,string>={business_type:'business_type',complaint_type:'complaint_type',urgency_level:'urgency_level',source_system:'source_system',district:'district_code'};
 return column[typeCode]?{sql:alias+'.'+column[typeCode]+(code===null?' is not null':' = ?'),params:code===null?[]:[code]}:{sql:'0 = 1',params:[]};
}
export const dictionaryService=new DictionaryService();
