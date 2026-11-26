import type { Pool, RowDataPacket } from 'mysql2/promise';
import { buildComplaintScopeSql, type AccessContext } from '../auth/accessScope';
import { AppError } from '../http/errors';
import type { PipelineProjectItem } from './pipelineLayerService';

const PAGE_SIZE = 10;
const EXACT_TIME = /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type ProjectWindow = Pick<PipelineProjectItem, 'projectId' | 'businessType' | 'gridCodes' | 'startsAt' | 'endsAt'>;

export async function findPipelineComplaintClues(
  db: Pool, project: ProjectWindow, gridCode: string, page: number, access: AccessContext, now = Date.now(),
) {
  if (!project.gridCodes.includes(gridCode)) throw AppError.notFound('该网格无此改造项目，或项目已不可见');

  const identity = { projectId: project.projectId, gridCode, page, size: PAGE_SIZE };
  const unavailable = (reason: string) => ({ ...identity, state: 'unavailable' as const, reason, window: null, total: null, items: [] });
  if (project.businessType !== 'gas' && project.businessType !== 'water') return unavailable('项目缺少明确的供水或燃气类型，无法核对工单。');
  const from = project.startsAt && EXACT_TIME.test(project.startsAt) ? Date.parse(project.startsAt) : NaN;
  const end = project.endsAt && EXACT_TIME.test(project.endsAt) ? Date.parse(project.endsAt) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(end) || from > end) return unavailable('项目缺少有效的起止时间，无法核对工单。');
  if (from > now) return unavailable('项目时段尚未开始，暂无法核对工单。');

  const fromDate = new Date(from);
  const toDate = new Date(Math.min(end, now));
  const scope = buildComplaintScopeSql(access, 'c');
  // Match only against the clicked grid. The completed statement reads count and page from the same snapshot.
  const [rows] = await db.query<RowDataPacket[]>(`
    with matched as (
      select c.id as dbId, c.complaint_id as id, c.complaint_no as complaintNo, c.title,
             coalesce(nullif(c.minor_category_code, ''), c.major_category_code) as type,
             coalesce(c.source_reported_at, c.received_at) as occurredAt, c.admin_grid_code as gridId
        from complaint c
       where ${scope.sql} and c.source_system = '宜接就办' and c.source_id <> ''
         and c.business_type = ? and c.admin_grid_code = ?
         and ((c.source_reported_at between ? and ?)
              or (c.source_reported_at is null and c.received_at between ? and ?))
    ), visible_page as (
      select * from matched order by occurredAt desc, dbId desc limit ? offset ?
    )
    select summary.total, visible_page.*
      from (select count(*) as total from matched) summary
      left join visible_page on true
     order by visible_page.occurredAt desc, visible_page.dbId desc
  `, [...scope.params, project.businessType, gridCode, fromDate, toDate, fromDate, toDate, PAGE_SIZE, (page - 1) * PAGE_SIZE]);

  return {
    ...identity,
    state: 'available' as const,
    reason: '按点选网格、同行业和项目时段匹配授权范围内的宜接就办工单。优先使用来源上报时间，缺失时使用接收时间。匹配仅作线索，因果关系待核实。',
    window: { from: fromDate.toISOString(), to: toDate.toISOString() },
    total: Number(rows[0]?.total ?? 0),
    items: rows.filter((record) => record.id != null).map((record) => ({
      id: String(record.id),
      complaintNo: record.complaintNo ? String(record.complaintNo) : null,
      title: String(record.title ?? ''),
      type: String(record.type ?? ''),
      occurredAt: new Date(record.occurredAt).toISOString(),
      gridId: String(record.gridId),
    })),
  };
}
