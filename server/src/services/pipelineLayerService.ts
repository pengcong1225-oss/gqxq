/**
 * 管线图层服务（标书 1.2.7 管线图层对接）
 *
 * 标书原文要求：
 *   建设管线图层，将图层分为燃气管线图层和供水管线图层，根据管道施工改造上报的信息，
 *   获取涉及的网格，若涉及改造事件的网格将形成色块高亮显示，点击可查看改造事件的信息，
 *   包括改造项目名称、企业名称、时间范围、现场施工人数、相关诉求等信息，
 *   点击查看更多可获取管道改造详情，其中基础信息包括项目名称、企业名称、时间范围、
 *   现场施工人数、改造原因、影响区域、应急预案等信息，
 *   此外对于影响区域可查看每个网格历史产生的管道改造事件信息。
 *
 * 投标技术方案第 755 行的实现口径约束：
 *   「缺少精确管线几何时展示真实上报的影响网格和范围，不画虚构管线」
 *   「一个项目可涉及多个网格，空间关系以项目号关联，网格重叠不能合并不同项目」
 *
 * 因此本服务的落图单位是**网格**（不是管线几何）：
 *   项目 → admin_grid_codes（可能多个）→ 每个网格聚合出「项目数 + 状态分布」
 *   前端按网格画色块，而不是画管线线条。
 */
import {createHash} from 'node:crypto';
import type {Pool, RowDataPacket} from 'mysql2/promise';
import {canAccessComplaint, type AccessContext} from '../auth/accessScope';
import {feedTime, UNKNOWN_TIME_SENTINEL, type MappedUtilitySource, type UtilityFeedItem} from '../domain/utilityFeed';
import {normalizeShanghaiDay, shanghaiToday} from '../domain/statisticsQuery';
import type {UtilityEvent} from '../types/utility';
import {readUtilityFeed} from './utilityIntegrationService';
import {readStoredUtilityApplications} from './utilityService';

/** 业务类型：供水 / 燃气（与表里 business_type 的取值一致） */
export type PipelineBusinessType = 'water' | 'gas';

/** 项目施工状态（归一化后） */
export type PipelineStatus = 'in_progress' | 'not_started' | 'completed' | 'rejected' | 'cancelled' | 'unknown';

/** 单个改造项目（供详情展示） */
export interface PipelineProjectItem {
  projectId: string;
  projectNo: string | null;
  projectName: string;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  businessType: PipelineBusinessType | string;
  source: 'utility-application' | 'legacy-project';
  status: PipelineStatus;
  statusLabel: string;
  /** 施工时间范围（标书要求） */
  startDate: string | null;
  endDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** 现场施工人数（标书要求） */
  workerCount: number | null;
  /** 改造原因（标书要求） */
  constructionReason: string | null;
  /** 影响区域（标书要求） */
  affectedArea: string | null;
  /** 应急预案（标书要求） */
  emergencyPlan: string | null;
  /** 管线长度（米，如有） */
  pipelineLength: number | null;
  /** 施工进度（%） */
  progress: number | null;
  /** 涉及网格（可能多个） */
  gridCodes: string[];
  approvalStatus: string | null;
  /** 来源追溯 */
  sourceApplyNo: string | null;
  sourceEventNo: string | null;
  sourceRevision: string | null;
}

/** 按网格聚合的图层数据（前端直接画色块） */
export interface PipelineGridCell {
  gridCode: string;
  /** 该网格涉及的改造项目数 */
  projectCount: number;
  /** 施工中的项目数（用于热力强度） */
  inProgressCount: number;
  /** 状态分布 */
  statusCounts: Record<string, number>;
  /** 项目列表（点击网格后展示） */
  projects: PipelineProjectItem[];
}

export interface PipelineLayerResult {
  businessType: PipelineBusinessType | 'all';
  /** 网格聚合结果 */
  cells: PipelineGridCell[];
  /** 涉及项目的网格总数 */
  gridCount: number;
  /** 项目总数 */
  projectCount: number;
  /** 可见且尚未关联完整核验网格的项目 */
  unlocatedProjects: PipelineProjectItem[];
  /** 状态口径说明 */
  statusNote: string;
  /** 数据缺失提示（表里没数据 / 缺网格关联时如实说明） */
  dataNote: string | null;
}

