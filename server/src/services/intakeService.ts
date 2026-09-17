// 宜接就办入站接收服务。
// 职责：落库 + 幂等（同报文不重复落库）+ 重传留痕 + 人工字段保护 + 审计，全部在**单个事务**内完成。
//
// 关键设计（见 docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md §4.6）：
//   1. 唯一性由数据库 uk_source(source_system, source_id) 裁决，不靠应用层先 SELECT 判断；
//   2. 幂等按 payload_hash 分三支：created / duplicate_same / updated；
//   3. 重传只更新 REDELIVERY_UPDATABLE_COLUMNS；受保护列**根本不出现在 UPDATE 语句里**，
//      而不是"先写后判断"——代码写错也不会覆盖人工结论；
//   4. 时间列一律传 JS Date 对象，由驱动按连接池 timezone='+08:00' 格式化；
//      不使用 UTC_TIMESTAMP()、不自己拼时间字符串（口径由 mainline 统一，见 db/pool.ts）。
//      显式传值的意义：不依赖 MySQL 的 current_timestamp 默认值，读写两侧口径完全一致。
import type { Tx } from '../db/tx';
import { withTransaction } from '../db/tx';
import { pool } from '../db/pool';
import { allocateBizNo, shanghaiDate } from '../db/sequence';
import { COMPLAINT_INSERT_COLUMNS, REDELIVERY_UPDATABLE_COLUMNS } from '../repositories/complaintMapper';
import { canonicalJson } from '../repositories/canonicalJson';
import { insertSourceLog, type Queryable, type IntakeResultCode } from '../repositories/complaintSourceLogRepo';
import { insertFieldVersions, toFieldText, type FieldVersionEntry } from '../repositories/complaintFieldVersionRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import { recordSensitiveHits } from '../repositories/sensitiveHitRepo';
import { buildRuleText, classify, CLASSIFY_RULE_VERSION, type Classification } from './rules/classify';
import { detectSensitive, type SensitiveResult } from './rules/sensitive';
import type { IntakeResponse } from '../types/api';

/** 入站来源系统（固定值，与既有 8 条数据一致：source_system 存系统，source_channel 存渠道） */
export const YIJIEJIEBAN_SYSTEM = '宜接就办';
/** 本系统对外应用编码（审计 app_code） */
export const GQXQ_APP_CODE = 'gqxq';

const MAX_ATTEMPTS = 5;
const MAX_FIELD_TEXT = 15000;

/** 并发抢占：事务已回滚，重试即可读到对手已提交的行 */
class IntakeRaceRetry extends Error {}

export interface IntakeCommand {
  sourceSystem: string;
  sourceId: string;
  /** 报文里的 source（渠道），落 source_channel */
  channel: string | null;
  title: string;
  content: string | null;
  address: string | null;
  districtCode: string | null;
  districtName: string | null;
  longitude: number | null;
  latitude: number | null;
  /** 报文显式给出的分类（已校验为合法小写码）；为 null 时由规则引擎判定 */
  explicitBusinessType: string | null;
  explicitComplaintType: string | null;
  explicitUrgencyLevel: string | null;
  sourceReportedAt: Date | null;
  /** 原始报文（完整 parsed body）：既落 source_payload，也参与 payloadHash */
  payload: Record<string, unknown>;
  payloadHash: string;
  warnings: string[];
  remoteIp: string | null;
  requestId: string | null;
}

export interface RejectedIntakeInput {
  sourceSystem: string;
  sourceId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  message: string;
  remoteIp: string | null;
  requestId: string | null;
  receivedAt: Date;
}

export interface IntakeContext {
  receivedAt: Date;
}

// 说明：这里**没有**用 complaintMapper 的 COMPLAINT_COLUMNS。该冻结清单里含
// 'c.correction_confidence'，而 live gqxq_service.complaint 没有这一列（实测 46 项缺 1 项），
// 任何使用它的查询都会 ER_BAD_FIELD_ERROR。接收层只需要"身份 + 可覆盖白名单列"，
// 因此从冻结的 REDELIVERY_UPDATABLE_COLUMNS 派生，既不硬编码列名，也不受该缺陷影响。
const SELECT_ROW =
  'select c.complaint_id, c.complaint_no, ' +
  REDELIVERY_UPDATABLE_COLUMNS.map((column) => 'c.' + column).join(', ') +
  ' from complaint c where c.source_system = ? and c.source_id = ?';

