import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { withTransaction, type Tx } from '../db/tx';
import { insertAudit } from '../repositories/auditLogRepo';
import { insertFieldVersions } from '../repositories/complaintFieldVersionRepo';
import type { Queryable } from '../repositories/complaintSourceLogRepo';
import { recordSensitiveHits } from '../repositories/sensitiveHitRepo';
import {
  countEnabledSensitiveWords,
  findSensitiveWordById,
  findSensitiveWordByValue,
  insertSensitiveWordRow,
  listSensitiveRescanComplaintRows,
  listSensitiveWordRows,
  lockSensitiveWordSet,
  updateComplaintSensitiveResult,
  updateSensitiveWordRow,
  type ManagedSensitiveWordRow,
  type SensitiveWordStatus,
} from '../repositories/sensitiveWordRepo';
import { CLASSIFY_RULE_VERSION } from './rules/classify';
import { GQXQ_APP_CODE } from './intakeService';

export interface SensitiveRescanComplaint {
  complaintId: string;
  title: string | null;
  content: string | null;
  address: string | null;
  isSensitive: boolean;
  sensitiveKeywords: string[];
  ruleConfidence: number | null;
  ruleVersion: string | null;
}

export interface SensitiveRescanChange {
  complaintId: string;
  nextIsSensitive: boolean;
  nextKeywords: string[];
}

export interface SensitiveRescanSummary {
  total: number;
  wouldBecomeSensitive: number;
  wouldBecomeNonSensitive: number;
  keywordsChanged: number;
  unchanged: number;
}

export interface SensitiveRescanPlan {
  summary: SensitiveRescanSummary;
  changes: SensitiveRescanChange[];
}

export interface SensitiveWordOperatorContext {
  userId: string | null;
  userName: string | null;
  clientIp: string | null;
}

export interface SensitiveRescanPreview {
  previewToken: string;
  expiresAt: string;
  fingerprint: string;
  enabledWords: string[];
  summary: SensitiveRescanSummary;
}

export interface SensitiveRescanExecution {
  fingerprint: string;
  updated: number;
  summary: SensitiveRescanSummary;
}

const SENSITIVE_DICT_TYPE = 'sensitive_word';
const ACTION_CREATE = 'SENSITIVE_WORD_CREATE'; // gate-g1-allow
const ACTION_UPDATE = 'SENSITIVE_WORD_UPDATE'; // gate-g1-allow
const ACTION_RESCAN = 'SENSITIVE_WORD_RESCAN'; // gate-g1-allow
const CONFIDENCE_HIT = 0.88;
const CONFIDENCE_MISS = 0.72;
const RESCAN_PREVIEW_TTL_MS = 5 * 60 * 1000;
const SENSITIVE_KEYWORDS_COLUMN_MAX = 500;

interface StoredRescanPreview {
  actorId: string;
  expiresAt: number;
  wordFingerprint: string;
  datasetFingerprint: string;
  summary: SensitiveRescanSummary;
}

const rescanPreviews = new Map<string, StoredRescanPreview>();

export function normalizeSensitiveWord(word: string): string {
  const normalized = word.trim();
  if (normalized === '') throw new Error('敏感词不能为空');
  if (normalized.length > 128) throw new Error('敏感词最长 128 个字符');
  if (/[,，、]/u.test(normalized)) {
    throw new Error('敏感词不能包含逗号、中文逗号或顿号');
  }
  return normalized;
}

export function sensitiveWordFingerprint(words: string[]): string {
  const normalized = Array.from(new Set(words.map(normalizeSensitiveWord))).sort();
  return createHash('sha256').update(normalized.join('\u0000'), 'utf8').digest('hex');
}

function sameKeywords(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

function assertEnabledWordBudget(words: string[]): void {
  let normalized: string[];
  try {
    normalized = words.map(normalizeSensitiveWord);
  } catch (err) {
    throw AppError.validation(err instanceof Error ? err.message : String(err));
  }
  const stored = normalized.join(',');
  if (stored.length > SENSITIVE_KEYWORDS_COLUMN_MAX) {
    throw AppError.conflict(
      `当前启用词条合计 ${stored.length} 个字符，超过敏感关键词存储上限 ${SENSITIVE_KEYWORDS_COLUMN_MAX}；请先缩短或停用其他词条`
    );
  }
}

function sensitiveDatasetFingerprint(rows: SensitiveRescanComplaint[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows.map((row) => ({
          complaintId: row.complaintId,
          title: row.title,
          content: row.content,
          address: row.address,
          isSensitive: row.isSensitive,
          sensitiveKeywords: row.sensitiveKeywords,
          ruleConfidence: row.ruleConfidence,
          ruleVersion: row.ruleVersion,
        }))
      ),
      'utf8'
    )
    .digest('hex');
}

