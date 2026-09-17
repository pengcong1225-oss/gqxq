// complaint 查询层（诉求总账）。
// 硬约束（见 docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md）：
//   * 一律手写参数化 SQL，禁止 ORM，禁止 select *（统一用 COMPLAINT_SELECT_COLUMNS = COMPLAINT_COLUMNS）
//   * 时间口径（2026-09-17 主线与本人分别实测确认，已固化进迁移设计 §3.5）：
//     gqxq_service 的 DATETIME 存的是 **Asia/Shanghai 墙钟时间**，不是 UTC；连接池 timezone 为 '+08:00'。
//       - 比较/写入一律传 JS Date，由驱动按 +08:00 格式化成墙钟串；不要自己拼 UTC 字符串去比；
//       - 日界判断直接按 received_at 墙钟日，**不要**再 CONVERT_TZ('+00:00','+08:00')，那会整日后移 8 小时；
//       - 绝不用 UTC_TIMESTAMP()；命名时区一律禁用（本机 MySQL 时区表未加载，会静默返回 NULL）。
//   * LIKE 转义用 '!' 而不是反斜杠：反斜杠在 MySQL 字符串字面量里还要再转义一层，
//     写成 escape '\\' 极易被上层语言再吃一层，实测会直接语法错误
import { pool, type Row } from '../db/pool';
import type { ComplaintFilter, ComplaintStats } from '../types/api';
import { COMPLAINT_COLUMNS, toNum, type ComplaintRow } from './complaintMapper';

/** LIKE 转义字符（显式 ESCAPE，不依赖 sql_mode / 默认反斜杠行为） */
const LIKE_ESCAPE = '!';

/** 把用户输入转成可安全放进 LIKE 模式的字面量 */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (m) => LIKE_ESCAPE + m);
}

/** 软删除行不进总账；deleted 可空，用 coalesce 兜住历史 NULL */
const NOT_DELETED = 'coalesce(c.deleted, 0) = 0';

/** 详情需要 mapper 里 rowToDetail 会读、但共享列清单未含的两列 */
const DETAIL_EXTRA_COLUMNS = ', c.source_payload_hash, c.deleted';

/**
 * 进行中交办的关联（G2）。
 * active_complaint_id 是生成列且带唯一键 uk_active_dispatch，因此 LEFT JOIN **至多命中一行**，
 * 不会让列表行数翻倍、也不会让统计数字虚增。
 * mapper 的 rowToListItem 会读 active_dispatch_id / active_dispatch_status 两个别名列。
 * 未关联（该诉求无进行中交办）时为 NULL，表示"可以创建交办"。
 */
export const ACTIVE_DISPATCH_JOIN =
  ' left join dispatch_order ad on ad.active_complaint_id = c.complaint_id';
export const ACTIVE_DISPATCH_COLUMNS =
  ', ad.assignment_id as active_dispatch_id, ad.status as active_dispatch_status';

/**
 * 统一选列清单 = 冻结的共享列清单，不做任何替换。
 *
 * 历史：本文件曾把 c.correction_confidence 替换为 "null as correction_confidence"，
 * 因为当时 live gqxq_service.complaint 没有这一列。该缺口已由主线用迁移 M4 补列修掉
 * （migrations/20260917100400__m4_correction_confidence.js），因此不再替换——
 * 继续替换会用 null 盖住真实列。
 *
 * complaint 表真实存在但共享清单未选的列是 deleted / source_payload_hash，由 DETAIL_EXTRA_COLUMNS 补选。
 */
export const COMPLAINT_SELECT_COLUMNS = COMPLAINT_COLUMNS;

export interface WhereClause {
  text: string;
  params: unknown[];
}

function inClause(column: string, values: string[] | undefined, params: unknown[]): string | null {
  if (!values || values.length === 0) return null;
  const placeholders = values.map(() => '?').join(', ');
  params.push(...values);
  return column + ' in (' + placeholders + ')';
}

