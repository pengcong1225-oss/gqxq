import request from './request';
import type {AuditLogFilter,AuditLogView,Paged} from '../types/api';
export function listAuditLogs(filter:AuditLogFilter&{page:number;size:number}):Promise<Paged<AuditLogView>> {
 return request.get<never,Paged<AuditLogView>>('/audit-logs',{params:filter});
}
export function getAuditLog(auditId:string):Promise<AuditLogView> {
 return request.get<never,AuditLogView>('/audit-logs/'+encodeURIComponent(auditId));
}
