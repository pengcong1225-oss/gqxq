#!/usr/bin/env node
/**
 * phone-mask-20260920.mjs —— 手机号脱敏执行批次（2026-09-20 裁定口径）
 *
 * 依据：docs/2026-09-20-手机号脱敏方案.md + 用户 2026-09-20 裁定（覆盖文档推荐的 P-1）。
 *
 * 【裁定口径 = 本脚本只脱派生列，不扩面到留痕】
 *   1) complaint.content                                  （预检严格命中 10 行）
 *   2) complaint_field_version.old_value（field_name='title'）（预检严格命中 5 行）
 *   留痕两列**不动**：complaint.source_payload（68）/ complaint_source_log.payload（204）。
 *   title（命中 0）、enterprise.contact_phone、operation_audit_log 均不在本脚本范围内。
 *
 * 【占位规则】11 位手机号 (?<!\d)1[3-9]\d{9}(?!\d) → 前 3 + `****` + 后 4
 *   例（假号）：13800138000 → 138****8000；**长度不变（11→11）**、不可逆、不建映射表。
 *   掩码后含 `****` 非数字，不再匹配宽松式 ⇒ 天然幂等。
 *
 * 【为什么 JS 侧替换、不用 SQL REGEXP_REPLACE】
 *   本库 MySQL 8 用 ICU，不支持 lookbehind，两侧非数字边界只能消耗式捕获，相邻两号有漏掩风险；
 *   Node 的 (?<!\d)/(?!\d) 天然处理边界。SQL 侧只承担「定位候选」与「断言」两个角色。
 *
 * 用法：
 *   node scripts/phone-mask-20260920.mjs              # dry-run：只 SELECT，打印将改动行数 + 主键清单（不给内容）
 *   node scripts/phone-mask-20260920.mjs --apply      # execute：事务内逐行 UPDATE（按主键），提交前断言，任一 FAIL 回滚
 *
 * 闸门（任一不符即中止，绝不写）：
 *   - 被改行数必须逐一等于 EXPECT（content 10 / field_version.title 5）；
 *     仅当目标严格命中已为 0 且无行可改时放行（幂等复跑）。防的是「库被别人改过」而非脚本 bug。
 *   - 目标表总行数：complaint 464 / complaint_field_version 43。
 *
 * 断言（execute，提交前在同一事务内实算，不信脚本自述）：
 *   A1 目标两列严格命中归零（content=0、fv.old_value(title)=0）
 *   A2 总行数不变（464 / 43）
 *   A3 被改行 char_length 前后相等（11→11）
 *   A4 留痕两列命中仍为 68 / 204（证明没扩面）
 *   A5 title 严格命中仍为 0（防写歪）
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(HERE, '..', '.env') });

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply') || argv.includes('--execute');

const database = process.env.GQXQ_DB_NAME || 'gqxq_service';

// 严格式（MySQL/ICU）：带非数字边界，排除长数字串内子串误配。SQL 侧仅用于定位与断言。
const STRICT_SQL = "(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)";
// 号码识别（JS）：等价严格式，替换为前3+****+后4。
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

function maskPhone(text) {
  return String(text).replace(PHONE_RE, (m) => m.slice(0, 3) + '****' + m.slice(7));
}

/** 脱敏目标（派生列，两列）。where 为附加行过滤（不传则该列全表定位）。 */
const TARGETS = [
  { label: 'complaint.content', table: 'complaint', pk: 'id', col: 'content', extraWhere: '', expect: 10 },
  { label: "complaint_field_version.old_value(field_name='title')", table: 'complaint_field_version', pk: 'id', col: 'old_value', extraWhere: "field_name = 'title'", expect: 5 },
];