/** 列表与统计共用同一套筛选条件，保证「卡片数字」与「表格行」口径一致 */
export function buildWhere(filter: ComplaintFilter): WhereClause {
  const params: unknown[] = [];
  const parts: string[] = [NOT_DELETED];

  if (filter.keyword) {
    const like = '%' + escapeLike(filter.keyword) + '%';
    parts.push(
      '(c.complaint_no like ? escape ' + "'" + LIKE_ESCAPE + "'" +
        ' or c.title like ? escape ' + "'" + LIKE_ESCAPE + "'" +
        ' or c.content like ? escape ' + "'" + LIKE_ESCAPE + "'" +
        ' or c.address like ? escape ' + "'" + LIKE_ESCAPE + "'" + ')'
    );
    params.push(like, like, like, like);
  }

  const multi: Array<[string, string[] | undefined]> = [
    ['c.business_type', filter.businessType],
    ['c.complaint_type', filter.complaintType],
    ['c.urgency_level', filter.urgencyLevel],
    ['c.supervision_status', filter.supervisionStatus],
    ['c.source_event_status', filter.sourceEventStatus],
    ['c.reporting_status', filter.reportingStatus],
  ];
  for (const [column, values] of multi) {
    const clause = inClause(column, values, params);
    if (clause) parts.push(clause);
  }

  if (filter.correctionStatus) {
    parts.push('c.correction_status = ?');
    params.push(filter.correctionStatus);
  }
  if (filter.districtCode) {
    parts.push('c.district_code = ?');
    params.push(filter.districtCode);
  }
  if (filter.enterpriseCode) {
    parts.push('c.enterprise_code = ?');
    params.push(filter.enterpriseCode);
  }
  if (filter.isSensitive !== undefined) {
    parts.push('c.is_sensitive = ?');
    params.push(filter.isSensitive ? 1 : 0);
  }
  if (filter.startDate) {
    parts.push('c.received_at >= ?');
    params.push(new Date(filter.startDate));
  }
  if (filter.endDate) {
    parts.push('c.received_at <= ?');
    params.push(new Date(filter.endDate));
  }

  return { text: parts.join(' and '), params };
}

export interface PageResult {
  rows: ComplaintRow[];
  total: number;
}

/** 服务端分页：总数与当页数据分两条 SQL，条件完全一致 */
export async function findPage(
  filter: ComplaintFilter,
  page: number,
  size: number,
  orderBy: string
): Promise<PageResult> {
  const where = buildWhere(filter);

  const [countRows] = await pool.query<Row[]>(
    'select count(*) as total from complaint c where ' + where.text,
    where.params
  );
  const total = Number((countRows[0] as { total?: unknown } | undefined)?.total ?? 0);

  const offset = (page - 1) * size;
  const [rows] = await pool.query<Row[]>(
    'select ' +
      COMPLAINT_SELECT_COLUMNS +
      ACTIVE_DISPATCH_COLUMNS +
      ' from complaint c' +
      ACTIVE_DISPATCH_JOIN +
      ' where ' +
      where.text +
      ' order by ' +
      orderBy +
      ' limit ? offset ?',
    [...where.params, size, offset]
  );

  return { rows: rows as unknown as ComplaintRow[], total };
}

/** stats：当前筛选条件下的全量统计，不受分页影响 */
export async function findStats(filter: ComplaintFilter): Promise<ComplaintStats> {
  const where = buildWhere(filter);
  const sql =
    'select count(*) as total,' +
    ' sum(case when c.is_sensitive = 1 then 1 else 0 end) as sensitiveCount,' +
    " sum(case when c.supervision_status = 'none' then 1 else 0 end) as notDispatchedCount," +
    " sum(case when c.supervision_status = 'pending_match' then 1 else 0 end) as pendingMatchCount," +
    " sum(case when c.supervision_status in ('pending','pushed','accepted','processing','returned')" +
    ' then 1 else 0 end) as activeDispatchCount,' +
    ' sum(case when c.closed_in_system = 1 then 1 else 0 end) as closedInSystemCount' +
    ' from complaint c where ' +
    where.text;

  const [rows] = await pool.query<Row[]>(sql, where.params);
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    sensitiveCount: toNum(r.sensitiveCount) ?? 0,
    notDispatchedCount: toNum(r.notDispatchedCount) ?? 0,
    pendingMatchCount: toNum(r.pendingMatchCount) ?? 0,
    activeDispatchCount: toNum(r.activeDispatchCount) ?? 0,
    closedInSystemCount: toNum(r.closedInSystemCount) ?? 0,
  };
}

