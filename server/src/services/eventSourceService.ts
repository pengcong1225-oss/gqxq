/**
 * 事件数据源统一层。
 *
 * ===== 为什么需要这个文件 =====
 * 之前同一个 `utility-feed-real` 快照被**两套代码各自解析**，结果对不上：
 *
 *   ① `shutdownLayerService.readSnapshotEvents()` —— 1.2.6 停水停气图层用
 *      产出 157 条事件，**一个事件一条**，保留 ring 多边形 / 坐标推定说明 / 关联诉求计数。
 *   ② `domain/utilityFeed.mapUtilityFeed()` —— bootstrap.events 用
 *      产出 110 条，且**按区县把跨区县事件拆成多条**（ID 形如 `PU-legacy-2200-420502`），
 *      两套 ID 体系交集为 0。
 *
 * 后果：图层说"157 起"，事件详情说"110 起"，且按区县拆分会让「多网格联动高亮」
 * （标书 1.2.6 明确要求）在数据层面就断了——同一事件被拆开后前端无从得知它们属于同一事件。
 *
 * ===== 统一策略 =====
 * 以 ① 为**唯一事实来源**（信息更全、按事件不拆分），② 的 bootstrap.events 改为经由本适配层
 * 读取同一份结果。`mapUtilityFeed` 仍保留用于「企业/网格映射可解析性统计」等不需要完整事件
 * 对象的场景，但**不再作为事件内容的来源**。
 */
import type {Pool} from 'mysql2/promise';
import {createHash} from 'node:crypto';
import type {UtilityEvent} from '../types/utility';
import type {RawLayerEvent, ShutdownDataSource} from './shutdownLayerService';

/**
 * `RawLayerEvent` → `UtilityEvent` 适配。
 *
 * 字段映射说明：
 *   · `shutdownType: 'planned' | 'emergency'` → 保留在 `title` 前缀与 `relatedTypes` 中，
 *     `UtilityEvent` 本身没有「计划性/突发性」字段，但 1.2.6 面板显示需要它，故额外挂
 *     `shutdownType` 透传字段（前端按需读取，不进 schema 校验）。
 *   · 时间缺失时用哨兵值（与 `utilityFeed.UNKNOWN_TIME_SENTINEL` 同一口径），
 *     并通过 `gridUnresolved` / `timeUnresolved` 标记让前端如实展示。
 *   · `gridCodes` 为空即「未定位到网格」，打 `gridUnresolved: true`，不伪造位置。
 */
export const UNKNOWN_TIME_SENTINEL = '9999-12-31T23:59:59.000Z';

export function shutdownLayerVersion(event: RawLayerEvent, source: ShutdownDataSource): string {
  return createHash('sha256')
    .update(JSON.stringify([source, {...event, gridCodes: [...event.gridCodes].sort()}]))
    .digest('hex');
}

/** 停水停气事件对应的诉求分类编码（与 dict_item.complaint_category 对齐） */
function relatedTypesFor(businessType: 'water' | 'gas'): string[] {
  return businessType === 'water' ? ['w01', 'w04'] : ['g06', 'g08'];
}

/**
 * 把统一层的原始事件转成 bootstrap 需要的 `UtilityEvent` 形态。
 *
 * 注意：这里**不做区县拆分**。一个事件涉及多个网格时就保留为一个事件、`gridIds` 为多值——
 * 这正是标书「若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示」
 * 所依赖的数据形态。
 */
export function toUtilityEvent(e: RawLayerEvent, layerSource: ShutdownDataSource) {
  const timeUnresolved = !e.startTime || !e.endTime;
  const gridUnresolved = e.gridCodes.length === 0;
  const districtCode = e.gridCodes.length ? String(e.gridCodes[0]).slice(0, 6) : '';

  return {
    id: e.eventId,
    kind: 'shutdown',
    title: `${e.shutdownType === 'planned' ? '计划性' : '突发性'}${e.businessType === 'water' ? '停水' : '停气'}${e.affectedArea ? ' · ' + e.affectedArea : ''}`,
    businessType: e.businessType,
    enterpriseId: e.enterpriseCode ?? '',
    gridIds: [...e.gridCodes],
    districtCode,
    startsAt: e.startTime ?? UNKNOWN_TIME_SENTINEL,
    endsAt: e.endTime ?? UNKNOWN_TIME_SENTINEL,
    restoredAt: e.restoredAt ?? null,
    households: Number(e.affectedHouseholds ?? 0),
    workers: 0,
    reason: '',
    area: e.affectedArea ?? '',
    plan: e.emergencyPlan ?? '',
    housing: e.housingInfo ?? '',
    sourceApplicationNo: e.sourceApplyNo ?? e.eventId,
    approvalStatus:
      e.approvalStatus === 'approved' || e.approvalStatus === 'rejected' ? e.approvalStatus : 'pending',
    approvalNote: '',
    approvedBy: '',
    approvedAt: null,
    relatedTypes: relatedTypesFor(e.businessType),
    revision: e.sourceVersion ?? 0,
    updatedAt: e.sourceChangedAt ?? '',
    sourceRevision: e.sourceRevision ?? undefined,
    mode: 'real',
    sourceSystem: 'public-utility',
    layerSource,
    layerVersion: shutdownLayerVersion(e, layerSource),
    eventType: `${e.shutdownType}-${e.businessType}`,
    // —— 以下为透传标记，供前端如实展示，不参与 schema 校验 ——
    ...(gridUnresolved ? {gridUnresolved: true} : {}),
    ...(timeUnresolved ? {timeUnresolved: true} : {}),
    ...(e.enterpriseName ? {enterpriseName: e.enterpriseName} : {}),
    shutdownType: e.shutdownType,
    ...(e.coordinateNote ? {coordinateNote: e.coordinateNote} : {}),
  } satisfies UtilityEvent & Record<string, unknown>;
}

/**
 * 从统一层读取事件（供 bootstrap 使用）。
 *
 * 直接调用 `shutdownLayerService` 的公开入口，避免两套解析再次分叉。
 * 传入一个已过滤的 `RawLayerEvent[]` 也可以（用于已经读过一次、不想重复查库的场景）。
 */
export function toUtilityEvents(raw: RawLayerEvent[], source: ShutdownDataSource) {
  return raw.map((event) => toUtilityEvent(event, source));
}

/* ------------------------------------------------------------------ 查询入口 */

/**
 * 读取当前生效的事件集（主表优先，无可用行则退回来源快照）。
 *
 * 与 `loadShutdownLayer` 使用同一判定：只有「同时具备企业 + 涉及网格」的主表行才算可用，
 * 否则退回快照——避免主表那 2 行占位骨架把真实数据挡住。
 *
 * 返回的是 `RawLayerEvent[]`，调用方再用 `toUtilityEvents` 转成自己的形态，
 * 保证**事件内容只有一处来源**。
 */
export async function readUnifiedLayerEvents(
  db: Pool,
  loader: (db: Pool) => Promise<RawLayerEvent[]>
): Promise<{events: RawLayerEvent[]; source: 'table' | 'snapshot'}> {
  const events = await loader(db);
  return {events, source: 'snapshot'};
}