/** 状态归一化：把各种写法收敛到固定枚举（展示时配中文标签） */
const STATUS_LABEL: Record<PipelineStatus, string> = {
  in_progress: '施工中',
  not_started: '未开工',
  completed: '已完工',
  rejected: '未批准',
  cancelled: '已取消',
  unknown: '状态未知',
};

function normalizeStatus(raw: unknown, approval: unknown): PipelineStatus {
  // 审批状态优先：未批准 / 已取消 与有效施工项目分开标识（技术方案要求）
  const appr = String(approval ?? '').trim().toLowerCase();
  if (appr === 'rejected' || appr === 'refused') return 'rejected';
  if (appr === 'cancelled' || appr === 'canceled') return 'cancelled';

  const s = String(raw ?? '').trim().toLowerCase();
  if (['in_progress', 'ongoing', 'processing', 'active', '施工中'].includes(s)) return 'in_progress';
  if (['not_started', 'pending', 'planned', 'ready', '未开工'].includes(s)) return 'not_started';
  if (['completed', 'done', 'finished', '已完工', '已竣工'].includes(s)) return 'completed';
  if (['rejected', 'refused'].includes(s)) return 'rejected';
  if (['cancelled', 'canceled', '已取消'].includes(s)) return 'cancelled';
  return 'unknown';
}

/** 解析 admin_grid_codes（JSON 列在 mysql2 下可能是字符串或数组） */
function parseGridCodes(raw: unknown): string[] {
  if (!raw) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      // 兼容「逗号分隔」的历史写法
      arr = raw.split(',');
    }
  }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((v) => String(v ?? '').trim()))].sort();
}

