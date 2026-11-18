#!/usr/bin/env node
/**
 * 回填「实际完成时间 / 规定完成时间」到 complaint.source_completed_at / source_deadline_at
 * 数据源：complaint_source_log.payload.metadata（宜接就办导出批次）
 *
 * 用法：
 *   node scripts/backfill-completion-time.mjs --dry-run   # 只读，打印将更新条数与样例
 *   node scripts/backfill-completion-time.mjs --apply     # 真正更新（只填空值，不覆盖已有值）
 *
 * 约束：
 *   - 不新增表结构；
 *   - 不覆盖 source_completed_at / source_deadline_at 非空的行；
 *   - 同一 complaint 多条 source_log 时取 received_at 最新且值非空的一条。
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;
if (process.argv.includes('--dry-run')) {
 // 显式 dry-run，默认也是 dry-run
}

const pad = (n) => String(n).padStart(2, '0');

/** 解析源字段（Asia/Shanghai 墙钟字符串）为 MySQL DATETIME 字符串 */
function parseDateTime(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  // 容错：2026-09-17 12:58:17 / 2026/09/17 12:58:17 / ISO
  const m = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toPayloadObject(payload) {
  if (!payload) return null;
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

const dbConfig = {
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER || 'root',
  password: process.env.GQXQ_DB_PASSWORD || 'qwer1234',
  database: process.env.GQXQ_DB_NAME || 'gqxq_service',
  charset: 'utf8mb4',
  timezone: '+08:00',
};

const conn = await mysql.createConnection(dbConfig);

try {
  const [logs] = await conn.query(
    `SELECT id, complaint_id, payload, received_at
       FROM complaint_source_log
      WHERE payload IS NOT NULL
      ORDER BY received_at ASC, id ASC`
  );

  /** @type {Map<string, {actual:string|null, deadline:string|null, logId:number}>} */
  const picked = new Map();
  let parseFailures = 0;
  let nonEmptyActual = 0;
  let nonEmptyDeadline = 0;
  const samples = [];
  const failureSamples = [];

  for (const row of logs) {
    const payload = toPayloadObject(row.payload);
    const metadata = payload?.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    const actualRaw = metadata['实际完成时间'];
    const deadlineRaw = metadata['规定完成时间'];
    const actual = parseDateTime(actualRaw);
    const deadline = parseDateTime(deadlineRaw);
    if (typeof actualRaw === 'string' && actualRaw.trim()) nonEmptyActual += 1;
    if (typeof deadlineRaw === 'string' && deadlineRaw.trim()) nonEmptyDeadline += 1;
    if ((typeof actualRaw === 'string' && actualRaw.trim() && !actual) || (typeof deadlineRaw === 'string' && deadlineRaw.trim() && !deadline)) {
      parseFailures += 1;
      if (failureSamples.length < 5) failureSamples.push({ complaintId: row.complaint_id, actualRaw, deadlineRaw });
    }
    if (!actual && !deadline) continue;
    const cid = row.complaint_id;
    if (!cid) continue;
    picked.set(String(cid), { actual, deadline, logId: Number(row.id) });
    if (samples.length < 8) samples.push({ complaintId: cid, actual, deadline, logId: Number(row.id) });
  }

  const entries = [...picked.entries()];
  const ids = entries.map(([id]) => id);
  let existing = new Map();
  let missingComplaints = 0;
  if (ids.length) {
    const [rows] = await conn.query(
      `SELECT complaint_id, source_completed_at, source_deadline_at
         FROM complaint
        WHERE complaint_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    existing = new Map(rows.map((r) => [String(r.complaint_id), r]));
    missingComplaints = ids.filter((id) => !existing.has(id)).length;
  }

  const plan = [];
  let skippedFilled = 0;
  for (const [complaintId, value] of entries) {
    const row = existing.get(complaintId);
    if (!row) continue;
    const fillActual = value.actual && row.source_completed_at == null ? value.actual : null;
    const fillDeadline = value.deadline && row.source_deadline_at == null ? value.deadline : null;
    if (!fillActual && !fillDeadline) {
      skippedFilled += 1;
      continue;
    }
    plan.push({ complaintId, actual: fillActual, deadline: fillDeadline });
  }

  console.log(
    JSON.stringify(
      {
        mode: DRY ? 'dry-run' : 'apply',
        sourceLogs: logs.length,
        nonEmptyActual,
        nonEmptyDeadline,
        candidates: entries.length,
        parseFailures,
        missingComplaints,
        skippedAlreadyFilled: skippedFilled,
        wouldUpdate: plan.length,
        dryRun: DRY,
        samples,
        failureSamples,
      },
      null,
      2
    )
  );

  if (DRY) {
    console.log('\n[dry-run] 未写库；确认后使用 --apply 执行。');
  } else {
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of plan) {
      try {
        const [res] = await conn.query(
          `UPDATE complaint
              SET source_completed_at = COALESCE(source_completed_at, ?),
                  source_deadline_at = COALESCE(source_deadline_at, ?)
            WHERE complaint_id = ?`,
          [item.actual, item.deadline, item.complaintId]
        );
        if (res.affectedRows > 0) updated += 1;
        else skipped += 1;
      } catch (e) {
        failed += 1;
        console.error(`[apply] 更新失败 ${item.complaintId}: ${e.message}`);
      }
    }
    console.log(JSON.stringify({ applied: true, updated, skipped, failed }, null, 2));
  }
} finally {
  await conn.end();
}
