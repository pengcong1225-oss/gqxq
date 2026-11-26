/**
 * 管线图层（标书 1.2.7 管线图层对接）
 *
 * ===== 标书原文 =====
 * 「建设管线图层，将图层分为燃气管线图层和供水管线图层，根据管道施工改造上报的信息，获取涉及的网格，
 *   若涉及改造事件的网格将形成色块高亮显示，点击可查看改造事件的信息，包括改造项目名称、企业名称、
 *   时间范围、现场施工人数、相关诉求等信息……」
 *
 * ===== 关键口径：落图单位是「网格色块」，不是管线线条 =====
 * 投标技术方案第 755 行已定稿的实现约束：
 *   「缺少精确管线几何时展示真实上报的影响网格和范围，**不画虚构管线**」
 *   「一个项目可涉及多个网格，空间关系以项目号关联，网格重叠不能合并不同项目」
 *
 * 因此本模块**不做任何几何插值/连线**，只把后端 `GET /assessment/pipeline-layer` 返回的
 * 「改造项目 → 影响网格」聚合成「网格 → 项目」的着色数据，由渲染层用街道面/区县面填色。
 * 没有 admin_grid_codes 的项目就落不了图，如实进「未定位」清单，**不臆造位置**。
 *
 * ===== 数据来源（架构约束，与 gridLayer.ts 同一套）=====
 * 前端不直连任何地图/业务系统，只调 gqxq 后端；token 取 sessionStorage 的 `gqxq-token`。
 */

/** 业务类型：供水 / 燃气（标书要求两个独立图层） */
import { formatShutdownTime } from './shutdownLayer';

export type PipelineBusinessType = 'water' | 'gas';

/** 项目施工状态（后端已归一） */
export type PipelineStatus = 'in_progress' | 'not_started' | 'completed' | 'rejected' | 'cancelled' | 'unknown';

/** 单个改造项目（后端 PipelineProjectItem 的前端契约） */
export interface PipelineProject {
  projectId: string;
  projectNo: string | null;
  projectName: string;
  enterpriseName: string | null;
  businessType: string;
  status: PipelineStatus;
  statusLabel: string;
  startDate: string | null;
  endDate: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  source?: 'utility-application' | 'legacy-project';
  sourceRevision?: string | null;
  workerCount: number | null;
  constructionReason: string | null;
  affectedArea: string | null;
  emergencyPlan: string | null;
  pipelineLength: number | null;
  progress: number | null;
  gridCodes: string[];
  approvalStatus: string | null;
  sourceApplyNo: string | null;
  sourceEventNo: string | null;
}

/** 按网格聚合的图层单元（一个网格 = 一个色块） */
export interface PipelineCell {
  gridCode: string;
  projectCount: number;
  inProgressCount: number;
  statusCounts: Record<string, number>;
  projects: PipelineProject[];
}

/** 后端返回的完整载荷 */
interface PipelineLayerPayload {
  businessType: string;
  cells: PipelineCell[];
  gridCount: number;
  projectCount: number;
  statusNote: string;
  dataNote: string | null;
  /**
   * 缺「涉及网格」的项目清单（可选：后端新版本会返回；旧版本没有此字段时前端兜底为空）。
   * 没有它就没法在空态里说清「哪 2 个项目落不了图」，只能给一个总数。
   */
  unlocatedProjects?: PipelineProject[];
}

/** 前端消费结果（两种业务类型各一份，渲染层按开关决定画哪些） */
export interface PipelineLayerResult {
  /** 按网格聚合（可直接画色块） */
  cells: PipelineCell[];
  /** 有网格、可落图的项目数 */
  locatedProjectCount: number;
  /** 全部项目数 */
  projectCount: number;
  /** 涉及网格数 */
  gridCount: number;
  /** 缺「涉及网格」的项目（落不了图，如实单列，不臆造位置） */
  unlocatedProjects: PipelineProject[];
  /** 缺网格的项目数（后端 authoritative；unlocatedProjects 为空时仍能显示数量） */
  unlocatedCount: number;
  /** 状态口径说明 */
  statusNote: string;
  /** 数据缺失提示 */
  dataNote: string | null;
  /** 失败/降级原因（成功为 null） */
  note: string | null;
}

import { API_BASE } from '../../../stats/apiBase';

/** 取当前会话 token（大屏真实数据会话存在 sessionStorage 的 gqxq-token） */
function currentToken(): string | null {
  try {
    return sessionStorage.getItem('gqxq-token');
  } catch {
    return null;
  }
}

function emptyResult(note: string | null): PipelineLayerResult {
  return {
    cells: [],
    locatedProjectCount: 0,
    projectCount: 0,
    gridCount: 0,
    unlocatedProjects: [],
    unlocatedCount: 0,
    statusNote: '',
    dataNote: null,
    note,
  };
}

/**
 * 拉取指定业务类型的管线图层数据。
 *
 * 失败时返回空 cells + note，渲染层据此显示空态，**不伪造网格/项目**。
 */
