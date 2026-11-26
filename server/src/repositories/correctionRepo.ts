import { projectDisposalValue } from '../services/complaintProjection';
import { currentAccessContext, currentScopeSql, relatedScopeSql } from '../auth/accessScope';
// correction_item（纠偏待办，逐字段一行）。
//
// 设计约束（业主 2026-09-20 裁定，推翻 2026-09-17 的旧口径）：
//   * 纠偏是**数据质量轴**，覆盖**所有**诉求，与是否交办、是否审批通过无关；
//     "只有走过督办链路才生成纠偏项"的旧前提已作废（拆闸见 correctionService.generateCorrectionsInTx）。
//   * 本仓库同时负责把"该诉求是否交办过"（hasDispatch）带出来——两条轴并行，页面要能区分交叉状态；
//     是否交办由 dispatch_order 实查，不靠 correction_item.assignment_id（那只是"这条清单由哪次交办触发"的回查线索）。
//   * 每一项都要人工「确认」或「判定无需纠偏」后才不再 pending；
//   * **未纠偏不得进入分析库** —— 是否可入库的判断在 service 层的事务里做（见 correctionService），
//     本仓库只负责读写，不擅自决定业务规则。
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Tx } from '../db/tx';
import type { CorrectionItem, CorrectionItemStatus } from '../types/api';
import { cut, type Queryable } from './complaintSourceLogRepo';
import { toIso } from './complaintMapper';
import { findDispatchedComplaintIds } from './dispatchRepo';

/**
 * 纠偏字段定义。
 * column 为 null 表示该字段在 complaint 表里没有对应列（如企业处置结果）。
 * pairedCodeColumn 非空表示该字段是"主数据编码 + 名称"成对写回的一类：
 *   newValue 的口径是**企业主数据的登记编码**，写回时由 service 侧查 enterprise 表拿到登记名称，
 *   两列一并写入（编码匹配不到登记值直接报错）——见 correctionService.writeBackToComplaint。
 */
export interface CorrectionFieldDef {
  code: string;
  label: string;
  /** 是否要写回 complaint，以及写到哪一列 */
  column: string | null;
  /** 与 column 成对写回的编码列（目前只有责任单位一项） */
  pairedCodeColumn?: string;
}

export const CORRECTION_FIELD_DEFS: readonly CorrectionFieldDef[] = [
  // 责任单位：确认值填 enterprise.enterprise_code（登记编码），写回 code + name 成对，缺一不可
  { code: 'enterprise_name', label: '企业名称/归属', column: 'enterprise_name', pairedCodeColumn: 'enterprise_code' },
  { code: 'district_name', label: '归属区域', column: 'district_name' },
  { code: 'address', label: '地址', column: 'address' },
  { code: 'complaint_type', label: '诉求性质', column: 'complaint_type' },
  { code: 'formal_category', label: '正式大小类', column: null },
  { code: 'location_lng', label: '经度', column: 'location_lng' },
  { code: 'location_lat', label: '纬度', column: 'location_lat' },
  { code: 'summary', label: '诉求摘要', column: 'title' },
  // 企业处置结果来自回传事件，complaint 表没有对应列；确认后的值只用于生成分析记录
  { code: 'disposal_result', label: '企业处置结果', column: null },
];

const DEF_BY_CODE = new Map(CORRECTION_FIELD_DEFS.map((d) => [d.code, d]));

export function fieldDef(code: string): CorrectionFieldDef | null {
  return DEF_BY_CODE.get(code) ?? null;
}

/** Human decisions protect paired district/coordinate columns as one effective group. */
export function protectedColumnsForCorrection(code: string): string[] {
  if (code === 'formal_category') return ['major_category_code','minor_category_code','category_dictionary_version'];
  if (code === 'district_name') return ['district_name', 'district_code'];
  if (code === 'location_lng' || code === 'location_lat') return ['location_lng', 'location_lat'];
  const def = fieldDef(code);
  return def?.column ? [def.column, ...(def.pairedCodeColumn ? [def.pairedCodeColumn] : [])] : [];
}

