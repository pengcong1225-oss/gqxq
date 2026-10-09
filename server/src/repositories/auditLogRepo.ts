// operation_audit_log（追加写）：操作审计。
// 复用既有表（迁移设计 §3.3）：不新建 audit_log。
// 列：audit_id / user_id / app_code / resource_code / action / biz_type / biz_id / result / client_ip / detail / created_at
import { randomUUID } from 'node:crypto';
import type { Queryable } from './complaintSourceLogRepo';
import { cut } from './complaintSourceLogRepo';
import { buildComplaintScopeSql, type AccessContext } from '../auth/accessScope';
import type { SqlExecutor } from './userRepo';
import type { AuditLogFilter, Paged } from '../types/api';

export type AuditResult = 'success' | 'duplicate' | 'rejected' | 'failed';

export interface AuditEntry {
  /** 外部系统投递没有平台用户，可为 null */
  userId: string | null;
  appCode: string | null;
  resourceCode: string | null;
  action: string;
  bizType: string | null;
  bizId: string | null;
  result: AuditResult;
  clientIp: string | null;
  /** 结构化明细，序列化成 JSON 文本落 detail */
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export async function insertAudit(db: Queryable, entry: AuditEntry): Promise<string> {
  const auditId = 'AUD-' + randomUUID();
  await db.execute(
    'insert into operation_audit_log ' +
      '(audit_id, user_id, app_code, resource_code, action, biz_type, biz_id, result, client_ip, detail, created_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      auditId,
      cut(entry.userId, 64),
      cut(entry.appCode, 64),
      cut(entry.resourceCode, 128),
      cut(entry.action, 64),
      cut(entry.bizType, 64),
      cut(entry.bizId, 128),
      entry.result,
      cut(entry.clientIp, 64),
      entry.detail === null ? null : JSON.stringify(entry.detail),
      entry.createdAt,
    ]
  );
  return auditId;
}

export type AuditRow = Record<string,unknown>;
const categorySql="case when a.biz_type = 'auth' and a.action in ('LOGIN','LOGIN_FAILED') then 'login' else 'operation' end";
const resultSql="case when lower(a.result) in ('success','ok','created','updated','applied') then 'success' when lower(a.result) in ('failure','failed','error','timeout','network_error','auth_failed') then 'failed' when lower(a.result) in ('rejected','denied','ignored','validation_failed') then 'rejected' when lower(a.result) in ('duplicate','duplicate_same') then 'duplicate' else 'unknown' end";
const moduleSql="case when a.biz_type = 'http' and a.action = 'ACCESS_DENIED' then 'security' when a.action like 'CORRECTION\\_%' then 'corrections' else a.biz_type end";
const systemSql="((a.biz_type = 'auth' and a.action in ('LOGIN','LOGIN_FAILED')) or (a.biz_type = 'user' and a.action in ('USER_CREATE','USER_UPDATE','USER_SCOPE_UPDATE','PASSWORD_RESET','PASSWORD_CHANGE')) or (a.biz_type = 'role' and a.action in ('ROLE_CREATE','ROLE_UPDATE')) or (a.biz_type = 'sensitive_word' and a.action in ('SENSITIVE_WORD_CREATE','SENSITIVE_WORD_UPDATE','SENSITIVE_WORD_RESCAN')) or (a.biz_type = 'dictionary' and a.action in ('DICTIONARY_TYPE_SAVE','DICTIONARY_ITEM_SAVE','DICTIONARY_TYPE_DELETE','DICTIONARY_ITEM_DELETE')) or (a.biz_type = 'http' and a.action = 'ACCESS_DENIED'))";
/** Key meaning is the writer's type+action contract, never whichever table has
 * a coincident identifier. New actions must register their proven key semantics.
 * INTAKE_REJECTED uses an unresolved sourceId; CALLBACK_AUTH_FAILED/CONFIG_ERROR
 * use unparsed headers. Neither can authorize a complaint through a collision.
 * Rejected callback event keys require a persisted, resolvable event relation. */
