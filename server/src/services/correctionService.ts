// G5 纠偏与入库服务：最终回传 -> 纠偏待办 -> 分析库 -> 待查报告待办。
//
// 三条业务规则（业主 2026-09-17 确认，不得自行发挥）：
//   1) 本系统办结 = 最终审批通过 + 纠偏全部确认之后，再由**人工显式**办结；机器只给条件与校验（见 closureService）。
//   2) 未交办 / 误报归库的诉求**不纳入分析库**，只在总账可查。所以入库前必须验"有交办单"。
//   3) 待查报告只做待办入口，报告正文与发布规则后置。
//
// ★ 本文件最关键的一条：**未纠偏不得进入分析库**（maybeEnterAnalysis 是唯一入库入口）。
import type { CorrectionGenerateResult, CorrectionItem, CorrectionConfirmRequest, CorrectionRejectRequest, Paged } from '../types/api';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { withTransaction, type Tx } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { insertFieldVersions } from '../repositories/complaintFieldVersionRepo';
import { findComplaintRefByAnyKey } from '../repositories/dispatchRepo';
import {
  CORRECTION_FIELD_DEFS,
  countByComplaint,
  countPendingByComplaint,
  decideCorrection,
  fieldDef,
  findPendingPage,
  insertCorrections,
  listByComplaint,
  lockCorrection,
  rowToCorrectionItem,
} from '../repositories/correctionRepo';
import {
  findAnalysisByComplaint,
  hasDispatchOrder,
  insertAnalysisIfAbsent,
} from '../repositories/analysisRepo';
import { insertTodoIfAbsent } from '../repositories/reportTodoRepo';
import { GQXQ_APP_CODE } from './intakeService';
import { optionalText, type OperatorContext } from './dispatchService';

/* ==================== 参数解析 ==================== */

export interface PageQuery {
  page: number;
  size: number;
}

export function parsePageQuery(query: Record<string, unknown>, defaultSize = 20): PageQuery {
  const rawPage = query.page === undefined ? 1 : Number(query.page);
  const rawSize = query.size === undefined ? defaultSize : Number(query.size);
  if (!Number.isInteger(rawPage) || rawPage < 1) {
    throw AppError.validation('page 必须是 >=1 的整数', [{ field: 'page', message: '必须 >= 1' }]);
  }
  if (!Number.isInteger(rawSize) || rawSize < 1 || rawSize > 100) {
    throw AppError.validation('size 必须在 1..100', [{ field: 'size', message: '必须在 1..100' }]);
  }
  return { page: rawPage, size: rawSize };
}

export function queryText(raw: unknown, field: string, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) {
    throw AppError.validation('参数 ' + field + ' 长度不能超过 ' + max, [
      { field, message: '最长 ' + max + ' 字符' },
    ]);
  }
  return trimmed;
}

function paged<T>(content: T[], total: number, page: number, size: number): Paged<T> {
  return { content, total, page, size, totalPages: Math.ceil(total / size) };
}

/* ==================== complaint 读取 ==================== */

interface ComplaintFullRow {
  complaint_id: string;
  complaint_no: string;
  title: string;
  enterprise_code: string | null;
  enterprise_name: string | null;
  district_code: string | null;
  district_name: string | null;
  address: string | null;
  business_type: string;
  complaint_type: string;
  location_lng: unknown;
  location_lat: unknown;
  reporting_status: string;
  supervision_status: string;
}

const COMPLAINT_FULL_COLUMNS =
  'complaint_id, complaint_no, title, enterprise_code, enterprise_name, district_code, district_name,' +
  ' address, business_type, complaint_type, location_lng, location_lat, reporting_status, supervision_status';

async function resolveComplaintId(db: Tx | typeof pool, idOrNo: string): Promise<string> {
  const ref = await findComplaintRefByAnyKey(db, idOrNo);
  if (!ref) throw AppError.notFound('诉求不存在');
  return String(ref.complaint_id);
}