export function isCorrectionFieldCode(code: string): boolean {
  return DEF_BY_CODE.has(code);
}

export const CORRECTION_STATUSES: readonly CorrectionItemStatus[] = ['pending', 'confirmed', 'rejected'];

export function isCorrectionItemStatus(value: unknown): value is CorrectionItemStatus {
  return typeof value === 'string' && (CORRECTION_STATUSES as readonly string[]).includes(value);
}

const STATUS_LABELS: Record<CorrectionItemStatus, string> = {
  pending: '待纠偏',
  confirmed: '已确认',
  rejected: '无需纠偏',
};

export function statusLabel(status: string): string {
  return isCorrectionItemStatus(status) ? STATUS_LABELS[status] : status;
}

export interface CorrectionRow {
  editVersion?: number;
  effectiveValue?: string | null;
  id: number;
  correctionId: string;
  complaintId: string;
  assignmentId: string | null;
  fieldName: string;
  fieldLabel: string | null;
  oldValue: string | null;
  newValue: string | null;
  basis: string | null;
  status: string;
  confirmerId: string | null;
  confirmerName: string | null;
  confirmedAt: unknown;
  createdAt: unknown;
}

/**
 * 行 -> 契约。hasDispatch **不是** correction_item 里的列，而是该诉求在 dispatch_order 上有没有
 * 进行中/历史交办，必须由调用方实查后显式传进来——默认 false 会让"未交办"变成猜出来的。
 */
export function rowToCorrectionItem(r: CorrectionRow, hasDispatch: boolean): CorrectionItem {
  const status = String(r.status);
  const def = fieldDef(String(r.fieldName));
  return {
    editVersion: Number(r.editVersion ?? 1),
    effectiveValue: r.effectiveValue == null ? null : String(r.fieldName)==='disposal_result'?projectDisposalValue(String(r.effectiveValue)):String(r.effectiveValue),
    id: Number(r.id),
    correctionId: String(r.correctionId),
    complaintId: String(r.complaintId),
    assignmentId: r.assignmentId === null || r.assignmentId === undefined ? null : String(r.assignmentId),
    hasDispatch,
    fieldName: String(r.fieldName),
    fieldLabel: r.fieldLabel === null || r.fieldLabel === undefined ? (def ? def.label : null) : String(r.fieldLabel),
    oldValue: r.oldValue === null || r.oldValue === undefined ? null : String(r.fieldName)==='disposal_result'?projectDisposalValue(String(r.oldValue)):String(r.oldValue),
    newValue: r.newValue === null || r.newValue === undefined ? null : String(r.fieldName)==='disposal_result'?projectDisposalValue(String(r.newValue)):String(r.newValue),
    basis: r.basis === null || r.basis === undefined ? null : String(r.basis),
    status,
    statusName: statusLabel(status),
    confirmerId: r.confirmerId === null || r.confirmerId === undefined ? null : String(r.confirmerId),
    confirmerName: r.confirmerName === null || r.confirmerName === undefined ? null : String(r.confirmerName),
    confirmedAt: toIso(r.confirmedAt),
    createdAt: toIso(r.createdAt),
  };
}

const SELECT_COLUMNS =
  "(select case correction_item.field_name when 'formal_category' then case when c.major_category_code is null then null else json_object('majorCode',c.major_category_code,'minorCode',c.minor_category_code,'dictionaryVersion',c.category_dictionary_version) end " + CORRECTION_FIELD_DEFS.filter(def => def.column).map(def =>
    "when '" + def.code + "' then cast(c." + (def.pairedCodeColumn ?? def.column) + ' as char)'
  ).join(' ') + " when 'disposal_result' then case when correction_item.status = 'confirmed' then correction_item.new_value else correction_item.old_value end else correction_item.old_value end from complaint c where c.complaint_id = correction_item.complaint_id) as effectiveValue," +
  '(select c.edit_version from complaint c where c.complaint_id = correction_item.complaint_id) as editVersion,' +
  ' id, correction_id as correctionId, complaint_id as complaintId, assignment_id as assignmentId,' +
  ' field_name as fieldName, field_label as fieldLabel, old_value as oldValue, new_value as newValue,' +
  ' basis, status, confirmer_id as confirmerId, confirmer_name as confirmerName,' +
  ' confirmed_at as confirmedAt, created_at as createdAt';

