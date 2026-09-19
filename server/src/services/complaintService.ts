// 诉求总账查询服务：参数解析/校验 + DTO 组装。
// 校验口径见 docs/2026-09-17-诉求平台G1详细实施方案.md §5.4：
//   size 必须在 1..100（超限 400）；sort 只允许白名单字段；startDate/endDate 按 +08:00 解析。
import { z } from 'zod';
import { AppError } from '../http/errors';
import type {
  ComplaintDetail,
  ComplaintFilter,
  ComplaintListItem,
  ComplaintListResult,
  OvertimeFilterCode,
  TimelineItem,
} from '../types/api';
import { labelOf } from '../domain/enums';
import { rowToDetail, rowToListItem } from '../repositories/complaintMapper';
import {
  findByIdOrNo,
  findPage,
  findStats,
  findTimelineRaw,
  type FieldVersionRow,
  type IntakeLogRow,
  type OperationLogRow,
} from '../repositories/complaintRepo';

const MAX_KEYWORD_LENGTH = 100;
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;

/**
 * 排序白名单：字段名 -> SQL 表达式。
 * urgencyLevel 用 CASE 映射成 一般 < 紧急 < 特急 的业务序，
 * 直接按字符串排会得到 critical < normal < urgent 的字母序，是错的。
 */
const SORT_FIELDS: Record<string, string> = {
  receivedAt: 'c.received_at',
  complaintNo: 'c.complaint_no',
  urgencyLevel:
    "case c.urgency_level when 'normal' then 1 when 'urgent' then 2 when 'critical' then 3 else 9 end",
};

const DEFAULT_SORT = 'receivedAt,desc';

/* ---------------- 查询参数解析 ---------------- */

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (Array.isArray(v) && typeof v[0] === 'string') {
    const t = v[0].trim();
    return t === '' ? undefined : t;
  }
  return undefined;
}

/** 逗号分隔多值；空项丢弃，全空视为未传 */
function stringList(v: unknown): string[] | undefined {
  const raw = firstString(v);
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return parts.length > 0 ? parts : undefined;
}

function intParam(v: unknown, name: string, min: number, max: number | undefined, fallback: number): number {
  const raw = firstString(v);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw AppError.validation('参数 ' + name + ' 必须是整数', [{ field: name, message: '必须是整数' }]);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? '不小于 ' + min : min + ' 到 ' + max;
    throw AppError.validation('参数 ' + name + ' 必须在 ' + range + ' 之间', [
      { field: name, message: '取值范围 ' + range },
    ]);
  }
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * overtime 筛选参数：只认 1 / 0 / none 三个值（zod 校验，非法值 400）。
 * 刻意不接受 true/false/2/空串——它们各自都能被"善意解释"成某种口径，
 * 而三态筛选的语义一旦能含混解释，"超期件数"就没有可核对的唯一定义了。
 */
const OVERTIME_VALUES = ['1', '0', 'none'] as const;
const OvertimeParamSchema = z.enum(OVERTIME_VALUES);

export function parseOvertime(raw: unknown): OvertimeFilterCode | undefined {
  const value = firstString(raw);
  if (value === undefined) return undefined;
  const parsed = OvertimeParamSchema.safeParse(value);
  if (!parsed.success) {
    throw AppError.validation('参数 overtime 只能是 ' + OVERTIME_VALUES.join(' / '), [
      { field: 'overtime', message: '期望 1（超期）/ 0（未超期）/ none（无时效信息）' },
    ]);
  }
  return parsed.data as OvertimeFilterCode;
}

/**
 * startDate / endDate 一律按东八区解析（本地业务口径）。
 *   只给日期：start 取当日 00:00:00.000，end 取当日 23:59:59.999（闭区间，含整天）
 *   给了时间但没带偏移：同样按 +08:00 解释
 * 返回 UTC ISO-8601 字符串（契约 ComplaintFilter.startDate 声明为 string）；
 * repository 会再转成 JS Date 交给驱动，由驱动按 +08:00 格式化成墙钟串，
 * 与**业务时间**（coalesce(source_reported_at, received_at)，见 complaintRepo.BUSINESS_TIME）比较。
 */
export function parseShanghaiBoundary(raw: string, name: string, kind: 'start' | 'end'): string {
  const candidate = DATE_ONLY.test(raw)
    ? raw + (kind === 'start' ? 'T00:00:00.000+08:00' : 'T23:59:59.999+08:00')
    : (HAS_OFFSET.test(raw) ? raw : raw + '+08:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation('参数 ' + name + ' 不是合法的日期时间', [
      { field: name, message: '期望 YYYY-MM-DD 或带时区的 ISO-8601' },
    ]);
  }
  return d.toISOString();
}

