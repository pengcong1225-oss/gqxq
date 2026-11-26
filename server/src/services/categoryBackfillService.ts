import { createHash } from 'node:crypto';
import { buildComplaintScopeSql } from '../auth/accessScope';
import { withTransaction, type Tx } from '../db/tx';
import { parseFieldState } from '../domain/effectiveFieldPolicy';
import { excludeIntegrationTestsSql } from '../domain/integrationTestPolicy';
import { AppError } from '../http/errors';
import { rowsIn } from '../repositories/serviceGridRepo';
import type { MasterDataContext } from '../types/masterData';
import { CATEGORY_COLUMNS, CATEGORY_TYPE, reviseCategoryInTx } from './categoryService';
import { readDictionaryItems, readDictionaryType } from './dictService';

async function collectCategoryBackfill(tx: Tx, ctx: MasterDataContext, lock: boolean) {
  if (!ctx.userId || !ctx.permissionCodes.includes('complaint.correct')) throw AppError.forbidden();
  const type = await readDictionaryType(tx, CATEGORY_TYPE, lock);
  if (!type?.published || type.status !== 'enabled') throw AppError.conflict('正式分类字典未发布或已停用');
  const dictionaryVersion = String(type.version);
  const items = (await readDictionaryItems(tx, CATEGORY_TYPE, lock)).filter(i => i.published && i.status === 'enabled');
  const scope = buildComplaintScopeSql(ctx.access, 'c');
  // Only the two classification labels leave SQL. Keep the current complaint identity and
  // the last successful log for that exact source identity together.
  const rows = await rowsIn(tx, `
    select c.complaint_id,c.business_type,c.edit_version,c.effective_field_state,c.analysis_included,
      exists(select 1 from complaint_category_revision r where r.complaint_id=c.complaint_id) has_category_revision,
      exists(select 1 from analysis_record a where a.complaint_id=c.complaint_id) has_analysis_record,
      l.log_id source_log_id,
      json_unquote(json_extract(l.payload,'$.metadata."案件二级类型名"')) source_major_label,
      json_unquote(json_extract(l.payload,'$.metadata."案件类型名"')) source_minor_label
    from complaint c
    left join complaint_source_log l on l.id=(
      select latest.id from complaint_source_log latest
      where latest.source_system=c.source_system and latest.source_id=c.source_id
        and latest.complaint_id=c.complaint_id and latest.result in ('created','updated','duplicate_same')
      order by latest.received_at desc,latest.id desc limit 1
    )
    where c.source_system=? and c.business_type in ('water','gas') and
      c.major_category_code is null and c.minor_category_code is null and c.category_dictionary_version is null
      and ${scope.sql} and ${excludeIntegrationTestsSql('c')}
    order by c.complaint_id${lock ? ' for update of c' : ''}
  `, ['宜接就办', ...scope.params]);

  const skipped = { manualDecision: 0, analysisRecord: 0, noExactSourceCategory: 0 };
  const candidates = [];
  const byCategory = new Map<string, { majorCode: string; minorCode: string; minorName: string; count: number }>();
  for (const row of rows) {
    const state = parseFieldState(row.effective_field_state);
    if (Number(row.has_category_revision) === 1 || [...CATEGORY_COLUMNS, 'formal_category'].some(column =>
      state[column] && state[column].resolution !== 'unresolved')) {
      skipped.manualDecision++;
      continue;
    }
    if (Number(row.analysis_included) === 1 || Number(row.has_analysis_record) === 1) {
      skipped.analysisRecord++;
      continue;
    }
    const majorCode = row.business_type === 'water' ? 'water_service' : 'gas_service';
    const major = items.find(item => item.code === majorCode && item.parentCode === null && item.label === row.source_major_label);
    const minors = items.filter(item => item.parentCode === majorCode && item.label === row.source_minor_label);
    if (!row.source_log_id || !major || minors.length !== 1) {
      skipped.noExactSourceCategory++;
      continue;
    }
    const minorCode = minors[0].code;
    const sourceLogId = String(row.source_log_id);
    candidates.push({ complaintId: String(row.complaint_id), expectedVersion: Number(row.edit_version),
      category: { majorCode, minorCode, dictionaryVersion }, sourceLogId });
    const bucket = byCategory.get(minorCode) ?? { majorCode, minorCode, minorName: minors[0].label, count: 0 };
    bucket.count++;
    byCategory.set(minorCode, bucket);
  }
  const digest = createHash('sha256').update(JSON.stringify({
    userId: ctx.userId, authorization: ctx.access.scopeVersion, dictionaryVersion, candidates, skipped,
  })).digest('hex');
  const preview = { digest, dictionaryVersion, candidates: candidates.length,
    remaining: rows.length - candidates.length, skipped,
    byCategory: [...byCategory.values()].sort((a, b) => a.minorCode.localeCompare(b.minorCode)) };
  return { preview, candidates };
}

export async function previewCategoryBackfillIn(tx: Tx, ctx: MasterDataContext) {
  return (await collectCategoryBackfill(tx, ctx, false)).preview;
}

export async function applyCategoryBackfillIn(tx: Tx, ctx: MasterDataContext, digest: string) {
  const { preview, candidates } = await collectCategoryBackfill(tx, ctx, true);
  if (preview.digest !== digest) throw AppError.conflict('来源分类补齐预览已变化，请重新核对');
  for (const { sourceLogId, ...candidate } of candidates) {
    await reviseCategoryInTx(tx, { ...candidate, basis: '宜接就办来源分类逐字匹配 · 投递日志 ' + sourceLogId }, ctx);
  }
  return { revised: candidates.length, remaining: preview.remaining, dictionaryVersion: preview.dictionaryVersion };
}

export const previewCategoryBackfill = (ctx: MasterDataContext) => withTransaction(tx => previewCategoryBackfillIn(tx, ctx));
export const applyCategoryBackfill = (ctx: MasterDataContext, digest: string) => withTransaction(tx => applyCategoryBackfillIn(tx, ctx, digest));