/** 外部重传**绝不允许**覆盖的列：这里只用来说明"报文试图改写"，UPDATE 语句里绝不出现它们 */
const PROTECTED_REQUEST_KEYS: ReadonlyArray<{ column: string; keys: readonly string[] }> = [
  { column: 'enterprise_code', keys: ['enterpriseCode', 'enterprise_code'] },
  { column: 'enterprise_name', keys: ['enterpriseName', 'enterprise_name'] },
  { column: 'corrected_address', keys: ['correctedAddress', 'corrected_address'] },
  { column: 'correction_status', keys: ['correctionStatus', 'correction_status'] },
  { column: 'correction_confidence', keys: ['correctionConfidence', 'correction_confidence'] },
  { column: 'supervision_status', keys: ['supervisionStatus', 'supervision_status'] },
  { column: 'reporting_status', keys: ['reportingStatus', 'reporting_status'] },
  { column: 'source_event_status', keys: ['sourceEventStatus', 'source_event_status'] },
  { column: 'closed_in_system', keys: ['closedInSystem', 'closed_in_system'] },
  { column: 'closed_at', keys: ['closedAt', 'closed_at'] },
  { column: 'closed_by', keys: ['closedBy', 'closed_by'] },
  { column: 'closed_by_name', keys: ['closedByName', 'closed_by_name'] },
  { column: 'closed_basis', keys: ['closedBasis', 'closed_basis'] },
  { column: 'analysis_included', keys: ['analysisIncluded', 'analysis_included'] },
  { column: 'analysis_record_id', keys: ['analysisRecordId', 'analysis_record_id'] },
];

/** 数值列：mysql2 把 decimal 读成字符串，比较前必须归一成数值 */
const NUMERIC_COLUMNS = new Set(['rule_confidence', 'location_lng', 'location_lat']);

const INSERT_COLUMNS = COMPLAINT_INSERT_COLUMNS.split(',').map((s) => s.trim());
/** status 是平台侧仍在读写的兼容列，必须显式给值；created_at/updated_at 显式写 UTC，避免落进本地时区 */
const EXTRA_INSERT_COLUMNS = ['status', 'created_at', 'updated_at'];

function cutText(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max) + '…[truncated]';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 保证落 json 列的值永远是对象（json 列 not null） */
export function toPayloadObject(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : { value: raw ?? null };
}

function normalizeForCompare(column: string, value: unknown): string {
  if (value === null || value === undefined) return 'N';
  if (NUMERIC_COLUMNS.has(column)) {
    const n = Number(value);
    return Number.isFinite(n) ? 'F' + n.toFixed(6) : 'N';
  }
  if (value instanceof Date) return 'D' + value.getTime();
  if (typeof value === 'boolean') return 'B' + (value ? 1 : 0);
  if (typeof value === 'number') return 'F' + value;
  if (typeof value === 'object') return 'J' + canonicalJson(value);
  return 'S' + String(value);
}

/** 绑定参数类型（mysql2 execute 只接受这几种标量） */
type SqlParam = string | number | Date | null;

/** 绑定参数：json 列显式序列化，其余归一成驱动可接受的标量（Date 由驱动按 UTC 写入） */
function toSqlParam(column: string, value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  if (column === 'source_payload') return JSON.stringify(value);
  if (value instanceof Date) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

function isRetryableLockError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === 'ER_LOCK_DEADLOCK' || e?.code === 'ER_LOCK_WAIT_TIMEOUT' || e?.errno === 1213;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 报文里试图出现的受保护字段（返回 DB 列名） */
function attemptedProtectedColumns(payload: Record<string, unknown>): Array<{ column: string; key: string; value: unknown }> {
  const out: Array<{ column: string; key: string; value: unknown }> = [];
  for (const entry of PROTECTED_REQUEST_KEYS) {
    for (const key of entry.keys) {
      if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
        out.push({ column: entry.column, key, value: payload[key] });
        break;
      }
    }
  }
  return out;
}

function buildRuleVersion(sensitive: SensitiveResult): string {
  // varchar(32)：'classify.v1+sensitive_word/3' = 27 字符，安全
  return CLASSIFY_RULE_VERSION + '+' + sensitive.ruleVersion;
}

