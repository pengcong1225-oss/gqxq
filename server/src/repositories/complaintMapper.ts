// complaint 表的共享列清单与行 -> DTO 映射。
// 作用：让「查询层」和「接收层」用同一份列清单与同一套映射，避免两条并行线各写一份后语义漂移。
// 约定：查询一律**具名列**，禁止 select *（平台侧依赖列序的假设同样不成立）。
import type { ComplaintDetail, ComplaintListItem } from '../types/api';
import { labelOf } from '../domain/enums';

/** 查询 complaint 时统一使用的列清单（含 G1 新增的三条状态轴与来源快照列） */
export const COMPLAINT_COLUMNS = [
  'c.id',
  'c.complaint_id',
  'c.complaint_no',
  'c.source_system',
  'c.source_channel',
  'c.source_id',
  'c.title',
  'c.content',
  'c.business_type',
  'c.complaint_type',
  'c.urgency_level',
  'c.status',
  'c.is_sensitive',
  'c.sensitive_keywords',
  'c.district_code',
  'c.district_name',
  'c.address',
  'c.corrected_address',
  'c.location_lng',
  'c.location_lat',
  'c.correction_status',
  'c.correction_confidence',
  'c.enterprise_code',
  'c.enterprise_name',
  'c.grid_code',
  'c.sync_status',
  'c.received_at',
  'c.closed_at',
  'c.created_at',
  'c.updated_at',
  'c.rule_confidence',
  'c.rule_version',
  'c.source_payload',
  'c.source_reported_at',
  'c.source_updated_at',
  'c.source_event_status',
  'c.supervision_status',
  'c.reporting_status',
  'c.closed_in_system',
  'c.closed_by',
  'c.closed_by_name',
  'c.closed_basis',
  'c.analysis_included',
  'c.analysis_record_id',
  'c.responsible_matched_at',
  'c.responsible_match_reason',
].join(', ');

/** 写接收记录时统一使用的列清单 */
export const COMPLAINT_INSERT_COLUMNS = [
  'complaint_id',
  'complaint_no',
  'source_system',
  'source_id',
  'source_channel',
  'title',
  'content',
  'address',
  'district_code',
  'district_name',
  'location_lng',
  'location_lat',
  'business_type',
  'complaint_type',
  'urgency_level',
  'is_sensitive',
  'sensitive_keywords',
  'rule_confidence',
  'rule_version',
  'source_payload',
  'source_payload_hash',
  'source_reported_at',
  'source_updated_at',
  'received_at',
  'source_event_status',
  'supervision_status',
  'reporting_status',
  'closed_in_system',
  'analysis_included',
].join(', ');

/** 外部重传允许覆盖快照的列（严格白名单；人工/业务列绝不在此） */
export const REDELIVERY_UPDATABLE_COLUMNS = [
  'title',
  'content',
  'source_channel',
  'address',
  'district_code',
  'district_name',
  'location_lng',
  'location_lat',
  'business_type',
  'complaint_type',
  'urgency_level',
  'is_sensitive',
  'sensitive_keywords',
  'rule_confidence',
  'rule_version',
  'source_payload',
  'source_payload_hash',
  'source_reported_at',
  'source_updated_at',
] as const;

export type ComplaintRow = Record<string, unknown>;

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/** sensitive_keywords 是 varchar(500)，历史值以逗号分隔；兼容已解析成数组的情况 */
export function parseKeywords(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s !== '');
  return String(v)
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * source_payload 是 JSON 列；mysql2 视配置可能返回对象或字符串。
 * 契约要求它是对象（原始报文），非对象一律返回 null，不硬塞。
 */
export function parseJsonColumn(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined || v === '') return null;
  let parsed: unknown = v;
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

export function rowToListItem(r: ComplaintRow): ComplaintListItem {
  const businessTypeCode = String(r.business_type);
  const complaintTypeCode = String(r.complaint_type);
  const urgencyLevelCode = String(r.urgency_level);
  const correctionStatusCode = String(r.correction_status ?? 'none');
  const sourceEventStatusCode = String(r.source_event_status ?? 'unknown');
  const supervisionStatusCode = String(r.supervision_status ?? 'none');
  const reportingStatusCode = String(r.reporting_status ?? 'not_started');
  return {
    id: Number(r.id),
    complaintId: String(r.complaint_id),
    complaintNo: String(r.complaint_no),
    title: String(r.title),
    sourceSystem: toStr(r.source_system),
    sourceChannel: toStr(r.source_channel),
    sourceId: toStr(r.source_id),
    businessTypeCode,
    businessTypeName: labelOf('business_type', businessTypeCode),
    complaintTypeCode,
    complaintTypeName: labelOf('complaint_type', complaintTypeCode),
    urgencyLevelCode,
    urgencyLevelName: labelOf('urgency_level', urgencyLevelCode),
    districtCode: toStr(r.district_code),
    districtName: toStr(r.district_name),
    enterpriseCode: toStr(r.enterprise_code),
    enterpriseName: toStr(r.enterprise_name),
    isSensitive: toBool(r.is_sensitive),
    sensitiveKeywords: parseKeywords(r.sensitive_keywords),
    correctionStatusCode,
    correctionStatusName: labelOf('correction_status', correctionStatusCode),
    correctionConfidence: toNum(r.correction_confidence),
    sourceEventStatusCode,
    sourceEventStatusName: labelOf('source_event_status', sourceEventStatusCode),
    supervisionStatusCode,
    supervisionStatusName: labelOf('supervision_status', supervisionStatusCode),
    reportingStatusCode,
    reportingStatusName: labelOf('reporting_status', reportingStatusCode),
    closedInSystem: toBool(r.closed_in_system),
    legacyStatus: String(r.status ?? ''),
    sourceReportedAt: toIso(r.source_reported_at),
    receivedAt: toIso(r.received_at),
    createdAt: toIso(r.created_at),
  };
}

export function rowToDetail(r: ComplaintRow): ComplaintDetail {
  return {
    ...rowToListItem(r),
    content: toStr(r.content),
    address: toStr(r.address),
    correctedAddress: toStr(r.corrected_address),
    locationLng: toNum(r.location_lng),
    locationLat: toNum(r.location_lat),
    ruleConfidence: toNum(r.rule_confidence),
    ruleVersion: toStr(r.rule_version),
    sourcePayload: parseJsonColumn(r.source_payload),
    sourceReportedAt: toIso(r.source_reported_at),
    sourceUpdatedAt: toIso(r.source_updated_at),
    closedAt: toIso(r.closed_at),
    closedBy: toStr(r.closed_by),
    closedByName: toStr(r.closed_by_name),
    closedBasis: toStr(r.closed_basis),
    analysisIncluded: toBool(r.analysis_included),
    analysisRecordId: toStr(r.analysis_record_id),
    responsibleMatchedAt: toIso(r.responsible_matched_at),
    responsibleMatchReason: toStr(r.responsible_match_reason),
    sourcePayloadHash: toStr(r.source_payload_hash),
    updatedAt: toIso(r.updated_at),
    deleted: toBool(r.deleted),
  };
}
