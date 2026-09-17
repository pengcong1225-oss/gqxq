// dispatch_order（交办单）查询与写入。
//
// 硬约束（落地计划 G2 + 迁移设计）：
//   * **唯一有效交办由数据库保证**：dispatch_order.uk_active_dispatch（生成列 active_complaint_id）。
//     因此创建交办一律"直接插入 + 捕获重复键后回读既有记录"，**不用**应用层先查后插——
//     先查后插在并发下必然漏判，而唯一键是唯一可靠的裁决者。
//   * request_id 上有 uk_dispatch_request，同一幂等键重复插入同样靠捕获重复键。
//   * 时间列传 JS Date，由连接池 timezone='+08:00' 格式化成墙钟串；禁用 UTC_TIMESTAMP 与命名时区。
//   * 禁止 select *，一律具名列。
//
// 本文件同时提供 lockComplaintByAnyKey()：G2 的创建交办 / 分配责任单位 / 归库处置三条路径
// 都需要先锁住 complaint 行再改状态，共用一份实现避免语义漂移。
import { pool, type Row } from '../db/pool';
import type { Tx } from '../db/tx';
import type { DispatchOrderDetail, DispatchOrderFilter, DispatchOrderListItem } from '../types/api';
import { labelOf } from '../domain/enums';
import { parseKeywords, toIso, toNum, toStr, type ComplaintRow } from './complaintMapper';
import { escapeLike } from './complaintRepo';

const LIKE_ESCAPE = '!';

/** 交办列表/详情统一列清单（含 M6 新增列；complaint 侧只取编号与标题回填） */
export const ORDER_SELECT_COLUMNS = [
  'd.id',
  'd.assignment_id',
  'd.order_no',
  'd.complaint_id',
  'c.complaint_no as complaint_no',
  'c.source_id as source_event_no',
  'coalesce(d.complaint_title, c.title) as complaint_title',
  'd.dispatch_type',
  'd.trigger_type',
  'd.sensitive_words',
  'd.target_enterprise_code',
  'd.target_enterprise_name',
  'd.status',
  'd.reason',
  'd.requirement',
  'd.deadline',
  'd.request_id',
  'd.reporting_task_id',
  'd.sync_status',
  'd.external_status',
  'd.created_at',
  'd.updated_at',
  'd.pushed_at',
  'd.completed_at',
  'd.archived_at',
  'd.result_content',
  'd.cancelled_at',
  'd.cancel_reason',
  'd.created_by',
  'd.created_by_name',
  'd.template_code',
  'd.template_version',
  'd.approval_definition_code',
  'd.approval_definition_version',
].join(', ');

const ORDER_FROM = ' from dispatch_order d left join complaint c on c.complaint_id = d.complaint_id';

export function rowToDispatchListItem(r: ComplaintRow): DispatchOrderListItem {
  const status = String(r.status ?? '');
  return {
    id: Number(r.id),
    assignmentId: String(r.assignment_id),
    orderNo: String(r.order_no),
    complaintId: String(r.complaint_id),
    complaintNo: toStr(r.complaint_no),
    complaintTitle: toStr(r.complaint_title),
    dispatchType: toStr(r.dispatch_type),
    dispatchTypeName: r.dispatch_type ? labelOf('dispatch_type', String(r.dispatch_type)) : '',
    triggerType: toStr(r.trigger_type),
    triggerTypeName: r.trigger_type ? labelOf('trigger_type', String(r.trigger_type)) : '',
    sensitiveWords: parseKeywords(r.sensitive_words),
    targetEnterpriseCode: toStr(r.target_enterprise_code),
    targetEnterpriseName: toStr(r.target_enterprise_name),
    status,
    statusName: labelOf('supervision_status', status),
    reason: toStr(r.reason),
    requirement: toStr(r.requirement),
    deadline: toIso(r.deadline),
    requestId: toStr(r.request_id),
    reportingTaskId: toStr(r.reporting_task_id),
    syncStatus: toStr(r.sync_status),
    externalStatus: toStr(r.external_status),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    archivedAt: toIso(r.archived_at),
  };
}