function pruneExpiredPreviews(now: number): void {
  for (const [token, preview] of rescanPreviews) {
    if (preview.expiresAt <= now) rescanPreviews.delete(token);
  }
}

export function buildSensitiveRescanPlan(
  rows: SensitiveRescanComplaint[],
  words: string[]
): SensitiveRescanPlan {
  const enabledWords = Array.from(new Set(words.map(normalizeSensitiveWord)));
  const summary: SensitiveRescanSummary = {
    total: rows.length,
    wouldBecomeSensitive: 0,
    wouldBecomeNonSensitive: 0,
    keywordsChanged: 0,
    unchanged: 0,
  };
  const changes: SensitiveRescanChange[] = [];

  for (const row of rows) {
    const text = [row.title, row.content, row.address]
      .filter((value): value is string => value !== null && value !== '')
      .join('\n');
    const nextKeywords = enabledWords.filter((word) => text.includes(word));
    const nextIsSensitive = nextKeywords.length > 0;

    if (!row.isSensitive && nextIsSensitive) summary.wouldBecomeSensitive += 1;
    else if (row.isSensitive && !nextIsSensitive) summary.wouldBecomeNonSensitive += 1;
    else if (!sameKeywords(row.sensitiveKeywords, nextKeywords)) summary.keywordsChanged += 1;
    else {
      summary.unchanged += 1;
      continue;
    }

    changes.push({ complaintId: row.complaintId, nextIsSensitive, nextKeywords });
  }

  return { summary, changes };
}

export async function listManagedSensitiveWords(
  db: Queryable = pool
): Promise<ManagedSensitiveWordRow[]> {
  return listSensitiveWordRows(db);
}

function duplicateMessage(word: string): AppError {
  return AppError.conflict('敏感词已存在：' + word + '；如已停用，请直接重新启用');
}

async function writeWordAudit(
  db: Queryable,
  ctx: SensitiveWordOperatorContext,
  action: string,
  itemId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await insertAudit(db, {
    userId: ctx.userId ?? null,
    appCode: GQXQ_APP_CODE,
    resourceCode: SENSITIVE_DICT_TYPE,
    action,
    bizType: SENSITIVE_DICT_TYPE,
    bizId: itemId,
    result: 'success',
    clientIp: ctx.clientIp ?? null,
    detail: { ...detail, operator: ctx.userName ?? null },
    createdAt: new Date(),
  });
}

export async function createSensitiveWordInTransaction(
  db: Queryable,
  input: { word: string },
  ctx: SensitiveWordOperatorContext
): Promise<ManagedSensitiveWordRow> {
  let word: string;
  try {
    word = normalizeSensitiveWord(input.word);
  } catch (err) {
    throw AppError.validation(err instanceof Error ? err.message : String(err));
  }
  await lockSensitiveWordSet(db);
  if (await findSensitiveWordByValue(db, word, true)) throw duplicateMessage(word);
  const currentWords = await listSensitiveWordRows(db);
  assertEnabledWordBudget([
    ...currentWords.filter((item) => item.status === 'enabled').map((item) => item.word),
    word,
  ]);

  const itemId = 'DICT-SW-' + randomUUID();
  try {
    await insertSensitiveWordRow(db, { itemId, word });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw duplicateMessage(word);
    throw err;
  }
  await writeWordAudit(db, ctx, ACTION_CREATE, itemId, {
    after: { word, status: 'enabled' },
  });
  return { itemId, word, label: word, status: 'enabled', hitCount: 0 };
}

export async function createSensitiveWord(
  input: { word: string },
  ctx: SensitiveWordOperatorContext
): Promise<ManagedSensitiveWordRow> {
  return withTransaction((tx) => createSensitiveWordInTransaction(tx, input, ctx));
}

export interface UpdateSensitiveWordInput {
  word?: string;
  status?: SensitiveWordStatus;
}