/** 锁住诉求行。**先锁 complaint 再锁 correction**，保证并发确认同一诉求时不会交错。 */
async function lockComplaintFull(tx: Tx, complaintId: string): Promise<ComplaintFullRow> {
  const [rows] = await tx.query(
    'select ' + COMPLAINT_FULL_COLUMNS + ' from complaint where complaint_id = ? for update',
    [complaintId]
  );
  const row = (rows as unknown as ComplaintFullRow[])[0];
  if (!row) throw AppError.notFound('诉求不存在');
  return row;
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

/** 企业处置结果来自回传事件（task_approved 的 payload.enterpriseDisposalResult）。 */
async function loadDisposalResult(
  db: Tx | typeof pool,
  complaintId: string,
  assignmentId: string | null
): Promise<string | null> {
  const taskId = await loadReportingTaskId(db, assignmentId);
  const [rows] = await db.query(
    "select payload from business_event where (task_id = ? or source_business_id = ?)" +
      " and event_type = 'task_approved' order by id desc limit 1",
    [taskId ?? '', complaintId]
  );
  const row = (rows as unknown as Array<{ payload: unknown }>)[0];
  if (!row || row.payload === null || row.payload === undefined) return null;
  let parsed: unknown = row.payload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return String(parsed);
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const disposal = (parsed as Record<string, unknown>).enterpriseDisposalResult;
  if (disposal === null || disposal === undefined) return null;
  if (typeof disposal === 'string') return disposal;
  try {
    return JSON.stringify(disposal);
  } catch {
    return String(disposal);
  }
}

async function loadReportingTaskId(
  db: Tx | typeof pool,
  assignmentId: string | null
): Promise<string | null> {
  if (assignmentId === null) return null;
  const [rows] = await db.query(
    'select reporting_task_id as taskId from dispatch_order where assignment_id = ? limit 1',
    [assignmentId]
  );
  const row = (rows as unknown as Array<{ taskId: string | null }>)[0];
  return row && row.taskId !== null && row.taskId !== undefined ? String(row.taskId) : null;
}

/** 取该诉求最近一条交办（纠偏项要记录来源交办，便于回查是哪个任务触发的） */
async function loadLatestAssignmentId(db: Tx | typeof pool, complaintId: string): Promise<string | null> {
  const [rows] = await db.query(
    'select assignment_id as assignmentId from dispatch_order where complaint_id = ? order by id desc limit 1',
    [complaintId]
  );
  const row = (rows as unknown as Array<{ assignmentId: string }>)[0];
  return row ? String(row.assignmentId) : null;
}

/* ==================== 生成纠偏待办 ==================== */

export interface GenerateCorrectionInput {
  complaintId: string;
  /** 触发来源交办；为空时按该诉求最近一条交办回填 */
  assignmentId: string | null;
  operatorId: string | null;
  operatorName: string | null;
  now: Date;
}

/**
 * 生成纠偏清单（逐字段一行）。
 * **幂等**：已生成过则不再插入，直接返回既有清单（created=false）。
 * 前提：最终审批通过（reporting_status=approved）且走过督办链路（有交办单）。
 *
 * 被 G4 回调（task_approved + agreed 进入 completed 后）与手工入口共用。
 */
export async function generateCorrectionsInTx(
  tx: Tx,
  input: GenerateCorrectionInput
): Promise<CorrectionGenerateResult> {
  const complaint = await lockComplaintFull(tx, input.complaintId);

  if (complaint.reporting_status !== 'approved') {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      '该诉求填报审批状态为 ' + complaint.reporting_status + '，只有最终审批通过（approved）后才生成纠偏待办'
    );
  }
  if (!(await hasDispatchOrder(tx, input.complaintId))) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      '该诉求从未产生交办，未走过督办链路，不纳入分析口径，不生成纠偏待办'
    );
  }

  const assignmentId = input.assignmentId ?? (await loadLatestAssignmentId(tx, input.complaintId));
  if (assignmentId === null) {
    throw new AppError('INVALID_STATE_TRANSITION', '未找到该诉求的交办记录，无法生成纠偏待办');
  }

  const existingCount = await countByComplaint(tx, input.complaintId);
  if (existingCount > 0) {
    const items = await listByComplaint(tx, input.complaintId);
    return {
      complaintId: input.complaintId,
      assignmentId,
      created: false,
      total: items.length,
      items,
    };
  }

  const disposalResult = await loadDisposalResult(tx, input.complaintId, assignmentId);
  const currentValues: Record<string, string | null> = {
    enterprise_name: textOf(complaint.enterprise_name),
    district_name: textOf(complaint.district_name),
    address: textOf(complaint.address),
    complaint_type: textOf(complaint.complaint_type),
    location_lng: textOf(complaint.location_lng),
    location_lat: textOf(complaint.location_lat),
    summary: textOf(complaint.title),
    disposal_result: disposalResult,
  };

  const insertItems = CORRECTION_FIELD_DEFS.map((def) => ({
    complaintId: input.complaintId,
    assignmentId,
    fieldName: def.code,
    oldValue: currentValues[def.code] ?? null,
    createdAt: input.now,
  }));

  await insertCorrections(tx, insertItems);

  await insertAudit(tx, {
    userId: input.operatorId,
    appCode: GQXQ_APP_CODE,
    resourceCode: complaint.complaint_no,
    action: 'CORRECTION_GENERATE',
    bizType: 'complaint',
    bizId: input.complaintId,
    result: 'success',
    clientIp: null,
    detail: { assignmentId, itemCount: insertItems.length, source: input.operatorName === null ? 'callback' : 'manual' },
    createdAt: input.now,
  });

  const items = await listByComplaint(tx, input.complaintId);
  return { complaintId: input.complaintId, assignmentId, created: true, total: items.length, items };
}

