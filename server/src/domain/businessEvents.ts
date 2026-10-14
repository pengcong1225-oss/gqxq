import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../http/errors';
import type { BusinessEventInput, BusinessSourceConfig, BusinessSourceHeaders, SourceRevision } from '../types/businessEvents';

export function isSourceTimestamp(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (m[7] !== 'Z') {
    const [offsetHour, offsetMinute] = m[7].slice(1).split(':').map(Number);
    if (offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) return false;
  }
  return Number.isFinite(Date.parse(value));
}
const code = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
const objectId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const stamp = z.string().refine(isSourceTimestamp, '必须提供合法日期、时间及明确时区');
const optionalStamp = stamp.nullable().default(null);
const text = (max: number) => z.string().max(max).nullable().default(null);
const safeSourceUrl = z.string().max(2000).refine(value => {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}, '来源地址必须为不含凭据的 HTTP 地址').nullable().default(null);
const approvalNode = z.object({ nodeId: objectId, at: optionalStamp, department: text(200), operatorName: text(128), decision: text(200), notes: text(2000) }).strict();
const eventFields = {
  title: z.string().min(1).max(500), businessType: z.enum(['water', 'gas']), applicationId: objectId.nullable().default(null),
  approvalState: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'unknown']).default('unknown'),
  state: z.enum(['planned', 'active', 'ended', 'cancelled', 'unknown']).default('unknown'),
  startsAt: optionalStamp, endsAt: optionalStamp,
  adminGridCodes: z.array(code).max(1000).default([]).transform(values => [...new Set(values)]),
  impactDescription: text(2000), emergencyPlan: text(10000), sourceUrl: safeSourceUrl,
  approvalHistory: z.array(approvalNode).max(500).default([]),
};
const base = {
  sourceId: code, sourceObjectId: objectId, sourceVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sourceUpdatedAt: stamp, enterpriseCode: code.nullable().default(null), districtCode: code.nullable().default(null),
};
const shutdown = z.object({ ...base, kind: z.literal('shutdown'), payload: z.object({ ...eventFields,
  nature: z.enum(['planned', 'emergency', 'unknown']).default('unknown'), expectedRestoredAt: optionalStamp,
  restoredAt: optionalStamp, households: z.number().int().min(0).max(1000000000).nullable().default(null),
}).strict() }).strict();
const pipeline = z.object({ ...base, kind: z.literal('pipeline'), payload: z.object({ ...eventFields,
  workers: z.number().int().min(0).max(1000000).nullable().default(null), reason: text(2000),
}).strict() }).strict();
const followup = z.object({ ...base, kind: z.literal('followup'), payload: z.object({
  complaintId: objectId, occurredAt: optionalStamp, contacted: z.boolean().nullable().default(null),
  evaluation: z.enum(['satisfied', 'dissatisfied']).nullable().default(null), dissatisfactionReason: text(2000),
  operatorName: text(128), notes: text(5000),
}).strict().superRefine((value, ctx) => {
  if (value.contacted !== true && value.evaluation !== null) ctx.addIssue({ code: 'custom', path: ['evaluation'], message: '未取得接通事实不能提供满意度评价' });
  if (value.evaluation === 'dissatisfied' && !value.dissatisfactionReason?.trim()) ctx.addIssue({ code: 'custom', path: ['dissatisfactionReason'], message: '不满意评价缺少原因' });
}) }).strict();
const schema = z.discriminatedUnion('kind', [shutdown, pipeline, followup]);
export function parseBusinessEvent(input: unknown): BusinessEventInput {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw AppError.validation('外部业务记录格式不正确', parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })));
  return parsed.data;
}
export function businessEventKey(event: Pick<BusinessEventInput, 'sourceId' | 'kind' | 'sourceObjectId'>): string {
  return createHash('sha256').update(JSON.stringify([event.sourceId, event.kind, event.sourceObjectId])).digest('hex');
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
  return value;
}
export function sourceRevision(event: BusinessEventInput): SourceRevision {
  return { sourceId: event.sourceId, kind: event.kind, sourceObjectId: event.sourceObjectId, sourceVersion: event.sourceVersion,
    payloadHash: createHash('sha256').update(JSON.stringify(stable(event))).digest('hex') };
}
export function classifySourceRevision(current: SourceRevision | null, next: SourceRevision): 'new' | 'duplicate' | 'stale' {
  if (!current) return 'new';
  if (current.sourceId !== next.sourceId || current.kind !== next.kind || current.sourceObjectId !== next.sourceObjectId) throw AppError.conflict('来源对象身份不一致');
  if (next.sourceVersion < current.sourceVersion) return 'stale';
  if (next.sourceVersion > current.sourceVersion) return 'new';
  if (next.payloadHash !== current.payloadHash) throw AppError.conflict('同一来源版本包含不同内容');
  return 'duplicate';
}
export function businessEventQuality(event: BusinessEventInput): string[] {
  const reasons: string[] = [];
  if (!event.enterpriseCode) reasons.push('ENTERPRISE_UNMAPPED');
  if (event.kind === 'followup') {
    if (!event.payload.occurredAt) reasons.push('FOLLOWUP_TIME_UNKNOWN');
    if (event.payload.contacted === null) reasons.push('CONTACT_UNKNOWN');
    return reasons;
  }
  const p = event.payload;
  if (!p.adminGridCodes.length) reasons.push('IMPACT_UNAVAILABLE');
  if (!p.startsAt || !p.endsAt) reasons.push('TIME_RANGE_UNAVAILABLE');
  if (p.startsAt && p.endsAt && Date.parse(p.startsAt) > Date.parse(p.endsAt)) reasons.push('TIME_ORDER_INVALID');
  if (p.approvalState === 'unknown') reasons.push('APPROVAL_UNKNOWN');
  if (p.state === 'unknown') reasons.push('EVENT_STATE_UNKNOWN');
  if (event.kind === 'shutdown' && !event.payload.restoredAt) reasons.push('RESTORATION_UNKNOWN');
  return reasons;
}
export function verifyBusinessSource(raw: Buffer, headers: BusinessSourceHeaders, config: BusinessSourceConfig | null, clock = new Date()): boolean {
  if (!config || config.secret.length < 32 || !Number.isInteger(config.maxSkewSeconds) || config.maxSkewSeconds < 1 || config.maxSkewSeconds > 900) return false;
  if (headers.sourceId !== config.sourceId || headers.keyId !== config.keyId || !isSourceTimestamp(headers.timestamp) || !/^[0-9a-fA-F]{64}$/.test(headers.signature)) return false;
  const time = Date.parse(headers.timestamp);
  if (!Number.isFinite(clock.getTime()) || Math.abs(clock.getTime() - time) > config.maxSkewSeconds * 1000) return false;
  const expected = createHmac('sha256', config.secret).update(headers.timestamp + '\n').update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(headers.signature, 'hex'));
}