function resolveClassification(cmd: IntakeCommand, text: string): Classification {
  const base = classify(text);
  return {
    ...base,
    businessType: (cmd.explicitBusinessType as Classification['businessType']) ?? base.businessType,
    complaintType: (cmd.explicitComplaintType as Classification['complaintType']) ?? base.complaintType,
    urgencyLevel: (cmd.explicitUrgencyLevel as Classification['urgencyLevel']) ?? base.urgencyLevel,
  };
}

function keywordsToColumn(keywords: string[]): string | null {
  return keywords.length === 0 ? null : keywords.join(',');
}

function buildMessage(parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '');
  return kept.length === 0 ? null : cutText(kept.join('；'), 500);
}

function unknownFieldNotice(payload: Record<string, unknown>, known: readonly string[]): string | null {
  const knownSet = new Set(known);
  const unknown = Object.keys(payload).filter((k) => !knownSet.has(k));
  return unknown.length === 0 ? null : '未知字段已忽略：' + unknown.join(',');
}

function auditDetail(base: Record<string, unknown>): Record<string, unknown> {
  return base;
}

/** ─────────────── 事务外：被拒报文留痕（追加写，绝不静默丢弃） ─────────────── */
export async function logRejectedIntake(input: RejectedIntakeInput): Promise<void> {
  const db: Queryable = pool;
  await insertSourceLog(db, {
    sourceSystem: input.sourceSystem,
    sourceId: input.sourceId,
    complaintId: null,
    payloadHash: input.payloadHash,
    payload: input.payload,
    result: 'rejected',
    message: input.message,
    remoteIp: input.remoteIp,
    requestId: input.requestId,
    receivedAt: input.receivedAt,
  });
  await insertAudit(db, {
    userId: null,
    appCode: GQXQ_APP_CODE,
    resourceCode: null,
    action: 'INTAKE_REJECTED',
    bizType: 'complaint',
    bizId: input.sourceId,
    result: 'rejected',
    clientIp: input.remoteIp,
    detail: auditDetail({ sourceId: input.sourceId, reason: input.message, payloadHash: input.payloadHash }),
    createdAt: input.receivedAt,
  });
}

/** ─────────────── 事务内实现 ─────────────── */

async function selectForUpdate(tx: Tx, sourceSystem: string, sourceId: string): Promise<Record<string, unknown> | null> {
  const [rows] = await tx.query(SELECT_ROW + ' for update', [sourceSystem, sourceId]);
  const list = rows as Array<Record<string, unknown>>;
  return list.length > 0 ? list[0] : null;
}