/** 手工/回调入口：解析 idOrNo 后开事务 */
export async function generateCorrections(
  idOrNo: string,
  ctx: OperatorContext
): Promise<CorrectionGenerateResult> {
  const complaintId = await resolveComplaintId(pool, idOrNo);
  const now = new Date();
  return withTransaction(async (tx) =>
    generateCorrectionsInTx(tx, {
      complaintId,
      assignmentId: null,
      operatorId: ctx.userId,
      operatorName: ctx.userName,
      now,
    })
  );
}

/* ==================== 入库（唯一入口） ==================== */

export interface AnalysisEntryOutcome {
  entered: boolean;
  analysisId: string | null;
  reason: string | null;
}

/**
 * 判断并执行"进入分析库"。
 *
 * 两道门：
 *   1) 该诉求**所有**纠偏项都不再 pending —— 这就是"未纠偏不得进入分析库"；
 *   2) 该诉求走过督办链路（有交办单）—— 未交办 / 误报归库的诉求不纳入分析口径。
 *
 * 并发说明：MySQL 没有跨表 CHECK，无法把门规写成数据库约束。
 * 因此用"锁诉求行 + 事务内计数"来串行化，再用 analysis_record.uk_ar_complaint
 * 做最终兜底——即便两条请求同时判定可入库，也只有一条插入成功。
 */
export async function maybeEnterAnalysis(
  tx: Tx,
  input: { complaintId: string; operatorId: string | null; operatorName: string | null; now: Date }
): Promise<AnalysisEntryOutcome> {
  const complaint = await lockComplaintFull(tx, input.complaintId);

  const pending = await countPendingByComplaint(tx, input.complaintId);
  if (pending > 0) {
    return { entered: false, analysisId: null, reason: '仍有 ' + pending + ' 项待纠偏，未纠偏不得进入分析库' };
  }

  if (!(await hasDispatchOrder(tx, input.complaintId))) {
    return {
      entered: false,
      analysisId: null,
      reason: '该诉求未走过督办链路（无交办单），按业主确认口径不纳入分析库',
    };
  }

  const already = await findAnalysisByComplaint(tx, input.complaintId);
  if (already !== null) {
    return { entered: false, analysisId: already.analysisId, reason: '该诉求已在分析库中' };
  }

  const assignmentId = await loadLatestAssignmentId(tx, input.complaintId);
  const disposalResult = await loadDisposalResult(tx, input.complaintId, assignmentId);

  const outcome = await insertAnalysisIfAbsent(tx, {
    complaintId: input.complaintId,
    assignmentId,
    businessType: textOf(complaint.business_type),
    complaintType: textOf(complaint.complaint_type),
    districtCode: textOf(complaint.district_code),
    districtName: textOf(complaint.district_name),
    enterpriseCode: textOf(complaint.enterprise_code),
    enterpriseName: textOf(complaint.enterprise_name),
    summary: textOf(complaint.title),
    disposalResult,
    payload: {
      source: 'correction_confirmed',
      supervisionStatus: complaint.supervision_status,
      reportingStatus: complaint.reporting_status,
    },
    confirmedAt: input.now,
    createdAt: input.now,
  });

  if (!outcome.created) {
    return { entered: false, analysisId: outcome.analysisId, reason: '该诉求已在分析库中（并发兜底命中唯一键）' };
  }

  const todo = await insertTodoIfAbsent(tx, {
    analysisId: outcome.analysisId,
    complaintId: input.complaintId,
    note: '纠偏全部确认后自动生成；报告正文与发布规则待业务确认',
    createdAt: input.now,
  });

  await insertAudit(tx, {
    userId: input.operatorId,
    appCode: GQXQ_APP_CODE,
    resourceCode: complaint.complaint_no,
    action: 'ANALYSIS_INCLUDED',
    bizType: 'analysis_record',
    bizId: outcome.analysisId,
    result: 'success',
    clientIp: null,
    detail: {
      complaintId: input.complaintId,
      assignmentId,
      reportTodoId: todo.todoId,
      reportTodoCreated: todo.created,
    },
    createdAt: input.now,
  });

  return { entered: true, analysisId: outcome.analysisId, reason: null };
}

