#!/usr/bin/env node
/**
 * 1.1.8 企业用户管理 —— 大屏展示字段回填（12 家企业）
 *
 * 背景：审查报告（01-后台A-诉求数据与详情.md §1.1.8）实测 enterprise 表 12 家企业的
 * display_on_screen / screen_name 全部为 NULL，导致「是否大屏显示 / 大屏显示企业名」两个
 * 标书字段 0 配置。本脚本按审查报告 5.3 第 4 项做一次性数据配置（非开发改动）。
 *
 * 约束（与任务卡一致）：
 *   - 默认 dry-run，只有 --apply 才写库；
 *   - 只匹配 display_on_screen IS NULL 且 screen_name IS NULL 的行；
 *   - 只写 display_on_screen=1、screen_name=enterprise_name 两个字段，不动 version 等其他列；
 *   - 不删行、不建表、不改 complaint；
 *   - --apply 前先把命中行整行备份到 deliverables 的 验收样本/enterprise-before.json；
 *   - 执行后逐列校验命中行只有这两个字段变化，且未命中行完全不变。
 *
 * 用法（在 gqxq/server 下）：
 *   npx tsx scripts/backfill-enterprise-screen-fields.mjs                 # dry-run（默认）
 *   npx tsx scripts/backfill-enterprise-screen-fields.mjs --dry-run
 *   npx tsx scripts/backfill-enterprise-screen-fields.mjs --apply
 *   [--deliverables=<目录>] [--force]（--force：允许覆盖已存在的备份 / 命中数≠12 时仍然执行）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const EXPECTED_COUNT = 12;
const DRY_RUN = !APPLY;

function argValue(name) {
  const prefix = '--' + name + '=';
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const DELIVERABLES_DIR = resolve(
  argValue('deliverables') ||
    process.env.GQXQ_DELIVERABLES_DIR ||
    'D:/deepSeekHerness/zhuxinServer/deliverables/标书符合性审查-20261118',
);
const SAMPLE_DIR = resolve(DELIVERABLES_DIR, '验收样本');
const BEFORE_PATH = resolve(SAMPLE_DIR, 'enterprise-before.json');
const AFTER_PATH = resolve(SAMPLE_DIR, 'enterprise-after.json');

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error('缺少环境变量 ' + name + '（请在 server/.env 中配置）');
  return String(v).trim();
}

const dbConfig = {
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: requireEnv('GQXQ_DB_USER'),
  password: process.env.GQXQ_DB_PASSWORD || '',
  database: requireEnv('GQXQ_DB_NAME'),
  charset: 'utf8mb4',
  timezone: '+08:00',
};

const CANDIDATE_SQL =
  'select * from enterprise where display_on_screen is null and screen_name is null order by enterprise_code';
const ALL_SQL = 'select * from enterprise order by enterprise_code';

const sameRow = (a, b, ignored) =>
  Object.keys(a).every((k) => ignored.includes(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]));

const maskSensitive = (row) => {
  const copy = { ...row };
  if (copy.contact_phone) copy.contact_phone = '***';
  return copy;
};

const conn = await mysql.createConnection(dbConfig);
const summary = {
  mode: DRY_RUN ? 'dry-run' : 'apply',
  database: dbConfig.database,
  deliverablesDir: DELIVERABLES_DIR,
  expectedCount: EXPECTED_COUNT,
};

try {
  const [beforeAll] = await conn.query(ALL_SQL);
  const [candidates] = await conn.query(CANDIDATE_SQL);
  const [countsBefore] = await conn.query(
    `select
       count(*) as total,
       sum(display_on_screen is null) as display_on_screen_null,
       sum(screen_name is null) as screen_name_null,
       sum(display_on_screen is null and screen_name is null) as both_null,
       sum(display_on_screen is null or screen_name is null) as either_null,
       sum(display_on_screen = 1) as display_on_screen_1,
       sum(screen_name is not null) as screen_name_set
     from enterprise`,
  );
  summary.before = countsBefore[0];
  summary.candidateCount = candidates.length;
  summary.totalEnterpriseRows = beforeAll.length;

  const tooLong = candidates.filter((r) => !r.enterprise_name || String(r.enterprise_name).length > 128);
  if (tooLong.length) {
    summary.skippedTooLong = tooLong.map((r) => r.enterprise_code);
  }

  const configuredAlready = beforeAll.filter((r) => r.display_on_screen !== null || r.screen_name !== null);

  if (!candidates.length) {
    summary.note = '没有命中行（可能已配置过，或前置条件不满足）；未写库。';
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  if (DRY_RUN) {
    summary.plan = candidates.map((r) => ({
      enterprise_code: r.enterprise_code,
      enterprise_name: r.enterprise_name,
      business_type: r.business_type,
      status: r.status,
      set: { display_on_screen: 1, screen_name: r.enterprise_name },
    }));
    summary.configuredRowsBefore = configuredAlready.map((r) => r.enterprise_code);
    summary.note = '[dry-run] 未写库；确认后加 --apply 执行。';
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // ---------- apply ----------
  if (candidates.length !== EXPECTED_COUNT && !FORCE) {
    throw new Error(
      `命中 ${candidates.length} 行，与审查基线 ${EXPECTED_COUNT} 行不一致；为避免误改，先 --dry-run 核对，必要时加 --force。`,
    );
  }
  if (tooLong.length && !FORCE) {
    throw new Error('存在 enterprise_name 为空或超过 screen_name(128) 长度的行，停止执行：' + tooLong.map((r) => r.enterprise_code).join(','));
  }
  if (existsSync(BEFORE_PATH) && !FORCE) {
    throw new Error(
      '备份文件已存在，为保留首次变更前快照不覆盖：' + BEFORE_PATH + '（确需重跑请加 --force）',
    );
  }
  const updateRows = candidates.filter((r) => !tooLong.includes(r));
  const ids = updateRows.map((r) => Number(r.id));
  const backup = {
    capturedAt: new Date().toISOString(),
    database: dbConfig.database,
    table: 'enterprise',
    predicate: 'display_on_screen is null and screen_name is null',
    columns: Object.keys(beforeAll[0] ?? candidates[0] ?? {}),
    count: updateRows.length,
    rows: updateRows,
  };
  mkdirSync(dirname(BEFORE_PATH), { recursive: true });
  writeFileSync(BEFORE_PATH, JSON.stringify(backup, null, 2) + '\n', 'utf8');
  summary.backupPath = BEFORE_PATH;

  // 备份回读自检：必须与内存候选行一致，否则不写库
  const reread = JSON.parse(readFileSync(BEFORE_PATH, 'utf8'));
  if (reread.count !== updateRows.length) throw new Error('备份回读行数不一致，停止执行');

  const placeholders = ids.map(() => '?').join(',');
  let affected = 0;
  await conn.beginTransaction();
  try {
    const [res] = await conn.query(
      `update enterprise
          set display_on_screen = 1, screen_name = enterprise_name
        where id in (${placeholders})
          and display_on_screen is null
          and screen_name is null`,
      ids,
    );
    affected = Number(res.affectedRows);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  summary.affectedRows = affected;

  // ---------- 执行后校验 ----------
  const [afterAll] = await conn.query(ALL_SQL);
  const byId = new Map(afterAll.map((r) => [Number(r.id), r]));
  const targeted = updateRows.map((r) => byId.get(Number(r.id)));
  const targetOk = targeted.every(
    (r) => r && Number(r.display_on_screen) === 1 && String(r.screen_name) === String(r.enterprise_name),
  );
  const targetCoverage = targeted.filter(
    (r) => r && Number(r.display_on_screen) === 1 && String(r.screen_name) === String(r.enterprise_name),
  ).length;
  const changedOtherColumns = updateRows.filter((before) => {
    const after = byId.get(Number(before.id));
    return !after || !sameRow(before, after, ['display_on_screen', 'screen_name']);
  });
  const beforeById = new Map(beforeAll.map((r) => [Number(r.id), r]));
  const untouchedChanged = afterAll
    .filter((r) => !ids.includes(Number(r.id)))
    .filter((r) => !sameRow(beforeById.get(Number(r.id)), r, []));
  const [countsAfter] = await conn.query(
    `select
       count(*) as total,
       sum(display_on_screen is null) as display_on_screen_null,
       sum(screen_name is null) as screen_name_null,
       sum(display_on_screen is null and screen_name is null) as both_null,
       sum(display_on_screen is null or screen_name is null) as either_null,
       sum(display_on_screen = 1) as display_on_screen_1,
       sum(screen_name is not null) as screen_name_set,
       sum(display_on_screen = 1 and screen_name = enterprise_name) as configured_matching_name
     from enterprise`,
  );
  summary.after = countsAfter[0];
  summary.coverage = {
    targetedRows: updateRows.length,
    configuredAndNamedCorrectly: targetCoverage,
    allTargetedOk: targetOk,
    otherColumnsChanged: changedOtherColumns.map((r) => r.enterprise_code),
    untouchedRowsChanged: untouchedChanged.map((r) => r.enterprise_code),
  };
  summary.verification = {
    rowCountUnchanged: afterAll.length === beforeAll.length,
    onlyTwoFieldsChanged: changedOtherColumns.length === 0,
    otherRowsUnchanged: untouchedChanged.length === 0,
    twelveRowsCovered: targetCoverage === EXPECTED_COUNT,
    nullScreenFieldsRemaining: Number(countsAfter[0].both_null),
    configuredMatchingName: Number(countsAfter[0].configured_matching_name),
  };
  const afterDoc = {
    capturedAt: new Date().toISOString(),
    database: dbConfig.database,
    table: 'enterprise',
    predicate: 'id in (' + ids.join(',') + ')',
    count: targeted.length,
    rows: targeted,
    verification: summary.verification,
    countsBefore: countsBefore[0],
    countsAfter: countsAfter[0],
  };
  writeFileSync(AFTER_PATH, JSON.stringify(afterDoc, null, 2) + '\n', 'utf8');
  summary.afterPath = AFTER_PATH;

  if (
    !summary.verification.rowCountUnchanged ||
    !summary.verification.onlyTwoFieldsChanged ||
    !summary.verification.otherRowsUnchanged ||
    !summary.verification.twelveRowsCovered ||
    !targetOk
  ) {
    summary.ok = false;
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
  } else {
    summary.ok = true;
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await conn.end();
}
