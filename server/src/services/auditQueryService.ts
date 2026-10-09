import { z } from 'zod';
import { AppError } from '../http/errors';
import type { AccessContext } from '../auth/accessScope';
import { pool } from '../db/pool';
import type { SqlExecutor } from '../repositories/userRepo';
import { queryAuditLogs, findAuditLog, type AuditRow } from '../repositories/auditLogRepo';
import { toIso } from '../repositories/complaintMapper';
import { projectAuditDetail } from './complaintProjection';
import { isPermissionCode } from '../auth/permissionCatalog';
import type { AuditLogFilter, AuditLogView, Paged } from '../types/api';

export interface AuditQueryAccess extends AccessContext {permissionCodes:readonly string[]}
const text=z.string().trim().min(1).max(128).optional();
export const auditFilterSchema=z.object({
 category:z.enum(['login','operation']).optional(),from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),
 actor:text,module:text,action:text,result:z.enum(['success','failed','rejected','duplicate','unknown']).optional(),businessNo:text,
}).strict().refine(v=>!v.from||!v.to||new Date(v.from)<=new Date(v.to),{message:'开始时间不得晚于结束时间'});
const paginationSchema=z.object({page:z.number().int().min(1),size:z.number().int().min(1).max(100)})
 .refine(v=>Number.isSafeInteger((v.page-1)*v.size),{message:'分页超出安全范围'});
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
 const result=schema.safeParse(value);if(!result.success)throw AppError.validation('审计查询参数不合法',result.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));
 return result.data;
}
function authorize(access:AuditQueryAccess):void {
 if(!access?.userId||!access.permissionCodes?.includes('system.audit.read'))throw AppError.forbidden();
}
function record(value:unknown):Record<string,unknown> {
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{return {};}}
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}
function pick(value:unknown,keys:readonly string[]):Record<string,unknown> {
 const data=record(value);return Object.fromEntries(keys.filter(k=>data[k]===null||typeof data[k]==='string'||typeof data[k]==='boolean'||typeof data[k]==='number'&&Number.isFinite(data[k])).map(k=>[k,data[k]]));
}
const codeArray=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/.test(x)):[];
function accountSnapshot(value:unknown,role:boolean):Record<string,unknown> {
 const data=record(value);const projected=pick(data,role?['roleCode','name','enabled','builtIn','version']:['realName','status','scopeVersion']);
 if(Array.isArray(data.roles))projected.roles=codeArray(data.roles);
 if(role&&Array.isArray(data.permissionCodes))projected.permissionCodes=data.permissionCodes.filter((v):v is string=>typeof v==='string'&&isPermissionCode(v));
 if(Array.isArray(data.rules))projected.rules=data.rules.flatMap(value=>{
  const rule=record(value);return rule.kind==='all'?[{kind:'all'}]:rule.kind==='restricted'?[{kind:'restricted',enterpriseCodes:codeArray(rule.enterpriseCodes),districtCodes:codeArray(rule.districtCodes)}]:[];
 });
 return projected;
}
const valueFields=new Set(['address','district_code','district_name','location_lng','location_lat','business_type','complaint_type','urgency_level','is_sensitive','rule_confidence','rule_version','enterprise_code','enterprise_name','disposal_result']);
/** All responses use action-specific allowlists; stored audit evidence is untouched. */
function safeDetail(row:AuditRow):Record<string,unknown> {
 const data=record(row.detail);const action=String(row.action??'');
 if(row.biz_type==='master_import'&&['MASTER_IMPORT_COMMIT','MASTER_IMPORT_FAILED','MASTER_IMPORT_ERRORS_DOWNLOAD'].includes(action))return pick(data,['batchId','kind','templateVersion','previewVersion','created','updated','unchanged','state']);
 if(row.biz_type==='http'&&action==='ACCESS_DENIED'){
  const reason=String(data.reason??'');
  return {...pick(data,['requestId']),reasonCode:reason.includes('口令')?'PASSWORD_CHANGE_REQUIRED':reason.includes('readonly')?'READONLY_WRITE_DENIED':reason.includes('未登记')?'UNREGISTERED_ENDPOINT':'MISSING_PERMISSION'};
 }
 if(row.biz_type==='auth'&&['LOGIN','LOGIN_FAILED'].includes(action)){
  const out=pick(data,['username','requestId']);if(['unknown_user','bad_password','disabled_user'].includes(String(data.reason)))out.reason=data.reason;return out;
 }
 if(row.biz_type==='user'&&['USER_CREATE','USER_UPDATE','USER_SCOPE_UPDATE','PASSWORD_RESET','PASSWORD_CHANGE'].includes(action)||row.biz_type==='role'&&['ROLE_CREATE','ROLE_UPDATE'].includes(action)){
  const out=pick(data,['username','realName','role','status','passwordSet','forceChange','targetUserId','operator']);
  for(const key of ['before','after'])if(data[key]!==undefined)out[key]=accountSnapshot(data[key],row.biz_type==='role');
  if(Array.isArray(data.changed))out.changed=data.changed.filter(v=>['realName','roles','status'].includes(String(v)));
  return out;
 }
 if(row.biz_type==='sensitive_word'){
  if(action==='SENSITIVE_WORD_RESCAN')return {};
  if(!['SENSITIVE_WORD_CREATE','SENSITIVE_WORD_UPDATE'].includes(action))return {};
  const out=pick(data,['operator']);for(const key of ['before','after'])if(data[key]!==undefined)out[key]=pick(data[key],['word','status']);return out;
 }
 if(row.biz_type==='service_grid'&&action==='SERVICE_GRID_REGISTER')return pick(data,['code','name','enterpriseCode','businessType','state','version']);
 if(row.biz_type==='service_grid'&&action==='SERVICE_GRID_SAVE')return pick(data,['code','enterpriseCode','businessType','version','validFrom','validTo','adminGridCount','communityCount']);
 if(row.biz_type==='admin_grid'&&action==='ADMIN_GRID_SAVE')return pick(data,['code','name','districtCode','version','hasGeometry']);
 if(row.biz_type==='community'&&action==='COMMUNITY_SAVE')return pick(data,['code','name','adminGridCode','version']);
 if(row.biz_type==='enterprise'&&['ENTERPRISE_SAVE','ENTERPRISE_HOUSEHOLDS_SAVE','ENTERPRISE_MAPPING_SAVE'].includes(action))return pick(data,['enterpriseCode','enterpriseName','businessType','status','districtCode','version','households','validFrom','validTo','closedVersion','sourceSystem','sourceDepartmentCode','verified']);
 if(row.biz_type==='dictionary'&&['DICTIONARY_TYPE_SAVE','DICTIONARY_ITEM_SAVE','DICTIONARY_TYPE_DELETE','DICTIONARY_ITEM_DELETE'].includes(action))return pick(data,['typeCode','itemCode','label','parentCode','status','version','dictionaryVersion','published']);
 if(row.biz_type==='complaint'&&action==='CATEGORY_REVISE')return pick(data,['oldMajorCode','oldMinorCode','oldDictionaryVersion','majorCode','minorCode','dictionaryVersion','editVersion']);
 const out=pick(data,['assignmentId','complaintId','correctionId','eventId','eventType','taskId','approvalConclusion','statusBefore','statusAfter','dispatchStatusBefore','dispatchStatusAfter','fromStatus','toStatus','reportingStatus','supervisionStatus','supervisionStatusBefore','supervisionStatusAfter','scopeVersion','editVersion','itemCount','writtenBack','analysisEntered','analysisId','disposition','beforeCode','beforeName','afterCode','afterName','unchanged']);
 if(typeof data.fieldName==='string'&&valueFields.has(data.fieldName))Object.assign(out,projectAuditDetail({fieldName:data.fieldName,oldValue:data.oldValue,newValue:data.newValue}));
 // basis/reason/message and effectiveValues may embed source prose or a transport body.
 return out;
}
export function projectAuditLog(row:AuditRow):AuditLogView {
 const security=row.biz_type==='http'&&row.action==='ACCESS_DENIED';const rescan=row.action==='SENSITIVE_WORD_RESCAN';
 const raw=String(row.result??'');const result=normalizeAuditResult(raw);
 return {auditId:String(row.audit_id),userId:row.user_id==null?null:String(row.user_id),category:row.biz_type==='auth'&&['LOGIN','LOGIN_FAILED'].includes(String(row.action))?'login':'operation',
  appCode:row.app_code==null?null:String(row.app_code),module:security?'security':String(row.module??row.biz_type??''),action:String(row.action??''),
  bizType:security?null:row.biz_type==null?null:String(row.biz_type),bizId:security||rescan?null:row.biz_id==null?null:String(row.biz_id),
  businessNo:security||rescan?null:row.business_no==null?null:String(row.business_no),result,originalResult:raw,
  clientIp:row.client_ip==null?null:String(row.client_ip),createdAt:toIso(row.created_at),detail:safeDetail(row)};
}
export function normalizeAuditResult(value:string):AuditLogView['result'] {
 const raw=value.toLowerCase();if(['success','ok','created','updated','applied'].includes(raw))return 'success';
 if(['failure','failed','error','timeout','network_error','auth_failed'].includes(raw))return 'failed';
 if(['rejected','denied','ignored','validation_failed'].includes(raw))return 'rejected';
 if(['duplicate','duplicate_same'].includes(raw))return 'duplicate';return 'unknown';
}
export class AuditQueryService {
 constructor(private readonly db:SqlExecutor=pool){}
 async list(filter:AuditLogFilter,pagination:{page:number;size:number},access:AuditQueryAccess):Promise<Paged<AuditLogView>> {
  authorize(access);const valid=parse(auditFilterSchema,filter);const paging=parse(paginationSchema,pagination);
  const result=await queryAuditLogs(this.db,valid,paging,access);
  return {...result,content:result.content.map(projectAuditLog)};
 }
 async detail(auditId:string,access:AuditQueryAccess):Promise<AuditLogView> {
  authorize(access);const id=parse(z.string().trim().min(1).max(64),auditId);
  const row=await findAuditLog(this.db,id,access);if(!row)throw AppError.notFound('日志不存在或不在授权范围内');return projectAuditLog(row);
 }
}
export const auditQueryService=new AuditQueryService();