/** 纯数字按数值主键查；否则按业务键 complaint_id 或编号 complaint_no 查（两种都支持） */
export async function findByIdOrNo(idOrNo: string): Promise<ComplaintRow | null> {
  const numeric = /^\d+$/.test(idOrNo);
  const where = numeric ? 'c.id = ?' : '(c.complaint_id = ? or c.complaint_no = ?)';
  const params: unknown[] = numeric ? [Number(idOrNo)] : [idOrNo, idOrNo];
  const [rows] = await pool.query<Row[]>(
    'select ' +
      COMPLAINT_SELECT_COLUMNS +
      DETAIL_EXTRA_COLUMNS +
      ACTIVE_DISPATCH_COLUMNS +
      ' from complaint c' +
      ACTIVE_DISPATCH_JOIN +
      ' where ' +
      where +
      ' limit 1',
    params
  );
  return (rows[0] as unknown as ComplaintRow | undefined) ?? null;
}

export interface IntakeLogRow {
  log_id: string;
  source_system: string | null;
  source_id: string | null;
  complaint_id: string | null;
  result: string;
  message: string | null;
  request_id: string | null;
  remote_ip: string | null;
  payload_hash: string | null;
  received_at: unknown;
}

export interface FieldVersionRow {
  version_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  change_source: string;
  reason: string | null;
  operator_name: string | null;
  changed_at: unknown;
}

export interface OperationLogRow {
  audit_id: string;
  user_id: string | null;
  action: string;
  biz_type: string | null;
  biz_id: string | null;
  result: string | null;
  client_ip: string | null;
  detail: string | null;
  created_at: unknown;
}

export interface TimelineRaw {
  intakes: IntakeLogRow[];
  fieldChanges: FieldVersionRow[];
  operations: OperationLogRow[];
}

/**
 * 时间线原始事件。三类来源各自查询后由 service 合并排序。
 * approval_trace 属 G4，本次不查。
 *
 * operation_audit_log 的 biz_type 取值约定由接收线（并行线 E）拥有，此处**不对 biz_type 设限**，
 * 只按 biz_id 匹配诉求业务键与数值主键，避免因约定未定而漏事件。
 */
export async function findTimelineRaw(complaintId: string, numericId: number): Promise<TimelineRaw> {
  const [intakes] = await pool.query<Row[]>(
    'select log_id, source_system, source_id, complaint_id, result, message, request_id, remote_ip,' +
      ' payload_hash, received_at from complaint_source_log where complaint_id = ? order by received_at asc, id asc',
    [complaintId]
  );
  const [fieldChanges] = await pool.query<Row[]>(
    'select version_id, field_name, old_value, new_value, change_source, reason, operator_name, changed_at' +
      ' from complaint_field_version where complaint_id = ? order by changed_at asc, id asc',
    [complaintId]
  );
  const [operations] = await pool.query<Row[]>(
    'select audit_id, user_id, action, biz_type, biz_id, result, client_ip, detail, created_at' +
      ' from operation_audit_log where biz_id in (?, ?) order by created_at asc, id asc',
    [complaintId, String(numericId)]
  );
  return {
    intakes: intakes as unknown as IntakeLogRow[],
    fieldChanges: fieldChanges as unknown as FieldVersionRow[],
    operations: operations as unknown as OperationLogRow[],
  };
}