/* ==================== 确认 / 拒绝一项纠偏 ==================== */

/**
 * 写回目标列里是数值型的那几个。
 * 必须做类型校验：把请求里的字符串直接绑进 DECIMAL 列，MySQL 会直接报错，
 * 接口就变成 500 —— 而这是**参数错误，应当是 400 VALIDATION_FAILED**（实测确有此缺陷）。
 * 这里只做"是不是数值 + 全局经纬度范围"的校验，不发明业务范围规则。
 */
const NUMERIC_WRITE_BACK: Record<string, { field: string; min: number; max: number }> = {
  location_lng: { field: '经度', min: -180, max: 180 },
  location_lat: { field: '纬度', min: -90, max: 90 },
};

function coerceWriteBackValue(def: { code: string; label: string }, newValue: string): string | number {
  const rule = NUMERIC_WRITE_BACK[def.code];
  if (rule === undefined) return newValue;
  const trimmed = newValue.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed)) {
    throw AppError.validation(rule.field + ' 必须是数值', [
      { field: 'newValue', message: rule.field + ' 只能填数值，收到的是「' + newValue + '」' },
    ]);
  }
  if (parsed < rule.min || parsed > rule.max) {
    throw AppError.validation(rule.field + ' 超出有效范围', [
      { field: 'newValue', message: rule.field + ' 应在 ' + rule.min + ' 到 ' + rule.max + ' 之间，收到 ' + parsed },
    ]);
  }
  return parsed;
}

/** 纠偏确认后要把改对的字段写回 complaint —— 纠偏的目的就是改对数据。 */
async function writeBackToComplaint(
  tx: Tx,
  complaint: ComplaintFullRow,
  fieldName: string,
  newValue: string,
  ctx: OperatorContext,
  now: Date
): Promise<boolean> {
  const def = fieldDef(fieldName);
  if (!def || def.column === null) return false;
  const bound = coerceWriteBackValue(def, newValue);
  // 旧值必须从当前行取真实值：原先这里写死 null，等于审计里丢掉了「改之前是什么」。
  const oldValue = textOf((complaint as unknown as Record<string, unknown>)[def.column]);
  await tx.execute(
    'update complaint set ' + def.column + ' = ?, updated_at = ? where complaint_id = ?',
    [bound, now, complaint.complaint_id]
  );
  await insertFieldVersions(tx, [
    {
      complaintId: complaint.complaint_id,
      fieldName: def.column,
      oldValue,
      newValue,
      changeSource: 'manual_edit',
      reason: 'G5 纠偏确认：' + def.label,
      operatorId: ctx.userId,
      operatorName: ctx.userName,
      changedAt: now,
    },
  ]);
  return true;
}

interface DecideOutcome {
  item: CorrectionItem;
  analysisEntered: boolean;
  analysisId: string | null;
  analysisReason: string | null;
  writtenBack: boolean;
}