function parseSort(raw: unknown): string {
  const value = firstString(raw) ?? DEFAULT_SORT;
  const parts = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const field = parts[0] ?? '';
  const dir = (parts[1] ?? 'desc').toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(SORT_FIELDS, field)) {
    throw AppError.validation('参数 sort 的排序字段只支持 ' + Object.keys(SORT_FIELDS).join(' / '), [
      { field: 'sort', message: '不支持按 ' + field + ' 排序' },
    ]);
  }
  if (dir !== 'asc' && dir !== 'desc') {
    throw AppError.validation('参数 sort 的排序方向只能是 asc 或 desc', [
      { field: 'sort', message: '方向必须是 asc 或 desc' },
    ]);
  }
  // 追加数值主键做稳定排序：库里 8 条 received_at 完全相同，没有兜底排序时翻页会飘
  return SORT_FIELDS[field] + ' ' + dir + ', c.id ' + dir;
}

export interface ParsedListQuery {
  filter: ComplaintFilter;
  page: number;
  size: number;
  orderBy: string;
}

export function parseListQuery(query: Record<string, unknown>): ParsedListQuery {
  const page = intParam(query.page, 'page', 1, undefined, 1);
  const size = intParam(query.size, 'size', 1, MAX_SIZE, DEFAULT_SIZE);

  const keyword = firstString(query.keyword);
  if (keyword !== undefined && keyword.length > MAX_KEYWORD_LENGTH) {
    throw AppError.validation('参数 keyword 长度不能超过 ' + MAX_KEYWORD_LENGTH, [
      { field: 'keyword', message: '最长 ' + MAX_KEYWORD_LENGTH + ' 字符' },
    ]);
  }

  let isSensitive: boolean | undefined;
  const sensitiveRaw = firstString(query.isSensitive);
  if (sensitiveRaw !== undefined) {
    if (sensitiveRaw !== '0' && sensitiveRaw !== '1') {
      throw AppError.validation('参数 isSensitive 只能是 0 或 1', [
        { field: 'isSensitive', message: '只能是 0 或 1' },
      ]);
    }
    isSensitive = sensitiveRaw === '1';
  }

  const startRaw = firstString(query.startDate);
  const endRaw = firstString(query.endDate);

  const filter: ComplaintFilter = {
    keyword,
    businessType: stringList(query.businessType),
    complaintType: stringList(query.complaintType),
    urgencyLevel: stringList(query.urgencyLevel),
    supervisionStatus: stringList(query.supervisionStatus),
    sourceEventStatus: stringList(query.sourceEventStatus),
    reportingStatus: stringList(query.reportingStatus),
    overtime: parseOvertime(query.overtime),
    correctionStatus: firstString(query.correctionStatus),
    districtCode: firstString(query.districtCode),
    enterpriseCode: firstString(query.enterpriseCode),
    isSensitive,
    startDate: startRaw === undefined ? undefined : parseShanghaiBoundary(startRaw, 'startDate', 'start'),
    endDate: endRaw === undefined ? undefined : parseShanghaiBoundary(endRaw, 'endDate', 'end'),
  };

  return { filter, page, size, orderBy: parseSort(query.sort) };
}

/* ---------------- 对外方法 ---------------- */

export async function listComplaints(query: Record<string, unknown>): Promise<ComplaintListResult> {
  const { filter, page, size, orderBy } = parseListQuery(query);
  const [pageResult, stats] = await Promise.all([
    findPage(filter, page, size, orderBy),
    findStats(filter),
  ]);
  const content: ComplaintListItem[] = pageResult.rows.map(rowToListItem);
  return {
    content,
    total: pageResult.total,
    page,
    size,
    totalPages: Math.ceil(pageResult.total / size),
    stats,
    generatedAt: new Date().toISOString(),
  };
}

export async function getComplaintDetail(idOrNo: string): Promise<ComplaintDetail> {
  const row = await findByIdOrNo(idOrNo);
  if (!row) throw AppError.notFound('诉求不存在');
  return rowToDetail(row);
}

export interface TimelineResult {
  content: TimelineItem[];
  total: number;
}

/** 字段名 -> 中文标签（受控词汇表，不是业务数据） */
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  content: '内容',
  address: '地址',
  district_code: '区域编码',
  district_name: '所属区域',
  enterprise_code: '责任企业编码',
  enterprise_name: '责任企业',
  business_type: '业务类型',
  complaint_type: '诉求类型',
  urgency_level: '紧急程度',
  correction_status: '纠偏状态',
  supervision_status: '督办状态',
  reporting_status: '填报审批状态',
  source_event_status: '来源状态',
  source_channel: '来源渠道',
  is_sensitive: '敏感标记',
  sensitive_keywords: '敏感词',
  corrected_address: '纠偏后地址',
  location_lng: '经度',
  location_lat: '纬度',
};

const CHANGE_SOURCE_LABELS: Record<string, string> = {
  external_redelivery: '外部重传',
  manual_edit: '人工修改',
  rule_engine: '规则引擎',
  data_repair: '数据修复',
};

