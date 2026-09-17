// operation_audit_log（追加写）：操作审计。
// 复用既有表（迁移设计 §3.3）：不新建 audit_log。
// 列：audit_id / user_id / app_code / resource_code / action / biz_type / biz_id / result / client_ip / detail / created_at
import { randomUUID } from 'node:crypto';
import type { Queryable } from './complaintSourceLogRepo';
import { cut } from './complaintSourceLogRepo';

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