export function rowToDispatchDetail(r: ComplaintRow): DispatchOrderDetail {
  return {
    ...rowToDispatchListItem(r),
    pushedAt: toIso(r.pushed_at),
    completedAt: toIso(r.completed_at),
    archivedAt: toIso(r.archived_at),
    resultContent: toStr(r.result_content),
    cancelledAt: toIso(r.cancelled_at),
    cancelReason: toStr(r.cancel_reason),
    createdBy: toStr(r.created_by),
    createdByName: toStr(r.created_by_name),
    templateCode: toStr(r.template_code),
    templateVersion: toNum(r.template_version),
    approvalDefinitionCode: toStr(r.approval_definition_code),
    approvalDefinitionVersion: toNum(r.approval_definition_version),
  };
}

/* ---------------- 重复键判定 ---------------- */

/**
 * 返回重复键的索引名（无法解析时返回空串），非重复键错误返回 null。
 * MySQL 8 的报文形如：Duplicate entry 'X' for key 'dispatch_order.uk_active_dispatch'
 */
export function duplicateKeyName(err: unknown): string | null {
  const e = err as { code?: string; errno?: number; sqlMessage?: string; message?: string };
  if (e === null || e === undefined) return null;
  if (e.code !== 'ER_DUP_ENTRY' && e.errno !== 1062) return null;
  const msg = String(e.sqlMessage ?? e.message ?? '');
  const matched = /for key '([^']+)'/i.exec(msg);
  return matched ? matched[1] : '';
}

export function isDuplicateKey(err: unknown): boolean {
  return duplicateKeyName(err) !== null;
}

/* ---------------- 列表筛选 ---------------- */

export interface DispatchWhere {
  text: string;
  params: unknown[];
}

function inClause(column: string, values: string[] | undefined, params: unknown[]): string | null {
  if (!values || values.length === 0) return null;
  const placeholders = values.map(() => '?').join(', ');
  params.push(...values);
  return column + ' in (' + placeholders + ')';
}

export function buildOrderWhere(filter: DispatchOrderFilter): DispatchWhere {
  const params: unknown[] = [];
  const parts: string[] = ['1 = 1'];

  if (filter.keyword) {
    const like = '%' + escapeLike(filter.keyword) + '%';
    const esc = "'" + LIKE_ESCAPE + "'";
    parts.push(
      '(d.order_no like ? escape ' + esc +
        ' or d.assignment_id like ? escape ' + esc +
        ' or d.complaint_id like ? escape ' + esc +
        ' or c.complaint_no like ? escape ' + esc +
        ' or coalesce(d.complaint_title, c.title) like ? escape ' + esc + ')'
    );
    params.push(like, like, like, like, like);
  }

  const statusClause = inClause('d.status', filter.status, params);
  if (statusClause) parts.push(statusClause);

  if (filter.complaintId) {
    parts.push('d.complaint_id = ?');
    params.push(filter.complaintId);
  }
  if (filter.targetEnterpriseCode) {
    parts.push('d.target_enterprise_code = ?');
    params.push(filter.targetEnterpriseCode);
  }
  if (filter.startDate) {
    parts.push('d.created_at >= ?');
    params.push(new Date(filter.startDate));
  }
  if (filter.endDate) {
    parts.push('d.created_at <= ?');
    params.push(new Date(filter.endDate));
  }

  return { text: parts.join(' and '), params };
}

export interface DispatchPageResult {
  rows: ComplaintRow[];
  total: number;
}

/** 服务端分页：总数与当页数据两条 SQL，条件完全一致。**不现场生成任何数据**。 */
export async function findOrderPage(
  filter: DispatchOrderFilter,
  page: number,
  size: number
): Promise<DispatchPageResult> {
  const where = buildOrderWhere(filter);

  const [countRows] = await pool.query<Row[]>(
    'select count(*) as total' + ORDER_FROM + ' where ' + where.text,
    where.params
  );
  const total = Number((countRows[0] as { total?: unknown } | undefined)?.total ?? 0);

  const offset = (page - 1) * size;
  const [rows] = await pool.query<Row[]>(
    'select ' + ORDER_SELECT_COLUMNS + ORDER_FROM + ' where ' + where.text +
      ' order by d.created_at desc, d.id desc limit ? offset ?',
    [...where.params, size, offset]
  );

  return { rows: rows as unknown as ComplaintRow[], total };
}