export interface InsertCorrectionInput {
  complaintId: string;
  assignmentId: string | null;
  fieldName: string;
  oldValue: string | null;
  createdAt: Date;
}

/** 批量插入纠偏项。调用方必须先确认「该诉求还没有纠偏项」，否则会产生重复清单。 */
export async function insertCorrections(tx: Tx, items: InsertCorrectionInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const item of items) {
    const def = fieldDef(item.fieldName);
    const correctionId = 'COR-' + randomUUID();
    await tx.execute(
      'insert into correction_item ' +
        '(correction_id, complaint_id, assignment_id, field_name, field_label, old_value, new_value,' +
        ' basis, status, created_at) ' +
        "values (?, ?, ?, ?, ?, ?, null, null, 'pending', ?)",
      [
        correctionId,
        cut(item.complaintId, 64),
        cut(item.assignmentId, 64),
        cut(item.fieldName, 64),
        cut(def ? def.label : null, 64),
        item.oldValue,
        item.createdAt,
      ]
    );
    ids.push(correctionId);
  }
  return ids;
}

export async function listByComplaint(db: Queryable, complaintId: string): Promise<CorrectionItem[]> {
  const scope = relatedScopeSql('correction_item.complaint_id');
  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from correction_item where complaint_id = ? and '+scope.sql+' order by id asc',
    [complaintId,...scope.params]
  );
  const list = rows as unknown as CorrectionRow[];
  const dispatched = await findDispatchedComplaintIds(db, [complaintId]);
  const hasDispatch = dispatched.has(complaintId);
  return list.map((row) => rowToCorrectionItem(row, hasDispatch));
}

/** 是否只看在某条轴上的诉求：dispatched=已交办、undispatched=未交办、undefined=全部 */
export type DispatchedFilter = 'dispatched' | 'undispatched';

export interface PendingPageFilter {
  complaintId?: string;
  dispatched?: DispatchedFilter;
}

export interface PendingComplaintSummary {
  complaintId: string;
  complaintNo: string;
  title: string;
  pendingCount: number;
  hasDispatch: boolean;
}

/** 交办轴的子查询：写在 where 里做筛选，不参与 for update，因此不会去锁 dispatch_order */
const DISPATCH_EXISTS = 'exists (select 1 from dispatch_order d where d.complaint_id = correction_item.complaint_id)';