async function createNew(tx: Tx, cmd: IntakeCommand, receivedAt: Date): Promise<IntakeResponse> {
  const isoDate = shanghaiDate(receivedAt);
  // 发号与插入同事务：插入失败（含并发撞唯一键）回滚时序号一并回滚
  const complaintId = await allocateBizNo(tx, 'complaint', 'CPL', isoDate);
  const complaintNo = await allocateBizNo(tx, 'complaint_no', 'CS', isoDate);

  const text = buildRuleText([cmd.title, cmd.content, cmd.address]);
  const classification = resolveClassification(cmd, text);
  const sensitive = await detectSensitive(tx, text);
  const ruleVersion = buildRuleVersion(sensitive);

  const attempted = attemptedProtectedColumns(cmd.payload);
  const warnings = [...cmd.warnings];
  if (sensitive.warning) warnings.push(sensitive.warning);
  if (attempted.length > 0) {
    warnings.push('报文包含受保护字段，新建时不写入：' + attempted.map((a) => a.column).join(', '));
  }

  // G2 业务规则：敏感命中但责任单位为空 -> pending_match（留在总账待匹配，不展示为已交办）。
  // 入站报文的 companyName 只是来源提示，不写 enterprise_code（那是人工受保护字段，见 PROTECTED_REQUEST_KEYS），
  // 因此新建诉求的责任单位必为空：敏感命中即进入待匹配，否则就是未交办。
  const initialSupervisionStatus = sensitive.isSensitive ? 'pending_match' : 'none';

  const values: Record<string, unknown> = {
    complaint_id: complaintId,
    complaint_no: complaintNo,
    source_system: cmd.sourceSystem,
    source_id: cmd.sourceId,
    source_channel: cmd.channel,
    title: cmd.title,
    content: cmd.content,
    address: cmd.address,
    district_code: cmd.districtCode,
    district_name: cmd.districtName,
    location_lng: cmd.longitude,
    location_lat: cmd.latitude,
    business_type: classification.businessType,
    complaint_type: classification.complaintType,
    urgency_level: classification.urgencyLevel,
    is_sensitive: sensitive.isSensitive ? 1 : 0,
    sensitive_keywords: keywordsToColumn(sensitive.keywords),
    rule_confidence: sensitive.confidence,
    rule_version: ruleVersion,
    source_payload: cmd.payload,
    source_payload_hash: cmd.payloadHash,
    source_reported_at: cmd.sourceReportedAt,
    source_updated_at: null,
    received_at: receivedAt,
    source_event_status: 'unknown',
    supervision_status: initialSupervisionStatus,
    reporting_status: 'not_started',
    closed_in_system: 0,
    analysis_included: 0,
    status: 'pending',
    created_at: receivedAt,
    updated_at: receivedAt,
  };

  const columns = [...INSERT_COLUMNS, ...EXTRA_INSERT_COLUMNS];
  const params = columns.map((column) => {
    if (!Object.prototype.hasOwnProperty.call(values, column)) {
      throw new Error('[intake] COMPLAINT_INSERT_COLUMNS 出现未映射列：' + column);
    }
    return toSqlParam(column, values[column]);
  });

  try {
    await tx.execute(
      'insert into complaint (' + columns.join(', ') + ') values (' + columns.map(() => '?').join(', ') + ')',
      params
    );
  } catch (err) {
    if (isDuplicateKey(err)) {
      // 并发对手先落库：回滚重试，重试时会走 duplicate_same / updated 分支
      throw new IntakeRaceRetry('并发插入撞 uk_source，回滚重试');
    }
    throw err;
  }

  const message = buildMessage([unknownFieldNotice(cmd.payload, KNOWN_REQUEST_KEYS)]);
  await insertSourceLog(tx, {
    sourceSystem: cmd.sourceSystem,
    sourceId: cmd.sourceId,
    complaintId,
    payloadHash: cmd.payloadHash,
    payload: cmd.payload,
    result: 'created',
    message,
    remoteIp: cmd.remoteIp,
    requestId: cmd.requestId,
    receivedAt,
  });

  // G2：把本次命中逐条落 sensitive_hit（证据粒度到字段；词表为空时不写空行）。
  // 不改响应 warnings —— 那是异常上报通道，正常记录证据不该污染它。
  await recordSensitiveHits(tx, {
    complaintId,
    ruleVersion,
    matchedAt: receivedAt,
    fields: [
      { field: 'title', text: cmd.title },
      { field: 'content', text: cmd.content },
      { field: 'address', text: cmd.address },
    ],
  });

  await insertAudit(tx, {
    userId: null,
    appCode: GQXQ_APP_CODE,
    resourceCode: complaintNo,
    action: 'INTAKE_CREATE',
    bizType: 'complaint',
    bizId: complaintId,
    result: 'success',
    clientIp: cmd.remoteIp,
    detail: auditDetail({
      sourceId: cmd.sourceId,
      result: 'created',
      businessType: classification.businessType,
      complaintType: classification.complaintType,
      urgencyLevel: classification.urgencyLevel,
      isSensitive: sensitive.isSensitive,
      sensitiveKeywords: sensitive.keywords,
      ruleVersion,
      protectedFieldsRejected: attempted.map((a) => a.column),
    }),
    createdAt: receivedAt,
  });

  return {
    result: 'created',
    duplicate: false,
    complaintId,
    complaintNo,
    changedFields: [],
    warnings,
  };
}

async function recordDuplicateSame(
  tx: Tx,
  row: Record<string, unknown>,
  cmd: IntakeCommand,
  receivedAt: Date
): Promise<IntakeResponse> {
  const complaintId = String(row.complaint_id);
  const complaintNo = String(row.complaint_no);
  // 幂等：**不修改 complaint 任何列**
  const message = buildMessage([
    '与首次报文完全一致，未修改任何字段',
    unknownFieldNotice(cmd.payload, KNOWN_REQUEST_KEYS),
  ]);
  await insertSourceLog(tx, {
    sourceSystem: cmd.sourceSystem,
    sourceId: cmd.sourceId,
    complaintId,
    payloadHash: cmd.payloadHash,
    payload: cmd.payload,
    result: 'duplicate_same',
    message,
    remoteIp: cmd.remoteIp,
    requestId: cmd.requestId,
    receivedAt,
  });
  await insertAudit(tx, {
    userId: null,
    appCode: GQXQ_APP_CODE,
    resourceCode: complaintNo,
    action: 'INTAKE_DUPLICATE_SAME',
    bizType: 'complaint',
    bizId: complaintId,
    result: 'duplicate',
    clientIp: cmd.remoteIp,
    detail: auditDetail({ sourceId: cmd.sourceId, result: 'duplicate_same' }),
    createdAt: receivedAt,
  });

  return {
    result: 'duplicate_same',
    duplicate: true,
    complaintId,
    complaintNo,
    changedFields: [],
    warnings: [...cmd.warnings],
  };
}