const ACTION_LABELS: Record<string, string> = {
  create: '新建',
  update: '修改',
  delete: '删除',
  close: '办结',
  dispatch: '交办',
  archive: '归档',
  login: '登录',
  logout: '退出登录',
  export: '导出',
  import: '导入',
  redelivery: '重传',
  reject: '驳回',
  approve: '通过',
};

function displayValue(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? '（空）' : v;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDetailJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { detail: parsed };
  } catch {
    return { detail: raw };
  }
}

interface PendingItem {
  at: Date;
  seq: number;
  item: TimelineItem;
}

function buildIntakeItems(rows: IntakeLogRow[], startSeq: number): PendingItem[] {
  let seq = startSeq;
  return rows.map((r) => {
    const result = String(r.result ?? '');
    const at = toDate(r.received_at) ?? new Date(0);
    let summary: string;
    if (result === 'created') {
      summary = '系统接收：' + (r.source_system ?? '外部系统') + ' 推送的诉求已落库';
    } else if (result === 'duplicate_same') {
      summary = '重复投递：与已存报文完全一致，未新建诉求';
    } else if (result === 'updated') {
      summary = '重传覆盖：' + (r.source_system ?? '外部系统') + ' 报文有变化，已更新来源快照字段';
    } else if (result === 'rejected') {
      summary = '报文被拒：' + (r.message ?? '未通过校验');
    } else {
      summary = '外部投递：结果 ' + (result === '' ? '未知' : result);
    }
    if (r.complaint_id) summary += '（诉求 ' + r.complaint_id + '）';
    if (r.message && result !== 'rejected') summary += '；' + r.message;

    return {
      at,
      seq: seq++,
      item: {
        at: at.toISOString(),
        category: 'intake',
        action: labelOf('intake_result', result),
        operatorName: r.source_system ?? null,
        summary,
        detail: {
          result: result === '' ? null : result,
          sourceId: r.source_id,
          sourceSystem: r.source_system,
          requestId: r.request_id,
          remoteIp: r.remote_ip,
          payloadHash: r.payload_hash,
          message: r.message,
        },
      },
    };
  });
}

function buildFieldChangeItems(rows: FieldVersionRow[], startSeq: number): PendingItem[] {
  let seq = startSeq;
  return rows.map((r) => {
    const at = toDate(r.changed_at) ?? new Date(0);
    const fieldLabel = FIELD_LABELS[r.field_name] ?? r.field_name;
    return {
      at,
      seq: seq++,
      item: {
        at: at.toISOString(),
        category: 'field_change',
        action: '字段变更',
        operatorName:
          r.operator_name ?? CHANGE_SOURCE_LABELS[r.change_source] ?? r.change_source ?? null,
        summary: fieldLabel + '：' + displayValue(r.old_value) + ' -> ' + displayValue(r.new_value),
        detail: {
          field: r.field_name,
          oldValue: r.old_value,
          newValue: r.new_value,
          changeSource: r.change_source,
          reason: r.reason,
        },
      },
    };
  });
}

function buildOperationItems(rows: OperationLogRow[], startSeq: number): PendingItem[] {
  let seq = startSeq;
  return rows.map((r) => {
    const at = toDate(r.created_at) ?? new Date(0);
    const actionRaw = String(r.action ?? '');
    const label = ACTION_LABELS[actionRaw] ?? (actionRaw === '' ? '操作' : actionRaw);
    const parsed = parseDetailJson(r.detail);

    let summary = label;
    const note =
      parsed && typeof parsed.summary === 'string'
        ? parsed.summary
        : parsed && typeof parsed.message === 'string'
          ? parsed.message
          : null;
    if (note) summary += '：' + note;
    if (r.result && r.result !== 'success') summary += '｜结果 ' + r.result;

    return {
      at,
      seq: seq++,
      item: {
        at: at.toISOString(),
        category: 'operation',
        action: label,
        operatorName: r.user_id ?? null,
        summary,
        detail: parsed,
      },
    };
  });
}

/**
 * 真实事件时间线：合并 complaint_source_log / complaint_field_version / operation_audit_log。
 * approval_trace 属 G4，本次不查。无事件时返回 { content: [], total: 0 }（空态，不摆示例）。
 */
export async function getComplaintTimeline(idOrNo: string): Promise<TimelineResult> {
  const row = await findByIdOrNo(idOrNo);
  if (!row) throw AppError.notFound('诉求不存在');

  const complaintId = String(row.complaint_id);
  const numericId = Number(row.id);
  const raw = await findTimelineRaw(complaintId, numericId);

  const intakes = buildIntakeItems(raw.intakes, 0);
  const fieldChanges = buildFieldChangeItems(raw.fieldChanges, intakes.length);
  const operations = buildOperationItems(raw.operations, intakes.length + fieldChanges.length);

  const pending = [...intakes, ...fieldChanges, ...operations].sort((a, b) => {
    const diff = a.at.getTime() - b.at.getTime();
    return diff !== 0 ? diff : a.seq - b.seq;
  });

  const content = pending.map((p) => p.item);
  return { content, total: content.length };
}