export async function findPendingPage(
  db: Queryable,
  filter: PendingPageFilter,
  page: number,
  size: number
): Promise<{ content: CorrectionItem[]; total: number }> {
  const scope = relatedScopeSql('correction_item.complaint_id');
  const parts: string[] = ["status = 'pending'",scope.sql];
  const params: unknown[] = [...scope.params];
  if (filter.complaintId !== undefined) {
    parts.push('complaint_id = ?');
    params.push(filter.complaintId);
  }
  if (filter.dispatched === 'dispatched') parts.push(DISPATCH_EXISTS);
  if (filter.dispatched === 'undispatched') parts.push('not ' + DISPATCH_EXISTS);
  const where = ' where ' + parts.join(' and ');

  const [countRows] = await db.query(
    'select count(*) as total from correction_item' + where,
    params
  );
  const total = Number(
    (countRows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0
  );

  const [rows] = await db.query(
    'select ' + SELECT_COLUMNS + ' from correction_item' + where +
      ' order by created_at asc, id asc limit ? offset ?',
    [...params, size, (page - 1) * size]
  );
  const list = rows as unknown as CorrectionRow[];
  const dispatched = await findDispatchedComplaintIds(
    db,
    list.map((row) => String(row.complaintId))
  );
  return {
    content: list.map((row) => rowToCorrectionItem(row, dispatched.has(String(row.complaintId)))),
    total,
  };
}

const pendingSummaryLockNameSql = "sha2(concat(database(), ':correction-pending-summary'), 256)";

/** 全量与增量共用一把库级锁，防止其他实例在重建时写入旧快照。 */
async function withPendingSummaryTransaction<T>(db: Pool, refresh: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.getConnection();
  let locked = false;
  let reusable = false;
  try {
    const [[lock]] = await tx.query<RowDataPacket[]>(`select get_lock(${pendingSummaryLockNameSql}, 10) as acquired`);
    reusable = true;
    locked = lock.acquired === 1;
    if (!locked) throw new Error('Timed out acquiring the pending correction summary lock');

    try {
      await tx.beginTransaction();
      const result = await refresh(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        reusable = false;
      }
      throw error;
    }
  } finally {
    try {
      if (locked && reusable) {
        const [[lock]] = await tx.query<RowDataPacket[]>(`select release_lock(${pendingSummaryLockNameSql}) as released`);
        reusable = lock.released === 1;
      }
    } catch {
      reusable = false;
    } finally {
      if (reusable) tx.release();
      else tx.destroy();
    }
  }
}

async function insertPendingSummary(tx: Tx, complaintId?: string): Promise<number> {
  // 先走 (status, complaint_id, created_at) 覆盖索引聚合，再关联诉求和定位状态。
  const targeted = complaintId !== undefined;
  const [result] = await tx.query<ResultSetHeader>(
    'insert into correction_pending_summary (complaint_id, pending_count, first_pending_at, needs_manual_location, manual_location_reason, refreshed_at) ' +
    'select p.complaint_id, p.pending_count, p.first_pending_at, (c.location_lng is null or c.location_lat is null or coalesce(' +
    "li.state in ('review','retry') and li.reason like '地址归网v4：%' and json_unquote(json_extract(c.effective_field_state, '$.location_lng.resolution'))='unresolved', 0)), left(li.reason, 255), now() " +
    'from (select complaint_id, count(*) as pending_count, min(created_at) as first_pending_at from correction_item ' +
    "where status = 'pending'" + (targeted ? ' and complaint_id = ?' : '') + ' group by complaint_id) p ' +
    'join complaint c on c.complaint_id = p.complaint_id ' +
    'left join complaint_location_initialization li on li.complaint_id = p.complaint_id ' +
    'where coalesce(c.deleted, 0) = 0',
    targeted ? [complaintId] : []
  );
  return result.affectedRows;
}

/**
 * 后台定时全量重建待纠偏汇总。
 * 删除和重建同事务提交，读者在提交前仍能查询上一版汇总。
 */
export async function refreshPendingSummary(db: Pool): Promise<number> {
  return withPendingSummaryTransaction(db, async (tx) => {
    await tx.query('delete from correction_pending_summary');
    return insertPendingSummary(tx);
  });
}

/** 近期有纠偏项变动的诉求（新增待处理 / 刚被确认或驳回），供汇总表增量刷新。 */
export async function findRecentlyChangedPendingComplaints(db: Queryable, since: Date, limit = 5000): Promise<string[]> {
  const [rows] = await db.query(
    'select distinct complaint_id from correction_item ' +
      "where (status = 'pending' and created_at >= ?) or (status <> 'pending' and confirmed_at >= ?) limit ?",
    [since, since, limit]
  );
  return (rows as Array<{ complaint_id: string }>).map((r) => String(r.complaint_id));
}

/** 单件诉求的汇总刷新（确认/驳回/新入库后调用，保证用户自己的操作立刻反映到队列）。 */
export async function refreshPendingSummaryFor(db: Pool, complaintId: string): Promise<void> {
  await withPendingSummaryTransaction(db, async (tx) => {
    await tx.query('delete from correction_pending_summary where complaint_id = ?', [complaintId]);
    await insertPendingSummary(tx, complaintId);
  });
}

/** 诉求级待纠偏分页。汇总表每件诉求一行，确保 total 和分页都按诉求数计算。 */
export async function findPendingComplaintPage(
  db: Queryable,
  filter: PendingPageFilter,
  page: number,
  size: number
): Promise<{ content: PendingComplaintSummary[]; total: number }> {
  // 全量授权时不拼 scope 谓词：coalesce(c.deleted,0)=0 会让 4.5 万行的 count 退化到 2.7s
  // （汇总刷新时已排除软删除诉求，这里不再重复判断）
  const ctx = currentAccessContext();
  const restricted = ctx.rules.some((r) => r.kind !== 'all');
  const scope = restricted ? currentScopeSql() : { sql: '', params: [] as unknown[] };
  const parts: string[] = ['1 = 1'];
  const params: unknown[] = [...scope.params];
  if (scope.sql) parts.push(scope.sql);
  if (filter.complaintId !== undefined) {
    parts.push('s.complaint_id = ?');
    params.push(filter.complaintId);
  }
  if (filter.dispatched === 'dispatched') parts.push('exists (select 1 from dispatch_order d where d.complaint_id = s.complaint_id)');
  if (filter.dispatched === 'undispatched') parts.push('not exists (select 1 from dispatch_order d where d.complaint_id = s.complaint_id)');
  const where = ' where ' + parts.join(' and ');
  const from = ' from correction_pending_summary s join complaint c on c.complaint_id = s.complaint_id';

  // 非受限范围时 count 不需要 join complaint（汇总表刷新时已排除软删除）
  const countFrom = restricted ? from : ' from correction_pending_summary s';
  const [countRows] = await db.query('select count(*) as total' + countFrom + where, params);
  const total = Number((countRows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    'select s.complaint_id as complaintId, c.complaint_no as complaintNo, c.title,' +
      ' s.pending_count as pendingCount, s.needs_manual_location as needsManualLocation,' +
      ' s.manual_location_reason as manualLocationReason,' +
      ' exists (select 1 from dispatch_order d where d.complaint_id = s.complaint_id) as hasDispatch' +
      from + where +
      // 自动定位失败的诉求置顶（人工纠偏优先级最高），其余按入队时间
      ' order by s.needs_manual_location desc, s.first_pending_at asc, s.complaint_id asc limit ? offset ?',
    [...params, size, (page - 1) * size]
  );
  return {
    content: (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      complaintId: String(row.complaintId),
      complaintNo: String(row.complaintNo ?? ''),
      title: String(row.title ?? ''),
      pendingCount: Number(row.pendingCount ?? 0),
      hasDispatch: Number(row.hasDispatch) === 1 || row.hasDispatch === true,
      needsManualLocation: Number(row.needsManualLocation) === 1 || row.needsManualLocation === true,
      manualLocationReason: row.manualLocationReason == null ? null : String(row.manualLocationReason),
    })),
    total,
  };
}