/** 按业务键查单条（事务内外都能用） */
export async function findOrderByAssignmentId(
  db: Tx | typeof pool,
  assignmentId: string
): Promise<ComplaintRow | null> {
  const [rows] = await db.query<Row[]>(
    'select ' + ORDER_SELECT_COLUMNS + ORDER_FROM + ' where d.assignment_id = ? limit 1',
    [assignmentId]
  );
  return (rows[0] as unknown as ComplaintRow | undefined) ?? null;
}

/** 某诉求当前"进行中"的交办（唯一键保证最多一条） */
export async function findActiveOrderByComplaint(
  db: Tx | typeof pool,
  complaintId: string
): Promise<ComplaintRow | null> {
  const [rows] = await db.query<Row[]>(
    'select ' + ORDER_SELECT_COLUMNS + ORDER_FROM +
      ' where d.active_complaint_id = ? limit 1',
    [complaintId]
  );
  return (rows[0] as unknown as ComplaintRow | undefined) ?? null;
}

/* ---------------- 写入 ---------------- */

export interface InsertOrderInput {
  assignmentId: string;
  orderNo: string;
  complaintId: string;
  complaintTitle: string | null;
  dispatchType: string;
  triggerType: string;
  sensitiveWords: string | null;
  targetEnterpriseCode: string;
  targetEnterpriseName: string;
  deadline: Date | null;
  requestId: string;
  reason: string | null;
  requirement: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

/**
 * 直接插入交办单。唯一性完全交给数据库：
 *   uk_active_dispatch 冲突 -> 调用方应回读既有进行中交办并返回 created=false；
 *   uk_dispatch_request 冲突 -> 幂等键异常，调用方按冲突处理。
 */
export async function insertDispatchOrder(tx: Tx, input: InsertOrderInput): Promise<void> {
  await tx.execute(
    'insert into dispatch_order (' +
      'assignment_id, order_no, complaint_id, complaint_title, dispatch_type, trigger_type,' +
      ' sensitive_words, target_enterprise_code, target_enterprise_name, status, sync_status,' +
      ' external_status, deadline, request_id, reason, requirement, created_by, created_by_name,' +
      ' created_at, updated_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      input.assignmentId,
      input.orderNo,
      input.complaintId,
      input.complaintTitle,
      input.dispatchType,
      input.triggerType,
      input.sensitiveWords,
      input.targetEnterpriseCode,
      input.targetEnterpriseName,
      'pending',
      'not_synced',
      'pending',
      input.deadline,
      input.requestId,
      input.reason,
      input.requirement,
      input.createdBy,
      input.createdByName,
      input.createdAt,
      input.createdAt,
    ]
  );
}