async function applyRedelivery(
  tx: Tx,
  row: Record<string, unknown>,
  cmd: IntakeCommand,
  receivedAt: Date
): Promise<IntakeResponse> {
  const complaintId = String(row.complaint_id);
  const complaintNo = String(row.complaint_no);

  const text = buildRuleText([cmd.title, cmd.content, cmd.address]);
  const classification = resolveClassification(cmd, text);
  const sensitive = await detectSensitive(tx, text);
  const ruleVersion = buildRuleVersion(sensitive);

  const target: Record<string, unknown> = {
    title: cmd.title,
    content: cmd.content,
    source_channel: cmd.channel,
    address: cmd.address,
    district_code: cmd.districtCode,
    district_name: cmd.districtName,
    location_lng: cmd.longitude,
    location_lat: cmd.latitude,
    business_type: classification.businessType,
    complaint_type: classification.complaintType,
    urgency_level: classification.urgencyLevel,
    is_sensitive: sensitive.isSensitive ? 1 : 0,
    sensitive_keywords: keywordsToColumn(sensitive.keywords),
    rule_confidence: sensitive.confidence,
    rule_version: ruleVersion,
    source_payload: cmd.payload,
    source_payload_hash: cmd.payloadHash,
    source_reported_at: cmd.sourceReportedAt,
    source_updated_at: receivedAt,
  };

  // 只遍历白名单：受保护列根本不会进入集合，因此不可能出现在 UPDATE 里
  const changedColumns = REDELIVERY_UPDATABLE_COLUMNS.filter(
    (column) => normalizeForCompare(column, row[column]) !== normalizeForCompare(column, target[column])
  );

  const fieldVersions: FieldVersionEntry[] = [];
  for (const column of changedColumns) {
    // source_payload 本身可能接近 1 MiB，塞进 TEXT 会溢出；原始报文已落 complaint.source_payload
    // 与 complaint_source_log.payload，这里对整包只留摘要，避免越界写失败。
    if (column === 'source_payload') continue;
    fieldVersions.push({
      complaintId,
      fieldName: column,
      oldValue: cutText(toFieldText(row[column], canonicalJson), MAX_FIELD_TEXT),
      newValue: cutText(toFieldText(target[column], canonicalJson), MAX_FIELD_TEXT),
      changeSource: 'external_redelivery',
      reason: '宜接就办重传覆盖来源快照',
      operatorId: null,
      operatorName: YIJIEJIEBAN_SYSTEM,
      changedAt: receivedAt,
    });
  }

  // 受保护字段被改写尝试：留痕（old = new），但不改动数据
  const attempted = attemptedProtectedColumns(cmd.payload);
  for (const item of attempted) {
    const current = row[item.column];
    fieldVersions.push({
      complaintId,
      fieldName: item.column,
      oldValue: cutText(toFieldText(current, canonicalJson), MAX_FIELD_TEXT),
      newValue: cutText(toFieldText(current, canonicalJson), MAX_FIELD_TEXT),
      changeSource: 'external_redelivery',
      reason: cutText(
        '重传试图改写受保护字段 ' + item.column + ' 被拒；报文键 ' + item.key + ' 的值=' + String(item.value),
        500
      ),
      operatorId: null,
      operatorName: YIJIEJIEBAN_SYSTEM,
      changedAt: receivedAt,
    });
  }

  if (changedColumns.length > 0) {
    const setSql = changedColumns.map((column) => column + ' = ?').join(', ');
    const params = changedColumns.map((column) => toSqlParam(column, target[column]));
    await tx.execute('update complaint set ' + setSql + ', updated_at = ? where complaint_id = ?', [...params, receivedAt, complaintId]);
  } else {
    // 报文变了但白名单列无实际变化：只对齐 updated_at，不做其它写入
    await tx.execute('update complaint set updated_at = ? where complaint_id = ?', [receivedAt, complaintId]);
  }

  const insertedVersions = await insertFieldVersions(tx, fieldVersions);

  // G2：仅当关键词集合确实变化时补记命中证据。
  // sensitive_hit 没有唯一键，无关变化也写会让追加表被重复行淹没。
  if (changedColumns.includes('sensitive_keywords')) {
    await recordSensitiveHits(tx, {
      complaintId,
      ruleVersion,
      matchedAt: receivedAt,
      fields: [
        { field: 'title', text: cmd.title },
        { field: 'content', text: cmd.content },
        { field: 'address', text: cmd.address },
      ],
    });
  }

  const message = buildMessage([
    changedColumns.length > 0 ? '变化字段：' + changedColumns.join(', ') : '白名单字段无实际变化',
    attempted.length > 0 ? '受保护字段改写被拒：' + attempted.map((a) => a.column).join(', ') : null,
    sensitive.warning,
    unknownFieldNotice(cmd.payload, KNOWN_REQUEST_KEYS),
  ]);

  await insertSourceLog(tx, {
    sourceSystem: cmd.sourceSystem,
    sourceId: cmd.sourceId,
    complaintId,
    payloadHash: cmd.payloadHash,
    payload: cmd.payload,
    result: 'updated',
    message,
    remoteIp: cmd.remoteIp,
    requestId: cmd.requestId,
    receivedAt,
  });
  await insertAudit(tx, {
    userId: null,
    appCode: GQXQ_APP_CODE,
    resourceCode: complaintNo,
    action: 'INTAKE_REDELIVERY',
    bizType: 'complaint',
    bizId: complaintId,
    result: 'success',
    clientIp: cmd.remoteIp,
    detail: auditDetail({
      sourceId: cmd.sourceId,
      result: 'updated',
      changedFields: changedColumns,
      fieldVersionRows: insertedVersions,
      protectedFieldsRejected: attempted.map((a) => a.column),
      ruleVersion,
    }),
    createdAt: receivedAt,
  });

  const warnings = [...cmd.warnings];
  if (sensitive.warning) warnings.push(sensitive.warning);
  if (attempted.length > 0) {
    warnings.push('报文包含受保护字段，已拒绝覆盖：' + attempted.map((a) => a.column).join(', '));
  }

  return {
    result: 'updated',
    duplicate: false,
    complaintId,
    complaintNo,
    changedFields: changedColumns,
    warnings,
  };
}