export async function countPendingByComplaint(db: Queryable, complaintId: string): Promise<number> {
  const [rows] = await db.query(
    "select count(*) as total from correction_item where complaint_id = ? and" +
      " (status = 'pending' or status not in ('pending', 'confirmed', 'rejected'))",
    [complaintId]
  );
  return Number((rows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);
}

/** 锁住一行纠偏项：并发确认同一项时，只有一个能通过状态检查 */
export async function lockCorrection(tx: Tx, correctionId: string): Promise<CorrectionRow | null> {
  const [rows] = await tx.query(
    'select ' + SELECT_COLUMNS + ' from correction_item where correction_id = ? for update',
    [correctionId]
  );
  const row = (rows as unknown as CorrectionRow[])[0];
  return row ?? null;
}

export const LOCATION_CORRECTION_FIELDS=['district_name','address','location_lng','location_lat'] as const;
export const LOCATION_GROUP_COLUMNS=['district_code','district_name','address','location_lng','location_lat','admin_grid_code','community_code','location_coordinate_system','location_coordinate_source'] as const;
export async function lockLocationCorrections(tx:Tx,complaintId:string):Promise<CorrectionRow[]> {
 const [rows]=await tx.query('select '+SELECT_COLUMNS+' from correction_item where complaint_id = ? and field_name in (?,?,?,?) order by field_name, correction_id for update',[complaintId,...LOCATION_CORRECTION_FIELDS]);
 return rows as CorrectionRow[];
}
/** Caller holds the complaint/group locks and appends the old decision to audit in the same Tx. */
export async function decideLocationCorrection(tx:Tx,row:CorrectionRow,input:DecideCorrectionInput):Promise<void> {
 const [result]=await tx.execute('update correction_item set status=?,new_value=?,basis=?,confirmer_id=?,confirmer_name=?,confirmed_at=? where correction_id=? and status=?',
  [input.status,input.newValue,cut(input.basis,500),input.confirmerId,input.confirmerName,input.decidedAt,row.correctionId,row.status]);
 if(Number((result as {affectedRows:number}).affectedRows)!==1)throw new Error('位置组纠偏决定并发变化');
}

export interface DecideCorrectionInput {
  status: Exclude<CorrectionItemStatus, 'pending'>;
  newValue: string | null;
  basis: string | null;
  confirmerId: string | null;
  confirmerName: string | null;
  decidedAt: Date;
}

export async function decideCorrection(
  tx: Tx,
  correctionId: string,
  input: DecideCorrectionInput
): Promise<number> {
  const [result] = await tx.execute(
    "update correction_item set status = ?, new_value = ?, basis = ?, confirmer_id = ?, confirmer_name = ?," +
      " confirmed_at = ? where correction_id = ? and status = 'pending'",
    [
      input.status,
      input.newValue,
      cut(input.basis, 500),
      cut(input.confirmerId, 64),
      cut(input.confirmerName, 64),
      input.decidedAt,
      correctionId,
    ]
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

/** 某诉求是否已经生成过纠偏清单（幂等判断） */
export async function countByComplaint(db: Queryable, complaintId: string): Promise<number> {
  const [rows] = await db.query(
    'select count(*) as total from correction_item where complaint_id = ?',
    [complaintId]
  );
  return Number((rows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);
}

/* ==================== 批量补挂的可复核口径（R2） ==================== */

/** 存活诉求总数（软删不算）。批量补挂用它做分母。 */
export async function countLiveComplaints(db: Queryable): Promise<number> {
  const scope = currentScopeSql();
  const [rows] = await db.query(
    'select count(*) as total from complaint c where '+scope.sql, scope.params
  );
  return Number((rows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);
}

/** 尚无任何纠偏项的诉求数。补挂完成后必须为 0，非 0 就是没覆盖全。 */
export async function countComplaintsWithoutCorrections(db: Queryable): Promise<number> {
  const scope = currentScopeSql();
  const [rows] = await db.query(
    'select count(*) as total from complaint c' +
      " left join correction_item ci on ci.complaint_id = c.complaint_id where ci.id is null" +
      ' and '+scope.sql, scope.params
  );
  return Number((rows as unknown as Array<{ total: number | string }>)[0]?.total ?? 0);
}

/**
 * 取一批"还没有任何纠偏项"的诉求业务键，按主键升序（顺序稳定 ⇒ 复跑结果可比对）。
 * 只为补挂服务：生成走的是与入站/回调同一条 generateCorrectionsInTx，不另造一份清单口径。
 */
export async function findComplaintIdsWithoutCorrections(
  db: Queryable,
  limit: number
): Promise<string[]> {
  const scope = currentScopeSql();
  const [rows] = await db.query(
    'select c.complaint_id as complaintId from complaint c' +
      " left join correction_item ci on ci.complaint_id = c.complaint_id where ci.id is null" +
      ' and '+scope.sql+' order by c.id asc limit ?',
    [...scope.params,limit]
  );
  return (rows as unknown as Array<{ complaintId: string }>).map((r) => String(r.complaintId));
}
