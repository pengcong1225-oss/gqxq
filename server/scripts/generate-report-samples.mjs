#!/usr/bin/env node
/**
 * 1.1.14 诉求数据分析 —— 固定模板报告验收样本生成（docx + xlsx）
 *
 * 背景：审查报告（02-后台B-基础与事件对接.md §1.1.14）实测 report_job=0、report_artifact=0，
 * 当前固定模板链从未产出过产物。本脚本以本地 admin 账号构造 MasterDataContext，直接调用
 * server/src/services/reportService.ts 的 createReport / generateReport，生成两份真实报告
 * （docx、xlsx），并从 report_artifact 取回字节保存到 deliverables 验收样本目录。
 *
 * 纪律：
 *   - 不重置/不修改 admin 密码：只按 user_id 读取现网授权（resolveAuthorizationFrom + readUserScope），
 *     等价于 reportService 内部 actorIn 的构造方式；
 *   - 不伪造报告内容：全部走正式 createReport → generateReport 链路，报告正文/图表由 reportRenderer 生成；
 *   - 只写报告子系统数据（report_record/report_job/statistics_snapshot/report_scope_proof/
 *     report_artifact 及审计），不修改 complaint / enterprise / 字典等业务数据；
 *   - 周期受限说明：REPORT_LIMITS.snapshot=16MiB，且固定模板会额外抓取「上年同期 / 上月」
 *     扩展区间；当选期落在 2026 年时扩展区间必然包含 2025 全年（1.1 万条），快照超限。
 *     实测可行且数据量最大的组合是 2025-04-01..2025-06-30（1,939 条，快照约 13.5MiB）。
 *
 * 用法（在 gqxq/server 下；脚本导入 .ts 模块，必须用 tsx 运行）：
 *   npx tsx scripts/generate-report-samples.mjs --dry-run
 *   npx tsx scripts/generate-report-samples.mjs
 *   [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--template=procurement-statistics|statistics-draft]
 *   [--file-date=YYYYMMDD] [--deliverables=<目录>] [--out-dir=<目录>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const { pool, closePool } = await import('../src/db/pool');
const { resolveAuthorizationFrom } = await import('../src/repositories/roleRepo');
const { readUserScope } = await import('../src/repositories/userScopeRepo');
const { createReport, generateReport, retryReport } = await import('../src/services/reportService');
const { reportBinary, readReport } = await import('../src/repositories/reportRepo');
const { normalizeStatisticsQuery } = await import('../src/domain/statisticsQuery');

function argValue(name) {
  const prefix = '--' + name + '=';
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error('缺少环境变量 ' + name + '（请在 server/.env 中配置）');
  return String(v).trim();
}
const DRY = process.argv.includes('--dry-run');
const PERIOD_FROM = argValue('from') || '2025-04-01';
const PERIOD_TO = argValue('to') || '2025-06-30';
const TEMPLATE = argValue('template') || 'procurement-statistics';
if (!['procurement-statistics', 'statistics-draft'].includes(TEMPLATE)) throw new Error('template 只支持 procurement-statistics / statistics-draft');
const POLICY = TEMPLATE === 'procurement-statistics' ? 'procurement-source-completed-v2' : 'candidate-calendar-v1';
const DATASET = 'ledger';
const PERIOD_KIND = 'custom';
const INCLUDE_HEAT = false;
const ADMIN_USERNAME = 'admin';
const FILE_DATE = argValue('file-date') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
const DELIVERABLES_DIR = resolve(
  argValue('deliverables') || process.env.GQXQ_DELIVERABLES_DIR || 'D:/deepSeekHerness/zhuxinServer/deliverables/标书符合性审查-20261118',
);
const OUT_DIR = resolve(argValue('out-dir') || resolve(DELIVERABLES_DIR, '验收样本'));
const REQUEST_BASE = 'accept-1.1.14-' + FILE_DATE + '-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const resumeRow = (row) => ({
  reportId: String(row.report_id),
  snapshotId: String(row.snapshot_id),
  format: row.format,
  state: row.state,
  failureReason: row.failure_reason,
  contentHash: row.content_hash == null ? null : String(row.content_hash),
  byteLength: row.byte_length == null ? null : Number(row.byte_length),
});

async function jobState(reportId) {
  const [rows] = await pool.query('select report_id, snapshot_id, format, state, failure_reason, created_at from report_job where report_id = ?', [reportId]);
  return rows[0] ?? null;
}
async function auditMissingPermission(required, codes) {
  return required.filter((c) => !codes.includes(c));
}

async function verifyArtifact(bytes, format) {
  const problems = [];
  const zip = await JSZip.loadAsync(bytes);
  if (format === 'docx') {
    const doc = zip.file('word/document.xml');
    if (!doc) problems.push('缺少 word/document.xml');
    else {
      const xml = await doc.async('string');
      for (const must of ['供水服务年季月分类型同比环比', '供气服务年季月分类型同比环比', '年季月诉求量', '企业万户诉求量']) {
        if (!xml.includes(must)) problems.push('docx 缺少段落：' + must);
      }
      if (xml.includes('工程草稿')) problems.push('docx 仍含「工程草稿」字样');
    }
  } else {
    if (!zip.file('xl/workbook.xml')) problems.push('缺少 xl/workbook.xml');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const cells = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => cells.push(String(c.value)))));
    for (const must of ['供水服务年季月分类型同比环比', '供气服务年季月分类型同比环比']) {
      if (!cells.includes(must)) problems.push('xlsx 缺少标题：' + must);
    }
  }
  return { ok: problems.length === 0, problems };
}

const [adminRows] = await pool.query('select user_id, username, status, must_change_password from app_user where username = ?', [ADMIN_USERNAME]);
if (!adminRows.length) throw new Error('app_user 中未找到 username=' + ADMIN_USERNAME);
const admin = adminRows[0];
if (Number(admin.status) !== 1 || Number(admin.must_change_password)) throw new Error('admin 账号状态不可用（status/must_change_password）');
const userId = String(admin.user_id);
const authorization = await resolveAuthorizationFrom(pool, userId);
const scope = await readUserScope(pool, userId);
if (!authorization.roleCodes.length) throw new Error('admin 无有效角色授权');
const ctx = {
  userId,
  userName: String(admin.username),
  clientIp: null,
  permissionCodes: authorization.permissionCodes,
  access: {
    userId,
    roles: authorization.roleCodes,
    scopeVersion: scope.scopeVersion,
    rules: scope.rules,
    canReadSource: authorization.permissionCodes.includes('source_document.read'),
  },
};
const queryRaw = {
  dataset: DATASET,
  projection: 'current',
  periodKind: PERIOD_KIND,
  from: PERIOD_FROM,
  to: PERIOD_TO,
  comparisonPolicyId: POLICY,
};
const query = normalizeStatisticsQuery(queryRaw, ctx.access);
const required = ['report.generate', 'report.read', 'report.download', 'statistics.read', 'complaint.read', DATASET === 'ledger' ? 'dashboard.read' : 'analysis.read', 'enterprise.read', 'grid.read', 'heatmap.read'];
const missing = await auditMissingPermission(required, authorization.permissionCodes);
const baseSummary = {
  mode: DRY ? 'dry-run' : 'apply',
  database: process.env.GQXQ_DB_NAME,
  admin: { userId, username: String(admin.username), roles: authorization.roleCodes, permissionCount: authorization.permissionCodes.length, scope: scope.rules },
  requiredPermissions: required,
  missingPermissions: missing,
  template: TEMPLATE,
  policy: POLICY,
  query,
  outputDir: OUT_DIR,
  fileDate: FILE_DATE,
};
if (missing.length) {
  console.error(JSON.stringify({ ...baseSummary, ok: false, error: '缺少报告所需权限：' + missing.join(',') }, null, 2));
  await closePool();
  process.exitCode = 3;
} else {

  // 只读预检：实际抓取数据量 + 快照字节数（与 createReport 内部同一套服务）
  const { captureStatisticsIn } = await import('../src/services/statisticsService');
  const { freezeReportSnapshot, canonical } = await import('../src/domain/reportSnapshot');
  const { tenderCaptureRange } = await import('../src/domain/tenderStatistics');
  const probeInput = { requestId: REQUEST_BASE + 'probe', templateCode: TEMPLATE, templateVersion: 'v1', format: 'docx', includeHeat: INCLUDE_HEAT, todoIds: [], query };
  const conn = await pool.getConnection();
  let selected;
  let extended;
  try {
    await conn.query('set transaction isolation level repeatable read');
    await conn.query('start transaction with consistent snapshot, read only');
    selected = await captureStatisticsIn(conn, query, ctx.access, ctx.permissionCodes);
    const range = tenderCaptureRange(query);
    extended = range.from === query.from && range.to === query.to ? selected : await captureStatisticsIn(conn, { ...query, ...range, periodKind: 'custom' }, ctx.access, ctx.permissionCodes);
  } finally {
    try { await conn.rollback(); } finally { conn.release(); }
  }
  let snapshotBytes = null;
  let probeError = null;
  try {
    const frozen = freezeReportSnapshot(probeInput, selected, scope.rules, null, [], extended, { selectedDemoCount: 0, calendarDemoCount: 0 });
    snapshotBytes = Buffer.byteLength(canonical(frozen));
  } catch (e) {
    probeError = String(e?.message ?? e);
  }
  baseSummary.precheck = {
    selectedRows: selected.rows.length,
    extendedRows: extended.rows.length,
    selectedTotal: selected.summary.total,
    snapshotBytes,
    snapshotMiB: snapshotBytes == null ? null : Number((snapshotBytes / 1048576).toFixed(2)),
    snapshotLimitMiB: 16,
    probeError,
  };
  if (probeError) {
    console.error(JSON.stringify({ ...baseSummary, ok: false, error: '选期快照不可行：' + probeError + '；请缩小选期' }, null, 2));
    process.exitCode = 4;
  } else if (DRY) {
    baseSummary.note = '[dry-run] 已只读预检，未创建报告、未写库；确认后去掉 --dry-run 执行。';
    console.log(JSON.stringify(baseSummary, null, 2));
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    const [countsBefore] = await pool.query('select (select count(*) from report_job) jobs, (select count(*) from report_artifact) artifacts, (select count(*) from report_record) records');
    baseSummary.rowsBefore = countsBefore[0];
    const outputs = [];
    for (const format of ['docx', 'xlsx']) {
      const requestId = REQUEST_BASE + format + '-v1';
      let report = null;
      let createAttempts = 0;
      while (createAttempts < 3) {
        createAttempts++;
        try {
          report = await createReport({ requestId, templateCode: TEMPLATE, templateVersion: 'v1', format, query, includeHeat: INCLUDE_HEAT, todoIds: [] }, ctx);
          break;
        } catch (e) {
          const code = e?.errorCode;
          if (code === 'REPORT_BUSY' && createAttempts < 3) { await sleep(3000); continue; }
          throw e;
        }
      }
      const reportId = String(report.reportId);
      let state = (await jobState(reportId))?.state ?? null;
      for (let attempt = 0; attempt < 8 && state !== 'succeeded'; attempt++) {
        if (state === 'failed') {
          await retryReport(reportId, ctx);
        }
        const claimed = await generateReport(reportId, 120000);
        await sleep(claimed ? 500 : 2000);
        state = (await jobState(reportId))?.state ?? null;
      }
      if (state !== 'succeeded') {
        const row = await jobState(reportId);
        throw new Error('报告未生成成功：reportId=' + reportId + ' state=' + state + ' failure=' + (row?.failure_reason ?? ''));
      }
      const binary = await reportBinary(pool, reportId);
      const digest = sha256(binary.bytes);
      if (digest !== binary.hash) throw new Error('产物哈希校验失败：' + reportId);
      const [artifactRows] = await pool.query('select byte_length, content_hash from report_artifact where report_id = ?', [reportId]);
      const artifact = artifactRows[0];
      if (!artifact || binary.bytes.length !== Number(artifact.byte_length) || digest !== String(artifact.content_hash)) {
        throw new Error('产物与 report_artifact 记录不一致：' + reportId);
      }
      const verification = await verifyArtifact(binary.bytes, format);
      if (!verification.ok) throw new Error('产物内容校验失败：' + verification.problems.join('；'));
      const view = await readReport(pool, reportId);
      const outPath = resolve(OUT_DIR, '固定模板报告-' + FILE_DATE + '.' + format);
      writeFileSync(outPath, binary.bytes);
      outputs.push({
        format,
        reportId,
        snapshotId: String(view.snapshot_id),
        state,
        requestId,
        contentHash: binary.hash,
        byteLength: binary.bytes.length,
        dataCutoffAt: String(view.created_at instanceof Date ? view.created_at.toISOString() : view.created_at),
        output: outPath,
        verification,
      });
      console.log('[生成完成] ' + format + ' ' + reportId + ' -> ' + outPath + ' (' + binary.bytes.length + ' bytes, sha256=' + binary.hash + ')');
    }
    const [countsAfter] = await pool.query('select (select count(*) from report_job) jobs, (select count(*) from report_artifact) artifacts, (select count(*) from report_record) records');
    const metaPath = resolve(OUT_DIR, '固定模板报告-' + FILE_DATE + '-元数据.json');
    const metadata = {
      generatedAt: new Date().toISOString(),
      purpose: '1.1.14 固定模板报告验收样本（docx/xlsx）',
      template: TEMPLATE,
      policy: POLICY,
      query,
      admin: { userId, username: String(admin.username), roles: authorization.roleCodes },
      snapshot: { bytes: snapshotBytes, miB: baseSummary.precheck.snapshotMiB, selectedRows: selected.rows.length, contributedRowsByPeriod: selected.periodFacts.map((p) => ({ kind: p.kind, from: p.from, to: p.to, rows: p.rows.length })) },
      rowsBefore: countsBefore[0],
      rowsAfter: countsAfter[0],
      outputs,
      notes: [
        '报告由 createReport → generateReport 正式链路生成，未伪造正文；',
        '产物通过 report_artifact 哈希/长度校验，并解析 ZIP 结构校验 docx/xlsx 标题段落；',
        'report_job/report_artifact 为新增验收样本数据，未修改既有 7 条 report_record 旧记录。',
      ],
    };
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    baseSummary.rowsAfter = countsAfter[0];
    baseSummary.outputs = outputs;
    baseSummary.snapshotBytes = snapshotBytes;
    baseSummary.metadataPath = metaPath;
    baseSummary.ok = outputs.length === 2 && outputs.every((o) => o.verification.ok);
    console.log(JSON.stringify(baseSummary, null, 2));
    if (!baseSummary.ok) process.exitCode = 2;
  }
  await closePool();
}