async function intakeOnce(cmd: IntakeCommand, receivedAt: Date): Promise<IntakeResponse> {
  return withTransaction(async (tx) => {
    const row = await selectForUpdate(tx, cmd.sourceSystem, cmd.sourceId);
    if (row === null) {
      return createNew(tx, cmd, receivedAt);
    }
    const storedHash = row.source_payload_hash === null || row.source_payload_hash === undefined ? '' : String(row.source_payload_hash);
    if (storedHash === cmd.payloadHash) {
      return recordDuplicateSame(tx, row, cmd, receivedAt);
    }
    return applyRedelivery(tx, row, cmd, receivedAt);
  });
}

export async function intakeAppeal(cmd: IntakeCommand, ctx?: Partial<IntakeContext>): Promise<IntakeResponse> {
  const receivedAt = ctx?.receivedAt ?? new Date();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await intakeOnce(cmd, receivedAt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof IntakeRaceRetry || isRetryableLockError(err);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      // 确定性退避：并发热点行下让对手先提交，重试即可读到既有行
      // （退避取确定性步长，不引入随机：重试路径不需要随机性）
      await sleep(15 * attempt);
    }
  }

  if (lastError instanceof IntakeRaceRetry || isRetryableLockError(lastError)) {
    throw new Error('[intake] 并发写入冲突，重试 ' + MAX_ATTEMPTS + ' 次后仍未取得稳定结果');
  }
  throw lastError;
}

/** 允许出现在报文里的顶层字段（其余记入"未知字段已忽略"） */
export const KNOWN_REQUEST_KEYS = [
  'sourceId',
  'appealId',
  'title',
  'content',
  'address',
  'districtCode',
  'districtName',
  'source',
  'businessType',
  'complaintType',
  'urgencyLevel',
  'longitude',
  'latitude',
  'createdAt',
] as const;

export type { IntakeResultCode, Classification, SensitiveResult, Queryable };
