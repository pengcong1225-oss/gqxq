#!/usr/bin/env node
/**
 * clear-seed-complaints.mjs —— 清掉 gqxq_service 里 G0 基线期的 8 条**种子诉求**。
 *
 * 用途：真实来源数据（宜接就办 2026-09-17 导出，466 行）入库前，把基线期的假数据腾空，
 *       使总账里只剩真实数据。**只清诉求域，不动字典与其它模块的参考数据。**
 *
 * 用法：
 *   node scripts/clear-seed-complaints.mjs                       # 预演，只打印，不删
 *   node scripts/clear-seed-complaints.mjs --apply               # 真删
 *   node scripts/clear-seed-complaints.mjs --apply --dump <path>  # 删前把前像写 JSON
 *
 * 安全闸门（任一不满足立刻中止，不做任何删除）：
 *   1) 目标集合必须与 SEED_COMPLAINT_IDS 逐字相等——多一条少一条都中止，
 *      避免脚本被误用到"清空总账"这种灾难用法。
 *   2) 从属表从 information_schema 动态推导（凡有 complaint_id / complaint_no 列的表），
 *      排除 complaint 自身；删除一律按 id 精确 in(?,?,...)，不存在全表清空路径。
 *   3) 全程单事务，且**提交前逐表断言**：实际删除行数必须等于前像行数，
 *      并复检种子行已归零；任一不符即回滚退出。
 *      这条断言不是装饰：首版脚本用 conn.execute 配 in (?) 时，mysql2 的预编译协议
 *      **不展开数组**，删除静默命中 0 行却照样提交、还写了 success 审计。
 *      自那以后本脚本不依赖任何隐式数组展开——占位符按 id 个数显式拼接。
 *
 * 明确不动的数据：
 *   * dict_type / dict_item（字典是参考数据，不是种子业务数据）
 *   * enterprise / service_grid / grid_enterprise（G2 参考数据）
 *   * report_record / pipeline_project / shutdown_application（其它模块的基线数据，本系统尚未实现）
 *   * number_sequence（发号器只增不减；重置反而会造成重号）
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(HERE, '..', '.env') });

/** G0 基线期的 8 条种子诉求（source_id 形如 YJJB/SZRX/WLYQ/WG + 202606xx） */
const SEED_COMPLAINT_IDS = [
  'CPL202606240001',
  'CPL202606250001',
  'CPL202606250002',
  'CPL202606260001',
  'CPL202606260002',
  'CPL202606270001',
  'CPL202606270002',
  'CPL202606280001',
];

/** 显式占位符：每个 id 一个 ?，绝不依赖驱动把数组展开成列表 */
const PH = SEED_COMPLAINT_IDS.map(() => '?').join(', ');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dumpIndex = argv.indexOf('--dump');
const DUMP_PATH = dumpIndex >= 0 ? argv[dumpIndex + 1] : null;

const database = process.env.GQXQ_DB_NAME || 'gqxq_service';
const pool = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database,
  timezone: '+08:00',
  multipleStatements: false,
});

function abort(message) {
  console.error('[clear-seed] 中止：' + message);
  process.exit(2);
}