const complaintLinkSql="((a.biz_type = 'complaint' and a.action in ('INTAKE_CREATE','INTAKE_DUPLICATE_SAME','INTAKE_REDELIVERY','ASSIGN_ENTERPRISE','COMPLAINT_DISPOSITION','CORRECTION_GENERATE','CORRECTION_CONFIRM','CORRECTION_REJECT','COMPLAINT_CLOSE','SOURCE_DOCUMENT_READ','CATEGORY_REVISE') and c.complaint_id = a.biz_id) or " +
 "(a.biz_type = 'address_candidate' and a.action = 'LOCATION_CLUE_BACKFILL_ROW' and c.complaint_id = a.biz_id) or " +
 "(a.biz_type = 'dispatch_order' and a.action in ('DISPATCH_CREATE','DISPATCH_CANCEL','DISPATCH_PUSH','DISPATCH_ARCHIVE','CALLBACK_APPLIED','CALLBACK_IGNORED') and c.complaint_id = a.biz_id) or " +
 "(a.biz_type = 'analysis_record' and a.action = 'ANALYSIS_INCLUDED' and exists (select 1 from analysis_record ar where ar.analysis_id = a.biz_id and ar.complaint_id = c.complaint_id)) or " +
 "(a.biz_type = 'business_event' and a.action in ('CALLBACK_DUPLICATE','CALLBACK_IGNORED') and c.complaint_id = a.biz_id) or " +
 "(a.biz_type = 'business_event' and a.action = 'CALLBACK_REJECTED' and exists (select 1 from business_event be where be.event_id = a.biz_id and be.source_business_id = c.complaint_id)))";
function auditWhere(filter:AuditLogFilter,access:AccessContext):{sql:string;params:unknown[]} {
 const scope=buildComplaintScopeSql(access,'c');const clauses=[ '('+systemSql+' or exists (select 1 from complaint c where '+complaintLinkSql+' and '+scope.sql+'))' ];
 const params:unknown[]=[...scope.params];
 for(const [value,sql] of [[filter.category,categorySql+' = ?'],[filter.module,moduleSql+' = ?'],[filter.action,'a.action = ?'],[filter.result,resultSql+' = ?']] as const){
  if(value){clauses.push(sql);params.push(value);}
 }
 if(filter.actor){clauses.push("(a.user_id = ? or exists (select 1 from app_user u where u.user_id = a.user_id and u.username = ?) or (a.biz_type = 'auth' and a.action in ('LOGIN','LOGIN_FAILED') and a.biz_id = ?))");params.push(filter.actor,filter.actor,filter.actor);}
 if(filter.from){clauses.push('a.created_at >= ?');params.push(new Date(filter.from));}
 if(filter.to){clauses.push('a.created_at <= ?');params.push(new Date(filter.to));}
 if(filter.businessNo){
  clauses.push("a.biz_type <> 'http' and a.action <> 'SENSITIVE_WORD_RESCAN' and (("+systemSql+' and a.biz_id = ?) or exists (select 1 from complaint c where '+complaintLinkSql+' and '+scope.sql+' and (c.complaint_id = ? or c.complaint_no = ?)))');
  params.push(filter.businessNo,...scope.params,filter.businessNo,filter.businessNo);
 }
 return {sql:clauses.join(' and '),params};
}
const columns='a.id, a.audit_id, a.user_id, a.app_code, a.action, a.biz_type, a.biz_id, a.result, a.client_ip, a.detail, a.created_at, '+moduleSql+' as module';
function selectedColumns(access:AccessContext):{sql:string;params:unknown[]} {
 const scope=buildComplaintScopeSql(access,'c');
 return {sql:columns+', (select c.complaint_no from complaint c where '+complaintLinkSql+' and '+scope.sql+' order by c.complaint_id limit 1) as business_no',params:scope.params};
}
export async function queryAuditLogs(db:SqlExecutor,filter:AuditLogFilter,pagination:{page:number;size:number},access:AccessContext):Promise<Paged<AuditRow>> {
 const where=auditWhere(filter,access);const selected=selectedColumns(access);
 const [counts]=await db.query('select count(*) as total from operation_audit_log a where '+where.sql,where.params) as [Array<{total:unknown}>,unknown];
 const [rows]=await db.query('select '+selected.sql+' from operation_audit_log a where '+where.sql+' order by a.created_at desc, a.id desc limit ? offset ?', [...selected.params,...where.params,pagination.size,(pagination.page-1)*pagination.size]) as [AuditRow[],unknown];
 const total=Number(counts[0]?.total??0);return {content:rows,total,page:pagination.page,size:pagination.size,totalPages:Math.ceil(total/pagination.size)};
}
export async function findAuditLog(db:SqlExecutor,auditId:string,access:AccessContext):Promise<AuditRow|null> {
 const where=auditWhere({},access);const selected=selectedColumns(access);
 const [rows]=await db.query('select '+selected.sql+' from operation_audit_log a where '+where.sql+' and a.audit_id = ? order by a.id desc limit 1',[...selected.params,...where.params,auditId]) as [AuditRow[],unknown];
 return rows[0]??null;
}