async function decide(
  correctionId: string,
  status: 'confirmed' | 'rejected',
  rawBody: unknown,
  ctx: OperatorContext
): Promise<DecideOutcome> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const now = new Date();

  // 先取 complaintId（不加锁），再按固定顺序：锁 complaint -> 锁 correction。
  // 顺序固定是为了避免与其它路径交叉加锁造成死锁。
  const [probe] = await pool.query(
    'select complaint_id as complaintId from correction_item where correction_id = ? limit 1',
    [correctionId]
  );
  const probeRow = (probe as unknown as Array<{ complaintId: string }>)[0];
  if (!probeRow) throw AppError.notFound('纠偏项不存在');
  const complaintId = String(probeRow.complaintId);

  const result = await withTransaction(async (tx) => {
    const complaint = await lockComplaintFull(tx, complaintId);
    const locked = await lockCorrection(tx, correctionId);
    if (!locked) throw AppError.notFound('纠偏项不存在');
    if (String(locked.status) !== 'pending') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        '该纠偏项已是「' + String(locked.status) + '」，不能重复处置'
      );
    }

    let newValue: string | null = null;
    let writtenBack = false;
    if (status === 'confirmed') {
      newValue = optionalText((body as CorrectionConfirmRequest).newValue, 'newValue', 2000);
      if (newValue !== null && newValue !== locked.oldValue) {
        writtenBack = await writeBackToComplaint(tx, complaint, String(locked.fieldName), newValue, ctx, now);
      }
    }
    const basis = optionalText(
      (body as CorrectionRejectRequest).basis ?? (body as CorrectionConfirmRequest).basis,
      'basis',
      500
    );

    const affected = await decideCorrection(tx, correctionId, {
      status,
      newValue,
      basis,
      confirmerId: ctx.userId,
      confirmerName: ctx.userName,
      decidedAt: now,
    });
    if (affected === 0) {
      throw new AppError('INVALID_STATE_TRANSITION', '该纠偏项已被其它请求处置，请刷新后重试');
    }

    const analysis = await maybeEnterAnalysis(tx, {
      complaintId,
      operatorId: ctx.userId,
      operatorName: ctx.userName,
      now,
    });

    // 审计动作名是自由文本（与 LOGIN / INTAKE_CREATE / DISPATCH_PUSH 同类），不是业务枚举，
    // 不受"业务枚举一律小写"约束。写成变量是因为门禁的 action: 字面量豁免认不出三元表达式。
    const auditAction = status === 'confirmed' ? 'CORRECTION_CONFIRM' : 'CORRECTION_REJECT'; // gate-g1-allow
    await insertAudit(tx, {
      userId: ctx.userId,
      appCode: GQXQ_APP_CODE,
      resourceCode: complaint.complaint_no,
      action: auditAction,
      bizType: 'complaint',
      bizId: complaintId,
      result: 'success',
      clientIp: ctx.clientIp,
      detail: {
        correctionId,
        fieldName: locked.fieldName,
        oldValue: locked.oldValue,
        newValue,
        basis,
        writtenBack,
        analysisEntered: analysis.entered,
        analysisId: analysis.analysisId,
        analysisReason: analysis.reason,
      },
      createdAt: now,
    });

    const items = await listByComplaint(tx, complaintId);
    const item = items.find((x) => x.correctionId === correctionId) ?? rowToCorrectionItem(locked);
    return {
      item,
      analysisEntered: analysis.entered,
      analysisId: analysis.analysisId,
      analysisReason: analysis.reason,
      writtenBack,
    };
  });

  return result;
}

export async function confirmCorrection(
  correctionId: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<DecideOutcome> {
  return decide(correctionId, 'confirmed', rawBody, ctx);
}

export async function rejectCorrection(
  correctionId: string,
  rawBody: unknown,
  ctx: OperatorContext
): Promise<DecideOutcome> {
  return decide(correctionId, 'rejected', rawBody, ctx);
}

/* ==================== 查询 ==================== */

export async function listPendingCorrections(
  query: Record<string, unknown>
): Promise<Paged<CorrectionItem>> {
  const { page, size } = parsePageQuery(query);
  const complaintIdRaw = queryText(query.complaintId, 'complaintId', 64);
  const complaintId =
    complaintIdRaw === undefined ? undefined : await resolveComplaintId(pool, complaintIdRaw);
  const { content, total } = await findPendingPage(pool, { complaintId }, page, size);
  return paged(content, total, page, size);
}

export async function listComplaintCorrections(idOrNo: string): Promise<CorrectionItem[]> {
  const complaintId = await resolveComplaintId(pool, idOrNo);
  return listByComplaint(pool, complaintId);
}

/** 供 closureService 复用的前置块：还有多少待纠偏 */
export async function pendingCorrectionCount(
  db: Tx | typeof pool,
  complaintId: string
): Promise<number> {
  return countPendingByComplaint(db, complaintId);
}