/** 留痕基线（只读核对，不写）：脱敏后必须仍为原计数，证明没扩面。 */
const BASELINE_TOTALS = [
  { label: 'complaint 总行数', table: 'complaint', want: 464 },
  { label: 'complaint_field_version 总行数', table: 'complaint_field_version', want: 43 },
];
const TRACE_BASELINE = [
  { label: 'complaint.source_payload（留痕，不动）', table: 'complaint', col: 'cast(source_payload as char)', want: 68 },
  { label: 'complaint_source_log.payload（留痕，不动）', table: 'complaint_source_log', col: 'cast(payload as char)', want: 204 },
];

/** 目标列的严格命中定位片段（colExpr 为完整列表达式：`col` 或 cast(... as char)）。 */
function whereOf(t) {
  return '`' + t.col + '` regexp "' + STRICT_SQL + '"' + (t.extraWhere ? ' and ' + t.extraWhere : t.extraWhere);
}

function strictWhere(colExpr, extraWhere) {
  return (extraWhere ? extraWhere + ' and ' : '') + colExpr + ' regexp "' + STRICT_SQL + '"';
}

const pool = mysql.createPool({
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: process.env.GQXQ_DB_USER,
  password: process.env.GQXQ_DB_PASSWORD,
  database,
  timezone: '+08:00',
  multipleStatements: false,
  bigNumberStrings: false,
});

const conn = await pool.getConnection();

function abort(msg) {
  console.error('[phone-mask] 中止：' + msg);
  process.exitCode = 2;
}

/** 严格命中计数（聚合，不取任何原文/整行）。colExpr 为完整列表达式。 */
async function strictCount(table, colExpr, extraWhere = '') {
  const [rows] = await conn.query('select count(*) n from `' + table + '` where ' + strictWhere(colExpr, extraWhere));
  return Number(rows[0].n);
}