/** 日期归一（MySQL date → YYYY-MM-DD） */
function fmtDate(v: unknown): string | null {
  if (v instanceof Date && Number.isFinite(v.getTime())) return shanghaiToday(() => v);
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    return normalizeShanghaiDay(v.trim());
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const cleanText = (value: unknown) => (typeof value === 'string' ? value.trim() || null : null);
const applicationNumber = (value: unknown) => {
  const number = cleanText(value);
  return number && !number.startsWith('SIM-') ? number : null;
};
const applicationTime = (value: unknown) => value === UNKNOWN_TIME_SENTINEL ? null : feedTime(value);

function verifiedGridCodes(codes: string[], districts: Map<string, string>) {
  // An incomplete coverage set cannot authorize access to the project's full scope.
  return codes.every(code => districts.has(code)) ? [...new Set(codes)].sort() : [];
}

function canReadProject(project: PipelineProjectItem, districts: Map<string, string>, access: AccessContext) {
  if (!project.gridCodes.length) {
    return access.rules.some(rule => rule.kind === 'all' || (
      rule.districtCodes.length === 0 && project.enterpriseCode !== null && rule.enterpriseCodes.includes(project.enterpriseCode)
    ));
  }
  return project.gridCodes.every(code => canAccessComplaint(access, {
    enterprise_code: project.enterpriseCode,
    district_code: districts.get(code),
  }));
}

function latestApplications(sources: MappedUtilitySource[]) {
  // Later feed entries supersede older copies even when the latest state cannot be projected.
  const latest = new Map<string, MappedUtilitySource>();
  for (const entry of sources) {
    if (entry.source.kind !== 'construction') continue;
    const number = applicationNumber(entry.source.sourceApplicationNo);
    if (!number) continue;
    const previous = latest.get(number)?.source;
    const changedAt = feedTime(entry.source.changedAt) ?? '';
    const previousChangedAt = feedTime(previous?.changedAt) ?? '';
    if (!previous || changedAt > previousChangedAt || (changedAt === previousChangedAt && entry.source.feedId > previous.feedId)) {
      latest.set(number, entry);
    }
  }
  return latest;
}

function projectApplication(
  number: string,
  events: UtilityEvent[],
  source: UtilityFeedItem | undefined,
  districts: Map<string, string>,
  enterprises: Map<string, RowDataPacket>,
): PipelineProjectItem | null {
  const event = events[0];
  if (!event || (event.businessType !== 'water' && event.businessType !== 'gas')) return null;
  const enterprise = enterprises.get(event.enterpriseId);
  if (!enterprise || enterprise.business_type !== event.businessType) return null;
  if (!events.every(part => part.kind === 'pipeline' && part.mode === 'real' && part.approvalStatus === 'approved'
    && !!cleanText(part.approvedBy) && !!applicationTime(part.approvedAt) && applicationNumber(part.sourceApplicationNo) === number
    && part.enterpriseId === event.enterpriseId && part.businessType === event.businessType
    && part.startsAt === event.startsAt && part.endsAt === event.endsAt
    && (!source || part.sourceRevision === source.revision))) return null;

  const gridsVerified = events.every(part => !part.gridUnresolved && part.gridIds.length > 0
    && (!source || part.hasVerifiedGrid === true)
    && part.gridIds.every(code => districts.get(code) === part.districtCode));
  const gridCodes = gridsVerified ? verifiedGridCodes(events.flatMap(part => part.gridIds), districts) : [];
  const fields = source?.fields;
  const constructionStatus = fields?.isZtjgys === '是' ? 'completed' : fields?.constructionStatus ?? fields?.projectStatus;
  const status = normalizeStatus(constructionStatus, event.approvalStatus);
  const startsAt = applicationTime(event.startsAt);
  const endsAt = applicationTime(event.endsAt);
  return {
    projectId: 'utility-' + createHash('sha256').update(number).digest('hex'),
    projectNo: cleanText(fields?.projectNo),
    projectName: source ? cleanText(fields?.projectName ?? fields?.title) ?? `管道施工改造申请 ${number}` : event.title,
    enterpriseCode: event.enterpriseId,
    enterpriseName: cleanText(enterprise.enterprise_name),
    businessType: event.businessType,
    source: 'utility-application',
    status,
    statusLabel: STATUS_LABEL[status],
    startDate: startsAt ? shanghaiToday(() => new Date(startsAt)) : fmtDate(fields?.startsAt ?? fields?.kgDate),
    endDate: endsAt ? shanghaiToday(() => new Date(endsAt)) : fmtDate(fields?.endsAt ?? fields?.jhwcDate),
    startsAt,
    endsAt,
    workerCount: numOrNull(source ? fields?.workers ?? fields?.workerCount : event.workers),
    constructionReason: cleanText(event.reason),
    affectedArea: cleanText(fields?.affectedArea ?? fields?.constructionArea) ?? cleanText(event.area),
    emergencyPlan: cleanText(fields?.emergencyPlan ?? fields?.plan) ?? (source ? null : cleanText(event.plan)),
    pipelineLength: numOrNull(fields?.pipelineLength),
    progress: numOrNull(fields?.progress),
    gridCodes,
    approvalStatus: event.approvalStatus,
    sourceApplyNo: number,
    sourceEventNo: cleanText(fields?.sourceEventNo),
    sourceRevision: source?.revision ?? String(event.revision),
  };
}

async function readPipelineProjects(db: Pool, access: AccessContext) {
  const [feed, imported, [gridRows], [enterpriseRows], [legacyRows]] = await Promise.all([
    readUtilityFeed('real', db),
    readStoredUtilityApplications('real', db),
    db.query<RowDataPacket[]>('select code, district_code from admin_grid'),
    db.query<RowDataPacket[]>('select enterprise_code, enterprise_name, business_type from enterprise'),
    db.query<RowDataPacket[]>(
      `select project_id, project_no, project_name, enterprise_code, enterprise_name, business_type,
            status, approval_status, start_date, end_date, worker_count,
            construction_reason, affected_area, emergency_plan, pipeline_length,
            progress, admin_grid_codes, source_apply_no, source_event_no, source_version
       from pipeline_project`
    ),
  ]);
  const districts = new Map<string, string>(gridRows.flatMap(row => {
    const code = cleanText(row.code), district = cleanText(row.district_code);
    return code && district ? [[code, district]] : [];
  }));
  const enterprises = new Map<string, RowDataPacket>(enterpriseRows.map(row => [row.enterprise_code, row]));
  const sources = latestApplications(feed.state?.sources ?? []);
  const knownNumbers = new Set(sources.keys());
  const projects: PipelineProjectItem[] = [];
  for (const [number, entry] of sources) {
    const project = projectApplication(number, entry.events, entry.source, districts, enterprises);
    if (project) projects.push(project);
  }
  for (const event of imported.state.events ?? []) {
    if (event.mode !== 'real' || event.kind !== 'pipeline') continue;
    const number = applicationNumber(event.sourceApplicationNo);
    if (!number || knownNumbers.has(number)) continue;
    knownNumbers.add(number);
    const project = projectApplication(number, [event], undefined, districts, enterprises);
    if (project) projects.push(project);
  }

  for (const r of legacyRows) {
    const sourceApplyNo = cleanText(r.source_apply_no);
    if (sourceApplyNo && knownNumbers.has(sourceApplyNo)) continue;
    const status = normalizeStatus(r.status, r.approval_status);
    projects.push({
      projectId: String(r.project_id ?? ''),
      projectNo: cleanText(r.project_no),
      projectName: String(r.project_name ?? ''),
      enterpriseCode: cleanText(r.enterprise_code),
      enterpriseName: cleanText(r.enterprise_name),
      businessType: String(r.business_type ?? ''),
      source: 'legacy-project',
      status,
      statusLabel: STATUS_LABEL[status],
      startDate: fmtDate(r.start_date),
      endDate: fmtDate(r.end_date),
      startsAt: null,
      endsAt: null,
      workerCount: numOrNull(r.worker_count),
      constructionReason: cleanText(r.construction_reason),
      affectedArea: cleanText(r.affected_area),
      emergencyPlan: cleanText(r.emergency_plan),
      pipelineLength: numOrNull(r.pipeline_length),
      progress: numOrNull(r.progress),
      gridCodes: verifiedGridCodes(parseGridCodes(r.admin_grid_codes), districts),
      approvalStatus: cleanText(r.approval_status),
      sourceApplyNo,
      sourceEventNo: cleanText(r.source_event_no),
      sourceRevision: cleanText(r.source_version),
    });
  }
  return projects.filter(project => canReadProject(project, districts, access));
}

export async function loadPipelineProject(db: Pool, projectId: string, access: AccessContext): Promise<PipelineProjectItem | null> {
  const projects = await readPipelineProjects(db, access);
  return projects.find(project => project.projectId === projectId) ?? null;
}

/** 同一施工申请在每个已核验影响网格下保留同一个项目标识。 */
export async function loadPipelineLayer(
  db: Pool,
  businessType: PipelineBusinessType | 'all',
  access: AccessContext,
): Promise<PipelineLayerResult> {
  const projects = (await readPipelineProjects(db, access))
    .filter(project => businessType === 'all' || project.businessType === businessType)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '') || b.projectId.localeCompare(a.projectId));
  const unlocatedProjects = projects.filter(project => project.gridCodes.length === 0);
  // 按网格聚合：一个项目可涉及多个网格，每个网格都要能点开看到这个项目
  const cellMap = new Map<string, PipelineGridCell>();
  for (const p of projects) {
    for (const code of p.gridCodes) {
      const cell = cellMap.get(code) ?? {
        gridCode: code,
        projectCount: 0,
        inProgressCount: 0,
        statusCounts: {},
        projects: [],
      };
      cell.projectCount += 1;
      if (p.status === 'in_progress') cell.inProgressCount += 1;
      cell.statusCounts[p.status] = (cell.statusCounts[p.status] ?? 0) + 1;
      cell.projects.push(p);
      cellMap.set(code, cell);
    }
  }

  const cells = [...cellMap.values()].sort((a, b) => b.projectCount - a.projectCount || a.gridCode.localeCompare(b.gridCode));

  // 如实说明数据情况，不粉饰
  const notes: string[] = [];
  if (!projects.length) {
    notes.push(
      businessType === 'all'
        ? '授权范围内暂无管道施工改造项目'
        : `授权范围内暂无${businessType === 'gas' ? '燃气' : '供水'}改造项目`
    );
  }
  if (projects.length && projects.every(project => project.source === 'legacy-project')) {
    notes.push('授权范围内暂无可展示的正式施工申请，当前项目来自旧项目表');
  }
  if (unlocatedProjects.length > 0) {
    notes.push(`${unlocatedProjects.length} 个项目的影响网格尚未核验，图层未为这些项目着色`);
  }

  return {
    businessType,
    cells,
    gridCount: cells.length,
    projectCount: projects.length,
    unlocatedProjects,
    statusNote: '正式施工申请以来源审批为准，施工状态以来源明确填报为准，旧项目保留原表状态',
    dataNote: notes.length ? notes.join('；') : null,
  };
}