function jsonReplacer(_key, value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

async function selectIn(conn, table, column) {
  const [rows] = await conn.execute(
    'select * from `' + table + '` where `' + column + '` in (' + PH + ')',
    SEED_COMPLAINT_IDS
  );
  return rows;
}

const conn = await pool.getConnection();
try {
  console.log('[clear-seed] 库=' + database + ' 模式=' + (APPLY ? 'APPLY（真删）' : 'DRY-RUN（预演）'));

  // ── 闸门 1：目标集合必须逐字相等 ────────────────────────────────
  const found = await selectIn(conn, 'complaint', 'complaint_id');
  found.sort((a, b) => String(a.complaint_id).localeCompare(String(b.complaint_id)));
  const foundIds = found.map((r) => r.complaint_id);
  const expectIds = [...SEED_COMPLAINT_IDS].sort();
  const same = foundIds.length === expectIds.length && foundIds.every((v, i) => v === expectIds[i]);
  console.log('[clear-seed] 命中种子诉求 ' + foundIds.length + ' / 期望 ' + expectIds.length);
  for (const r of found) {
    console.log(
      '    ' + r.complaint_id + ' ' + r.complaint_no + ' ' + r.source_system + '/' + r.source_id +
        ' ' + r.complaint_type + '/' + r.business_type + ' created=' + new Date(r.created_at).toISOString() +
        ' deleted=' + r.deleted
    );
  }
  if (!same) {
    abort('实际行集与 SEED_COMPLAINT_IDS 不一致（缺=' + expectIds.filter((v) => !foundIds.includes(v)).join(',') +
      ' 多=' + foundIds.filter((v) => !expectIds.includes(v)).join(',') + '）');
  }

  // ── 闸门 2：动态推导从属表 ─────────────────────────────────────
  const [depCols] = await conn.query(
    "select table_name as t, column_name as c from information_schema.columns " +
      "where table_schema = ? and column_name in ('complaint_id', 'complaint_no') and table_name <> 'complaint' " +
      'order by table_name, column_name',
    [database]
  );
  const deps = depCols.map((r) => ({ table: r.t, column: r.c }));
  console.log('[clear-seed] 需清理的从属表 ' + deps.length + ' 张：' + deps.map((d) => d.table + '.' + d.column).join(', '));

  // ── 前像留痕 ───────────────────────────────────────────────────
  const preImage = {
    database,
    takenAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    seedComplaintIds: SEED_COMPLAINT_IDS,
    complaints: found,
    dependents: {},
  };
  for (const d of deps) {
    preImage.dependents[d.table + '.' + d.column] = await selectIn(conn, d.table, d.column);
  }
  if (DUMP_PATH) {
    writeFileSync(DUMP_PATH, JSON.stringify(preImage, jsonReplacer, 2), 'utf8');
    console.log('[clear-seed] 前像已写入 ' + DUMP_PATH);
  }

  const expected = {};
  for (const d of deps) expected[d.table + '.' + d.column] = preImage.dependents[d.table + '.' + d.column].length;
  console.log('[clear-seed] 将删除的从属行数：');
  for (const [k, v] of Object.entries(expected)) if (v > 0) console.log('    ' + k + ' = ' + v);
  const totalDep = Object.values(expected).reduce((a, b) => a + b, 0);
  console.log('[clear-seed] 从属行合计 ' + totalDep + ' 行 + complaint ' + foundIds.length + ' 行');

  if (!APPLY) {
    console.log('[clear-seed] DRY-RUN 结束，未改动任何数据。加 --apply 才真删。');
    process.exit(0);
  }

  // ── 闸门 3：单事务删除 + 提交前断言 ────────────────────────────
  await conn.beginTransaction();
  try {
    const deleted = {};
    for (const d of deps) {
      const [res] = await conn.execute(
        'delete from `' + d.table + '` where `' + d.column + '` in (' + PH + ')',
        SEED_COMPLAINT_IDS
      );
      deleted[d.table + '.' + d.column] = res.affectedRows;
    }
    const [resC] = await conn.execute('delete from complaint where complaint_id in (' + PH + ')', SEED_COMPLAINT_IDS);
    deleted.complaint = resC.affectedRows;

    // 断言 A：逐表实际删除行数 == 前像行数
    const mismatch = [];
    for (const [key, want] of Object.entries(expected)) {
      if (deleted[key] !== want) mismatch.push(key + ' 期望 ' + want + ' 实际 ' + deleted[key]);
    }
    // 断言 B：complaint 删除行数 == 目标条数
    if (deleted.complaint !== SEED_COMPLAINT_IDS.length) {
      mismatch.push('complaint 期望 ' + SEED_COMPLAINT_IDS.length + ' 实际 ' + deleted.complaint);
    }
    // 断言 C：事务内复检，种子行必须已归零
    const stillMine = await selectIn(conn, 'complaint', 'complaint_id');
    if (stillMine.length !== 0) mismatch.push('复检仍有 ' + stillMine.length + ' 条种子诉求');
    if (mismatch.length > 0) {
      throw new Error('删除结果与预期不符，拒绝提交：' + mismatch.join('；'));
    }

    await conn.execute(
      'insert into operation_audit_log ' +
        '(audit_id, user_id, app_code, resource_code, action, biz_type, biz_id, result, client_ip, detail, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'AUD-' + randomUUID(),
        null,
        'gqxq',
        'complaint',
        'SEED_PURGE',
        'complaint',
        null,
        'success',
        null,
        JSON.stringify({
          reason: '真实来源数据入库前清空 G0 基线种子',
          database,
          deleted,
          seeds: foundIds,
          preImageDump: DUMP_PATH,
          script: 'clear-seed-complaints.mjs',
        }),
        new Date(),
      ]
    );
    await conn.commit();
    console.log('[clear-seed] 已提交，断言全部通过。实际删除行数：');
    for (const [k, v] of Object.entries(deleted)) if (v > 0) console.log('    ' + k + ' = ' + v);
  } catch (err) {
    await conn.rollback();
    console.error('[clear-seed] 出错已回滚：' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }

  const [left] = await conn.query('select count(*) n from complaint');
  console.log('[clear-seed] 完成。complaint 剩余 ' + left[0].n + ' 行');
} finally {
  conn.release();
  await pool.end();
}