export async function updateSensitiveWordInTransaction(
  db: Queryable,
  itemId: string,
  input: UpdateSensitiveWordInput,
  ctx: SensitiveWordOperatorContext
): Promise<ManagedSensitiveWordRow> {
  await lockSensitiveWordSet(db);
  const current = await findSensitiveWordById(db, itemId, true);
  if (current === null) throw AppError.notFound('敏感词不存在：' + itemId);

  let word = current.word;
  if (input.word !== undefined) {
    try {
      word = normalizeSensitiveWord(input.word);
    } catch (err) {
      throw AppError.validation(err instanceof Error ? err.message : String(err));
    }
  }
  const status = input.status ?? current.status;
  if (status !== 'enabled' && status !== 'disabled') {
    throw AppError.validation('敏感词状态只能是 enabled 或 disabled');
  }
  if (word !== current.word) {
    const duplicate = await findSensitiveWordByValue(db, word, true);
    if (duplicate !== null && duplicate.itemId !== itemId) throw duplicateMessage(word);
  }
  if (current.status === 'enabled' && status === 'disabled') {
    const enabledCount = await countEnabledSensitiveWords(db);
    if (enabledCount <= 1) {
      throw AppError.conflict('不能停用最后一个有效敏感词；请先新增或启用替代词条');
    }
  }
  const proposedEnabledWords = (await listSensitiveWordRows(db))
    .filter((item) => item.itemId === itemId ? status === 'enabled' : item.status === 'enabled')
    .map((item) => item.itemId === itemId ? word : item.word);
  assertEnabledWordBudget(proposedEnabledWords);

  if (word === current.word && status === current.status) return current;
  try {
    await updateSensitiveWordRow(db, itemId, { word, status });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw duplicateMessage(word);
    throw err;
  }
  await writeWordAudit(db, ctx, ACTION_UPDATE, itemId, {
    before: { word: current.word, status: current.status },
    after: { word, status },
  });
  return { ...current, word, label: word, status };
}

export async function updateSensitiveWord(
  itemId: string,
  input: UpdateSensitiveWordInput,
  ctx: SensitiveWordOperatorContext
): Promise<ManagedSensitiveWordRow> {
  return withTransaction((tx) => updateSensitiveWordInTransaction(tx, itemId, input, ctx));
}

async function enabledWords(db: Queryable): Promise<string[]> {
  return (await listSensitiveWordRows(db))
    .filter((item) => item.status === 'enabled')
    .map((item) => item.word);
}

export async function previewSensitiveRescan(
  db: Queryable = pool,
  ctx: SensitiveWordOperatorContext = { userId: null, userName: null, clientIp: null },
  now = Date.now()
): Promise<SensitiveRescanPreview> {
  if (ctx.userId === null) throw AppError.unauthenticated();
  const words = await enabledWords(db);
  if (words.length === 0) throw AppError.conflict('当前没有有效敏感词，不能执行历史重扫');
  assertEnabledWordBudget(words);
  const rows = await listSensitiveRescanComplaintRows(db);
  const plan = buildSensitiveRescanPlan(rows, words);
  pruneExpiredPreviews(now);
  const previewToken = randomUUID();
  const expiresAt = now + RESCAN_PREVIEW_TTL_MS;
  const fingerprint = sensitiveWordFingerprint(words);
  rescanPreviews.set(previewToken, {
    actorId: ctx.userId,
    expiresAt,
    wordFingerprint: fingerprint,
    datasetFingerprint: sensitiveDatasetFingerprint(rows),
    summary: plan.summary,
  });
  return {
    previewToken,
    expiresAt: new Date(expiresAt).toISOString(),
    fingerprint,
    enabledWords: words,
    summary: plan.summary,
  };
}

function keywordsToColumn(words: string[]): string | null {
  const value = words.join(',');
  if (value.length > SENSITIVE_KEYWORDS_COLUMN_MAX) {
    throw AppError.conflict('敏感关键词超过存储上限，请调整词表后重新预览');
  }
  return value === '' ? null : value;
}