/** 受控撤销：只允许从非终态转入 cancelled；调用方负责先判状态 */
export async function cancelDispatchOrder(
  tx: Tx,
  assignmentId: string,
  cancelReason: string | null,
  cancelledAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    "update dispatch_order set status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?" +
      ' where assignment_id = ?',
    [cancelledAt, cancelReason, cancelledAt, assignmentId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

/* ---------------- 共享：锁住 complaint 行 ---------------- */

export interface LockedComplaint {
  id: number;
  complaint_id: string;
  complaint_no: string;
  title: string;
  enterprise_code: string | null;
  enterprise_name: string | null;
  is_sensitive: number;
  supervision_status: string;
  sensitive_keywords: string | null;
  status: string;
}

/** 非锁定版解析：只取业务键（用于事务外把 idOrNo 归一成 complaint_id） */
export async function findComplaintRefByAnyKey(
  db: Tx | typeof pool,
  idOrNo: string
): Promise<{ id: number; complaint_id: string } | null> {
  const numeric = /^\d+$/.test(idOrNo);
  const where = numeric ? 'id = ?' : '(complaint_id = ? or complaint_no = ?)';
  const params: unknown[] = numeric ? [Number(idOrNo)] : [idOrNo, idOrNo];
  const [rows] = await db.query<Row[]>(
    'select id, complaint_id from complaint where ' + where + ' and coalesce(deleted, 0) = 0 limit 1',
    params
  );
  const row = rows[0] as unknown as { id: number; complaint_id: string } | undefined;
  return row ?? null;
}

/**
 * 锁住交办单行并只取 status。
 * 撤销必须先锁再判状态，否则两个并发撤销会同时通过状态检查、都执行更新。
 */
export async function lockOrderStatus(tx: Tx, assignmentId: string): Promise<string | null> {
  const [rows] = await tx.query<Row[]>(
    'select status from dispatch_order where assignment_id = ? for update',
    [assignmentId]
  );
  const row = rows[0] as { status?: unknown } | undefined;
  return row === undefined || row.status === undefined || row.status === null ? null : String(row.status);
}

/**
 * 按 "数值主键 / complaint_id / complaint_no" 三种形式锁住并读取 complaint 行。
 * G2 的三条写路径（创建交办、分配责任单位、归库处置）共用，保证并发下状态推进不打架。
 */
export async function lockComplaintByAnyKey(tx: Tx, idOrNo: string): Promise<LockedComplaint | null> {
  const numeric = /^\d+$/.test(idOrNo);
  const where = numeric ? 'id = ?' : '(complaint_id = ? or complaint_no = ?)';
  const params: unknown[] = numeric ? [Number(idOrNo)] : [idOrNo, idOrNo];
  const [rows] = await tx.query<Row[]>(
    'select id, complaint_id, complaint_no, title, enterprise_code, enterprise_name,' +
      ' is_sensitive, supervision_status, sensitive_keywords, status' +
      ' from complaint where ' + where + ' and coalesce(deleted, 0) = 0 for update',
    params
  );
  const row = rows[0] as unknown as LockedComplaint | undefined;
  return row ?? null;
}

/**
 * 推进 complaint.supervision_status（G2 三条写路径共用）。
 * 只改这一列 + updated_at，不碰其它任何列——确保不会顺手覆盖人工字段。
 */
export async function updateComplaintSupervision(
  tx: Tx,
  complaintId: string,
  status: string,
  updatedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    'update complaint set supervision_status = ?, updated_at = ? where complaint_id = ?',
    [status, updatedAt, complaintId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

/**
 * 某诉求在没有进行中交办时，督办状态应回到哪个值：
 *   敏感但责任单位仍为空 -> pending_match（留在总账待匹配）
 *   否则                  -> none（未交办）
 * 只在"确实没有进行中交办"时由调用方使用。
 */
export function supervisionStatusWithoutActiveDispatch(complaint: LockedComplaint): string {
  const hasEnterprise =
    complaint.enterprise_code !== null && String(complaint.enterprise_code).trim() !== '';
  if (complaint.is_sensitive === 1 && !hasEnterprise) return 'pending_match';
  return 'none';
}

/* ---------------- G3：推送成功后的状态推进 ---------------- */

/**
 * 推送成功：pending -> pushed，并落对方 task.id 与推送时间。
 * 只改这几列：sync_status 置 success（否则推送成功了还显示"未同步"就是假状态），
 * external_status 保持不动——填报任务创建成功不等于企业已签收。
 */
export async function updatePushSuccess(
  tx: Tx,
  assignmentId: string,
  taskId: string,
  pushedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    "update dispatch_order set status = 'pushed', reporting_task_id = ?, pushed_at = ?," +
      " sync_status = 'success', updated_at = ? where assignment_id = ?",
    [taskId, pushedAt, pushedAt, assignmentId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

/** 推送成功同时推进诉求的填报审批状态轴（来源事件轴仍然只读，不受影响） */
export async function updateComplaintReportingStatus(
  tx: Tx,
  complaintId: string,
  reportingStatus: string,
  updatedAt: Date
): Promise<number> {
  const [result] = await tx.execute(
    'update complaint set reporting_status = ?, updated_at = ? where complaint_id = ?',
    [reportingStatus, updatedAt, complaintId]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}