export async function fetchPipelineLayer(
  businessType: PipelineBusinessType,
  signal?: AbortSignal
): Promise<PipelineLayerResult> {
  const token = currentToken();
  if (!token) {
    return emptyResult('未登录，无法获取改造项目数据');
  }
  try {
    const res = await fetch(`${API_BASE}/assessment/pipeline-layer?businessType=${businessType}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      return emptyResult(`管线图层接口 HTTP ${res.status}`);
    }
    const body = (await res.json()) as { code?: number; data?: PipelineLayerPayload; message?: string };
    if (body.code !== 200 || !body.data) {
      return emptyResult(body.message ?? '管线图层接口返回异常');
    }
    const data = body.data;
    const cells = Array.isArray(data.cells) ? data.cells : [];

    // 「有网格的项目」= 出现在任一 cell.projects 里且 gridCodes 非空的项目（按 projectId 去重）
    // 用普通对象去重，不用 Map/Set 迭代（Vue 响应式下迭代器不稳）
    const located: Record<string, true> = {};
    const all: Record<string, PipelineProject> = {};
    for (let i = 0; i < cells.length; i += 1) {
      const ps = Array.isArray(cells[i]?.projects) ? cells[i].projects : [];
      for (let j = 0; j < ps.length; j += 1) {
        const p = ps[j];
        if (!p?.projectId) continue;
        all[p.projectId] = p;
        if (Array.isArray(p.gridCodes) && p.gridCodes.length) located[p.projectId] = true;
      }
    }
    const locatedIds = Object.keys(located);
    const allIds = Object.keys(all);
    // 项目缺网格时后端**不会**把它们放进 cells（没有可聚合的网格），
    // 所以「未定位」数量以 dataNote 兜底：cells 为空但 projectCount>0 时，
    // 差额就是缺网格的项目数；若后端直接给了 unlocatedProjects 清单则以它为准。
    const fromPayload = Array.isArray((data as PipelineLayerPayload).unlocatedProjects)
      ? (data as PipelineLayerPayload).unlocatedProjects!
      : [];
    const unlocatedProjects = fromPayload.length
      ? fromPayload
      : allIds
          .filter((id) => !located[id])
          .map((id) => all[id])
          .filter(Boolean);
    const totalProjects = Number(data.projectCount ?? allIds.length);
    const unlocatedCount = Math.max(
      unlocatedProjects.length,
      Math.max(0, totalProjects - locatedIds.length)
    );

    return {
      cells,
      locatedProjectCount: locatedIds.length,
      projectCount: totalProjects,
      gridCount: Number(data.gridCount ?? cells.length),
      unlocatedProjects,
      unlocatedCount,
      statusNote: data.statusNote ?? '',
      dataNote: data.dataNote,
      note: null,
    };
  } catch (e) {
    return emptyResult(`管线图层请求失败：${(e as Error)?.message ?? e}`);
  }
}

/** 燃气 / 供水同时拉取（两个图层开关各用一份，互不影响） */
export async function fetchPipelineLayers(signal?: AbortSignal): Promise<{
  water: PipelineLayerResult;
  gas: PipelineLayerResult;
}> {
  const [water, gas] = await Promise.all([
    fetchPipelineLayer('water', signal),
    fetchPipelineLayer('gas', signal),
  ]);
  return { water, gas };
}

/* ------------------------------------------------------------------ 展示口径 */

/** 燃气图层配色（橙红，标书 1.2.7 燃气管线图层） */
export const PIPELINE_COLORS: Record<PipelineBusinessType, { fill: string; stroke: string; label: string }> = {
  gas: { fill: 'rgba(230, 126, 34, 0.55)', stroke: 'rgba(230, 126, 34, 0.95)', label: '燃气' },
  water: { fill: 'rgba(52, 152, 219, 0.55)', stroke: 'rgba(52, 152, 219, 0.95)', label: '供水' },
};

/** 时间范围文案（标书要求字段，缺失时如实说「未提供」而非留空或补 0） */
export function projectPeriodText(p: PipelineProject): string {
  const s = p.startsAt ? formatShutdownTime(p.startsAt) : p.startDate;
  const e = p.endsAt ? formatShutdownTime(p.endsAt) : p.endDate;
  if (!s && !e) return '未提供';
  return `${s ?? '未提供'} ~ ${e ?? '未提供'}`;
}

/** 现场施工人数文案（缺失如实说「未提供」，不补 0） */
export function projectWorkerText(p: PipelineProject): string {
  return typeof p.workerCount === 'number' && Number.isFinite(p.workerCount) ? `${p.workerCount} 人` : '未提供';
}

/**
 * 网格在图上能否着色。
 * 目前 `admin_grid.geometry` 全为 null（甲方网格边界未接入），街道面由点位凸包兜底，
 * 因此「色块」既可能落在真实边界面，也可能落在近似凸包面 —— 渲染层会如实标注来源。
 */
export function cellStatusSummary(cell: PipelineCell): string {
  const parts: string[] = [`${cell.projectCount} 个项目`];
  if (cell.inProgressCount > 0) parts.push(`施工中 ${cell.inProgressCount}`);
  const sc = cell.statusCounts ?? {};
  const pending =
    (sc.not_started ?? 0) + (sc.completed ?? 0) + (sc.rejected ?? 0) + (sc.cancelled ?? 0) + (sc.unknown ?? 0);
  if (pending > 0) parts.push(`其它 ${pending}`);
  return parts.join(' · ');
}