export async function executeSensitiveRescanInTransaction(
  db: Queryable,
  previewToken: string,
  ctx: SensitiveWordOperatorContext,
  now = Date.now()
): Promise<SensitiveRescanExecution> {
  if (ctx.userId === null) throw AppError.unauthenticated();
  pruneExpiredPreviews(now);
  const preview = rescanPreviews.get(previewToken);
  if (preview === undefined) {
    throw AppError.conflict('预览令牌不存在、已过期或已使用，请重新预览');
  }
  if (preview.actorId !== ctx.userId) {
    throw AppError.forbidden('该预览令牌不属于当前操作人');
  }
  // 令牌在服务端一次性消费；任何后续失败都必须重新预览。
  rescanPreviews.delete(previewToken);
  await lockSensitiveWordSet(db);
  const words = await enabledWords(db);
  if (words.length === 0) throw AppError.conflict('当前没有有效敏感词，不能执行历史重扫');
  assertEnabledWordBudget(words);
  const fingerprint = sensitiveWordFingerprint(words);
  const rows = await listSensitiveRescanComplaintRows(db, true);
  const datasetFingerprint = sensitiveDatasetFingerprint(rows);
  if (
    fingerprint !== preview.wordFingerprint ||
    datasetFingerprint !== preview.datasetFingerprint
  ) {
    throw AppError.conflict('预览已失效：敏感词表或诉求数据已变化，请重新预览');
  }
  const byId = new Map(rows.map((row) => [row.complaintId, row]));
  const plan = buildSensitiveRescanPlan(rows, words);
  if (JSON.stringify(plan.summary) !== JSON.stringify(preview.summary)) {
    throw AppError.conflict('预览已失效：影响范围已变化，请重新预览');
  }
  const changedAt = new Date();
  const ruleVersion = CLASSIFY_RULE_VERSION + '+' + SENSITIVE_DICT_TYPE + '/' + words.length;

  for (const change of plan.changes) {
    const before = byId.get(change.complaintId);
    if (before === undefined) continue;
    const keywordColumn = keywordsToColumn(change.nextKeywords);
    const nextConfidence = change.nextIsSensitive ? CONFIDENCE_HIT : CONFIDENCE_MISS;
    await updateComplaintSensitiveResult(db, {
      complaintId: change.complaintId,
      isSensitive: change.nextIsSensitive,
      keywords: keywordColumn,
      confidence: nextConfidence,
      ruleVersion,
      updatedAt: changedAt,
    });

    const versions = [];
    if (before.isSensitive !== change.nextIsSensitive) {
      versions.push({
        complaintId: change.complaintId,
        fieldName: 'is_sensitive',
        oldValue: before.isSensitive ? '1' : '0',
        newValue: change.nextIsSensitive ? '1' : '0',
        changeSource: 'rule_engine' as const,
        reason: '管理员确认敏感词历史重扫',
        operatorId: ctx.userId ?? null,
        operatorName: ctx.userName ?? null,
        changedAt,
      });
    }
    if (!sameKeywords(before.sensitiveKeywords, change.nextKeywords)) {
      versions.push({
        complaintId: change.complaintId,
        fieldName: 'sensitive_keywords',
        oldValue: before.sensitiveKeywords.join(','),
        newValue: change.nextKeywords.join(','),
        changeSource: 'rule_engine' as const,
        reason: '管理员确认敏感词历史重扫',
        operatorId: ctx.userId ?? null,
        operatorName: ctx.userName ?? null,
        changedAt,
      });
    }
    if (before.ruleConfidence !== nextConfidence) {
      versions.push({
        complaintId: change.complaintId,
        fieldName: 'rule_confidence',
        oldValue: before.ruleConfidence === null ? null : String(before.ruleConfidence),
        newValue: String(nextConfidence),
        changeSource: 'rule_engine' as const,
        reason: '管理员确认敏感词历史重扫',
        operatorId: ctx.userId,
        operatorName: ctx.userName ?? null,
        changedAt,
      });
    }
    if (before.ruleVersion !== ruleVersion) {
      versions.push({
        complaintId: change.complaintId,
        fieldName: 'rule_version',
        oldValue: before.ruleVersion,
        newValue: ruleVersion,
        changeSource: 'rule_engine' as const,
        reason: '管理员确认敏感词历史重扫',
        operatorId: ctx.userId,
        operatorName: ctx.userName ?? null,
        changedAt,
      });
    }
    await insertFieldVersions(db, versions);

    if (change.nextKeywords.length > 0) {
      await recordSensitiveHits(db, {
        complaintId: change.complaintId,
        ruleVersion,
        matchedAt: changedAt,
        fields: [
          { field: 'title', text: before.title },
          { field: 'content', text: before.content },
          { field: 'address', text: before.address },
        ],
      });
    }
  }

  await insertAudit(db, {
    userId: ctx.userId ?? null,
    appCode: GQXQ_APP_CODE,
    resourceCode: SENSITIVE_DICT_TYPE,
    action: ACTION_RESCAN,
    bizType: SENSITIVE_DICT_TYPE,
    bizId: fingerprint,
    result: 'success',
    clientIp: ctx.clientIp ?? null,
    detail: {
      ...plan.summary,
      updated: plan.changes.length,
      operator: ctx.userName ?? null,
      wordFingerprint: fingerprint,
      datasetFingerprint,
      previewTokenId: previewToken,
    },
    createdAt: changedAt,
  });

  return { fingerprint, summary: plan.summary, updated: plan.changes.length };
}

export async function executeSensitiveRescan(
  previewToken: string,
  ctx: SensitiveWordOperatorContext
): Promise<SensitiveRescanExecution> {
  return withTransaction((tx: Tx) =>
    executeSensitiveRescanInTransaction(tx, previewToken, ctx)
  );
}