async function main() {
try {
  console.log('[phone-mask] 库=' + database + ' 模式=' + (APPLY ? 'EXECUTE（--apply，真写）' : 'DRY-RUN（预演，零写入）'));
  console.log('[phone-mask] 裁定口径：只脱派生列 2 处；留痕 source_payload/source_log 不动。');

  // ── 采集改动计划（两模式共用；只 SELECT）───────────────────────
  const plans = [];
  for (const t of TARGETS) {
    const [cand] = await conn.query(
      'select `' + t.pk + '` pk, char_length(`' + t.col + '`) len from `' + t.table +
      '` where ' + whereOf(t) + ' order by `' + t.pk + '`'
    );
    // JS 二次核验：只对 JS 正则确实改动的行计入（防 SQL/JS 边界差异导致过/漏选）
    const changes = [];
    for (const row of cand) {
      const [full] = await conn.query('select `' + t.col + '` v from `' + t.table + '` where `' + t.pk + '` = ?', [row.pk]);
      const before = full[0].v == null ? '' : String(full[0].v);
      const after = maskPhone(before);
      if (after !== before) changes.push({ pk: row.pk, beforeLen: Number(row.len), after });
    }
    plans.push({ t, changes });
    console.log('[phone-mask] ' + t.label + ' → 将改动 ' + changes.length + ' 行（期望 ' + t.expect + '）');
    console.log('             主键清单：' + (changes.map((c) => c.pk).join(', ') || '(无)'));
  }

  // ── 闸门 ──────────────────────────────────────────────────────
  for (const { t, changes } of plans) {
    if (changes.length !== t.expect) {
      const nowStrict = await strictCount(t.table, '`' + t.col + '`', t.extraWhere);
      if (!(changes.length === 0 && nowStrict === 0)) {
        abort(t.label + ' 将改 ' + changes.length + ' 行 ≠ 期望 ' + t.expect +
          '（当前严格命中 ' + nowStrict + '），库可能被改动，拒绝执行');
        return;
      }
      console.log('[phone-mask] 闸门放行（幂等复跑）：' + t.label + ' 已无命中，0 变更');
    }
  }
  for (const b of BASELINE_TOTALS) {
    const [r] = await conn.query('select count(*) n from `' + b.table + '`');
    const n = Number(r[0].n);
    console.log('[phone-mask] 基线总行数 ' + b.label + ' = ' + n + '（期望 ' + b.want + '）');
    if (n !== b.want) {
      abort(b.label + ' 实际 ' + n + ' ≠ 期望 ' + b.want);
      return;
    }
  }

  if (!APPLY) {
    const total = plans.reduce((a, p) => a + p.changes.length, 0);
    console.log('[phone-mask] DRY-RUN 结束：合计将改 ' + total + ' 行，未写入任何数据。加 --apply 才真脱。');
    return;
  }

  // ── EXECUTE：单事务，逐行按主键 UPDATE（id 升序已在候选查询保证）──
  await conn.beginTransaction();
  try {
    let wrote = 0;
    for (const { t, changes } of plans) {
      for (const c of changes) {
        const [res] = await conn.execute(
          'update `' + t.table + '` set `' + t.col + '` = ? where `' + t.pk + '` = ?',
          [c.after, c.pk]
        );
        if (res.affectedRows !== 1) throw new Error('UPDATE 未精确命中主键 ' + t.table + '.' + t.pk + '=' + c.pk + '（affected=' + res.affectedRows + '）');
        wrote++;
      }
    }
    console.log('[phone-mask] 事务内已回写 ' + wrote + ' 行，开始提交前断言（同事务实算）…');

    const fails = [];
    // A1 目标两列严格命中归零
    for (const t of TARGETS) {
      const hit = await strictCount(t.table, '`' + t.col + '`', t.extraWhere);
      console.log('   [A1] ' + t.label + ' 严格命中 = ' + hit + '（期望 0）');
      if (hit !== 0) fails.push('A1 ' + t.label + ' 仍命中 ' + hit);
    }
    // A2 总行数不变
    for (const b of BASELINE_TOTALS) {
      const [r] = await conn.query('select count(*) n from `' + b.table + '`');
      const n = Number(r[0].n);
      console.log('   [A2] ' + b.label + ' = ' + n + '（期望 ' + b.want + '）');
      if (n !== b.want) fails.push('A2 ' + b.label + ' 变 ' + n);
    }
    // A3 被改行 char_length 前后相等（11→11）
    let lenChecked = 0;
    for (const { t, changes } of plans) {
      for (const c of changes) {
        const [r] = await conn.query('select char_length(`' + t.col + '`) len from `' + t.table + '` where `' + t.pk + '` = ?', [c.pk]);
        const now = Number(r[0].len);
        if (now !== c.beforeLen) fails.push('A3 ' + t.table + '.' + t.pk + '=' + c.pk + ' 长度 ' + c.beforeLen + '→' + now);
        lenChecked++;
      }
    }
    console.log('   [A3] 逐行长度校验 ' + lenChecked + ' 行，全部相等=' + (fails.filter((f) => f.startsWith('A3')).length === 0));
    // A4 留痕两列命中仍为基线（证明没扩面）
    for (const b of TRACE_BASELINE) {
      const hit = await strictCount(b.table, b.col, '');
      console.log('   [A4] ' + b.label + ' = ' + hit + '（期望 ' + b.want + '）');
      if (hit !== b.want) fails.push('A4 留痕 ' + b.table + ' 命中变 ' + hit + '（应 ' + b.want + '，疑扩面）');
    }
    // A5 title 严格命中仍 0
    const titleHit = await strictCount('complaint', '`title`', '');
    console.log('   [A5] complaint.title 严格命中 = ' + titleHit + '（期望 0）');
    if (titleHit !== 0) fails.push('A5 title 命中 ' + titleHit + '（疑写歪）');

    if (fails.length > 0) {
      throw new Error('断言未通过：\n     ' + fails.join('\n     '));
    }
    await conn.commit();
    console.log('[phone-mask] 断言全绿，已提交。实际改写 ' + wrote + ' 行。');
  } catch (err) {
    await conn.rollback();
    console.error('[phone-mask] 出错已回滚，库保持现场：' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
} catch (err) {
  console.error('[phone-mask] 异常：' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
}

await main();
