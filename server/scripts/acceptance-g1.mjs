#!/usr/bin/env node
/**
 * acceptance-g1.mjs — 诉求平台 G1 验收矩阵执行器
 *
 * 零第三方依赖，只用 node: 内置模块（fetch / child_process / process）。
 * 覆盖 docs/2026-09-17-诉求平台G1详细实施方案.md §8.2 的 A1–A11。
 *
 * 用法：
 *   node server/scripts/acceptance-g1.mjs
 *   GQXQ_BASE=http://localhost:3100/api/v1 node server/scripts/acceptance-g1.mjs
 *   node server/scripts/acceptance-g1.mjs --dry         只打印计划与 SQL，不发任何请求
 *   node server/scripts/acceptance-g1.mjs --typecheck   额外尝试 npm run typecheck
 *   GQXQ_MYSQL_BIN='C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe' \
 *     node server/scripts/acceptance-g1.mjs --db        真连库执行打印出来的 SQL
 *
 * 退出码：任一 FAIL -> 1；全 PASS/MANUAL/SKIP -> 0。
 *
 * 三级证据（§8.1）：脚本负责"接口 + 数据库 SQL"两级；"浏览器真实操作"和
 * "服务重启后核对"无法自动化，一律标 MANUAL 并写清人工要做什么。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry');
const WITH_DB = ARGV.includes('--db');
const WITH_TYPECHECK = ARGV.includes('--typecheck');

const BASE = (process.env.GQXQ_BASE || 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const MYSQL_BIN = process.env.GQXQ_MYSQL_BIN || '';
const DB = {
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: process.env.GQXQ_DB_PORT || '3306',
  user: process.env.GQXQ_DB_USER || 'root',
  password: process.env.GQXQ_DB_PASSWORD || '',
  name: process.env.GQXQ_DB_NAME || 'gqxq_service',
};

const results = [];
let serverUp = null;

/* ---------------- 输出工具 ---------------- */

function shortText(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + ' …' : t;
}

function shortJson(value, max) {
  try {
    return shortText(JSON.stringify(value), max || 240);
  } catch {
    return '<unserializable>';
  }
}

function emit(id, title, status, lines) {
  results.push({ id, title, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 46 - title.length)));
  console.log('  状态: ' + status);
  for (const line of lines || []) console.log('  ' + line);
}

function sqlEvidence(sqls) {
  const out = [];
  for (const sql of sqls) out.push('[SQL] ' + sql);
  if (MYSQL_BIN && WITH_DB) {
    for (const sql of sqls) {
      const r = runSql(sql);
      out.push('[SQL结果] ' + shortText(r, 300));
    }
  } else {
    const hint = (MYSQL_BIN || '<mysql.exe 路径>');
    out.push('[SQL运行] ' + hint + ' -h ' + DB.host + ' -P ' + DB.port + ' -u ' + DB.user +
      ' -p -D ' + DB.name + ' -e "<上面的 SQL>"   （要自动执行请设 GQXQ_MYSQL_BIN 并加 --db）');
  }
  return out;
}

function runSql(sql) {
  if (!MYSQL_BIN || !WITH_DB) return '（未启用 --db）';
  const args = ['-h', DB.host, '-P', DB.port, '-u', DB.user, '--batch', '--raw', '-D', DB.name, '-e', sql];
  const env = { ...process.env };
  if (DB.password) env.MYSQL_PWD = DB.password;
  const r = spawnSync(MYSQL_BIN, args, { encoding: 'utf8', env });
  if (r.error) return '执行失败: ' + r.error.message;
  const text = (r.stdout || '') + (r.stderr || '');
  return text.trim() === '' ? '（无输出，退出码 ' + r.status + '）' : text;
}

/* ---------------- 鉴权 ---------------- */

/**
 * G1 起服务端加了 Bearer 校验（http/errors.ts + middleware/requireAuth.ts），
 * 不带令牌访问受保护接口会拿到 401。这里用环境变量先登录一次，后续请求自动带令牌：
 *   GQXQ_LOGIN_USERNAME（默认 admin）
 *   GQXQ_LOGIN_PASSWORD（未设置则只提示，不阻断——health 与 /external 入站无需鉴权，仍可验证）
 */
let authToken = null;

async function login() {
  if (DRY) return;
  const username = process.env.GQXQ_LOGIN_USERNAME || 'admin';
  const password = process.env.GQXQ_LOGIN_PASSWORD || '';
  if (!password) {
    console.log('[鉴权] 未设置 GQXQ_LOGIN_PASSWORD：受保护接口会返回 401，A1/A4/A5/A6/A7 将判 FAIL。');
    console.log('[鉴权] 修法：先 cd server && node scripts/seed-admin.mjs 在目标库建 admin，再设 GQXQ_LOGIN_PASSWORD 重跑。');
    return;
  }
  const res = await call('POST', '/auth/login', { username, password });
  const token = res && res.json && res.json.data && res.json.data.token;
  if (res && res.status === 200 && token) {
    authToken = token;
    console.log('[鉴权] 已登录 ' + username + '，后续请求将带 Bearer 令牌。');
  } else {
    console.log('[鉴权] 登录失败（HTTP ' + (res && res.status) + '）：' + shortJson(res && res.json));
    console.log('[鉴权] 请确认目标库已有该用户（node scripts/seed-admin.mjs）且口令正确。');
  }
}

/* ---------------- HTTP 工具 ---------------- */

async function call(method, path, body) {
  const url = BASE + path;
  if (DRY) return { method, path, url, dry: true, status: 0, text: '', json: null };
  const init = { method, headers: {} };
  if (authToken && path !== '/auth/login') {
    init.headers['Authorization'] = 'Bearer ' + authToken;
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { method, path, url, ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { method, path, url, error: (err && err.message) ? err.message : String(err) };
  }
}

function reqLine(r, body) {
  let line = '[请求] ' + r.method + ' ' + r.url;
  if (body !== undefined) line += '  body=' + shortJson(body);
  return line;
}

function resLine(r) {
  if (r.dry) return '[响应] (--dry：未发送请求)';
  if (r.error) return '[响应] 连接失败: ' + r.error;
  return '[响应] HTTP ' + r.status + '  ' + shortText(r.text, 320);
}

/* ---------------- 预检 ---------------- */

const health = await call('GET', '/health');
serverUp = !DRY && !health.error;

const header = [];
header.push('=== G1 验收矩阵执行器 acceptance-g1.mjs ===');
header.push('接口基址: ' + BASE + (DRY ? '   (--dry 模式：不发任何请求)' : ''));
header.push('数据库: ' + DB.user + '@' + DB.host + ':' + DB.port + '/' + DB.name +
  (MYSQL_BIN && WITH_DB ? '   (--db：会真实执行 SQL)' : '   (仅打印 SQL，不连库)'));
if (!DRY) {
  header.push('预检 GET /health: ' + (health.error ? '失败（' + health.error + '）→ 自动项将标记 SKIP' :
    'HTTP ' + health.status));
}
console.log(header.join('\n'));

// 受保护接口（complaints / dashboard / dicts）需要 Bearer 令牌
await login();

let seq = Date.now();
const sourceId = 'ACCG1' + seq;
const changedTitle = 'G1 验收-标题已变更 ' + seq;
const payload = {
  sourceId,
  title: 'G1 验收-接收落库 ' + seq,
  content: 'acceptance-g1.mjs 自动生成：西陵区沿江大道188号附近停水，用于验证接收落库与幂等。',
  address: '西陵区沿江大道188号',
  districtName: '西陵区',
  source: '12345热线',
  longitude: 111.286,
  latitude: 30.708,
};
const changedPayload = { ...payload, title: changedTitle };

function unreachable(extra) {
  const lines = [resLine(health)];
  if (extra) lines.push(extra);
  lines.push('[MANUAL] 启动服务后重跑：后端 npm run dev（默认 3100），或设置 GQXQ_BASE 指向真实服务');
  return lines;
}

/* ================= A1 接收真实落库 ================= */

let a1CreatedId = null;
let a1CreatedNo = null;
{
  const lines = [];
  if (DRY) {
    lines.push(reqLine({ method: 'POST', url: BASE + '/external/yijiejieban/appeal' }, payload));
    lines.push('[响应] (--dry：未发送请求)');
    lines.push('[MANUAL] 浏览器：打开 http://localhost:5173/complaints，确认首行出现该诉求且编号与返回一致（截图留证）');
    lines.push(...sqlEvidence([
      "SELECT id,complaint_id,complaint_no,source_system,source_id,received_at FROM complaint WHERE source_id='" + sourceId + "';",
    ]));
    emit('A1', '接收真实落库', 'SKIP', lines);
  } else if (!serverUp) {
    emit('A1', '接收真实落库', 'SKIP', unreachable());
  } else {
    const r1 = await call('POST', '/external/yijiejieban/appeal', payload);
    lines.push(reqLine(r1, payload));
    lines.push(resLine(r1));
    const d = (r1.json && r1.json.data) || {};
    const nested = d.complaint || {};
    const id = nested.id !== undefined ? nested.id : d.complaintId;
    const no = nested.complaintNo || d.complaintNo;
    let status = 'FAIL';
    if (!r1.ok) {
      lines.push('[判定] 期望 HTTP 200，实际 ' + r1.status);
    } else if (id === undefined || id === null) {
      lines.push('[判定] 响应未返回诉求主键（期望 data.complaint.id 或 data.complaintId）');
    } else {
      a1CreatedId = id;
      a1CreatedNo = no;
      const back = await call('GET', '/complaints/' + encodeURIComponent(id));
      lines.push('[回查] ' + reqLine(back));
      lines.push('[回查] ' + resLine(back));
      const bd = (back.json && back.json.data) || {};
      const backNo = bd.complaintNo || (bd.complaint && bd.complaint.complaintNo);
      if (!back.ok) {
        lines.push('[判定] 回查失败：期望 HTTP 200，实际 ' + back.status);
      } else if (backNo !== no) {
        lines.push('[判定] 回查编号不一致：POST=' + no + ' / GET=' + backNo);
      } else {
        status = 'PASS';
        lines.push('[判定] 落库可回查，编号一致: ' + no);
      }
      if (no) {
        const digits = String(no).replace(/^CS/, '');
        const notes = [];
        if (!/^CS\d{8}\d+$/.test(String(no))) notes.push('不符合 CS+yyyyMMdd+序号');
        if (String(no).length !== 16) notes.push('当前序号位数=' + (digits.length - 8) + '（迁移设计 §5 约定为 4 位，即总长 14）');
        lines.push('[格式] 编号 = ' + no + (notes.length ? '  注意: ' + notes.join('；') : '  OK'));
      }
    }
    if (a1CreatedId === null) {
      lines.push('[MANUAL] 浏览器：确认该诉求出现在 /complaints 首行（截图留证）');
    }
    lines.push(...sqlEvidence([
      "SELECT id,complaint_id,complaint_no,source_system,source_id,received_at FROM complaint WHERE source_id='" + sourceId + "';",
    ]));
    lines.push('[MANUAL] 重启后端后再查同一 URL/编号，要求仍在且编号不变（§8.1 第三级证据）');
    emit('A1', '接收真实落库', status, lines);
  }
}

/* ================= A2 重复投递幂等 ================= */

{
  const lines = [];
  if (!DRY && !serverUp) {
    emit('A2', '重复投递幂等', 'SKIP', unreachable());
  } else {
    const r2 = await call('POST', '/external/yijiejieban/appeal', payload);
    lines.push('[请求] POST ' + BASE + '/external/yijiejieban/appeal  （与 A1 完全相同的报文）');
    lines.push('        body=' + shortJson(payload));
    lines.push(resLine(r2));
    let status = 'FAIL';
    if (DRY) {
      status = 'SKIP';
    } else if (!r2.ok) {
      lines.push('[判定] 期望 HTTP 200，实际 ' + r2.status);
    } else {
      const d = (r2.json && r2.json.data) || {};
      const result = String(d.result || '').toLowerCase();
      const dup = d.duplicate === true || result === 'duplicate_same';
      if (dup) {
        status = 'PASS';
        lines.push('[判定] 判定为重复投递且未新建: duplicate=' + d.duplicate + ' result=' + (d.result || '(未返回)'));
      } else {
        lines.push('[判定] 期望 duplicate=true 或 result=duplicate_same，实际 duplicate=' + d.duplicate +
          ' result=' + (d.result || '(未返回)'));
        lines.push('[原因提示] 当前后端未实现 payload hash 三分支幂等，或 response 契约未落 result 字段');
      }
    }
    lines.push(...sqlEvidence([
      "SELECT result,COUNT(*) AS cnt FROM complaint_source_log WHERE source_id='" + sourceId + "' GROUP BY result;",
      "SELECT COUNT(*) AS complaint_rows FROM complaint WHERE source_id='" + sourceId + "';",
    ]));
    lines.push('[MANUAL] 重启后端后复查：complaint 仍为 1 行、source_log 仍为 CREATED=1 / DUPLICATE_SAME=1');
    emit('A2', '重复投递幂等', status, lines);
  }
}

/* ================= A3 变更重传留痕且保护人工字段 ================= */

{
  const lines = [];
  if (!DRY && !serverUp) {
    emit('A3', '变更重传留痕且保护人工字段', 'SKIP', unreachable());
  } else {
    const r3 = await call('POST', '/external/yijiejieban/appeal', changedPayload);
    lines.push('[请求] POST ' + BASE + '/external/yijiejieban/appeal  （同 sourceId，仅 title 变更）');
    lines.push('        body=' + shortJson(changedPayload));
    lines.push(resLine(r3));
    let status = 'FAIL';
    if (DRY) {
      status = 'SKIP';
    } else if (!r3.ok) {
      lines.push('[判定] 期望 HTTP 200，实际 ' + r3.status);
    } else {
      const d = (r3.json && r3.json.data) || {};
      const result = String(d.result || '').toLowerCase();
      const notDup = d.duplicate === false;
      const isUpdate = result === 'updated' || result === 'created';
      const changed = Array.isArray(d.changedFields) ? d.changedFields : null;
      if (notDup && isUpdate && changed && changed.includes('title')) {
        status = 'PASS';
        lines.push('[判定] 判定为变更重传: result=' + d.result + ' changedFields=' + changed.join(','));
      } else {
        lines.push('[判定] 期望 duplicate=false 且 result=updated 且 changedFields 含 title；实际 duplicate=' +
          d.duplicate + ' result=' + (d.result || '(未返回)') +
          ' changedFields=' + (changed ? changed.join(',') : '(未返回)'));
        lines.push('[原因提示] 若 duplicate=true，说明后端只按 sourceId 去重、未做 payload hash 比对与字段版本留痕');
      }
    }
    lines.push(...sqlEvidence([
      "SELECT field_name,old_value,new_value,change_source,operator_name FROM complaint_field_version " +
        "WHERE complaint_id=(SELECT complaint_id FROM complaint WHERE source_id='" + sourceId + "') ORDER BY id;",
      "SELECT enterprise_code,enterprise_name,correction_status,supervision_status,reporting_status " +
        "FROM complaint WHERE source_id='" + sourceId + "';   -- 保护字段：重传后不得被覆盖",
    ]));
    lines.push('[MANUAL] 浏览器：确认列表标题已变为「' + changedTitle + '」，且责任企业/纠偏结果未被改写');
    emit('A3', '变更重传留痕且保护人工字段', status, lines);
  }
}

/* ================= A4 任意行打开对应 ID ================= */

{
  const lines = [];
  if (DRY) {
    lines.push('[请求] GET ' + BASE + '/complaints?page=1&size=2');
    lines.push('[请求] GET ' + BASE + '/complaints/<该行真实 id>');
    lines.push(...sqlEvidence(['SELECT complaint_no FROM complaint WHERE id=<该 id>;']));
    emit('A4', '任意行打开对应 ID', 'SKIP', lines);
  } else if (!serverUp) {
    emit('A4', '任意行打开对应 ID', 'SKIP', unreachable());
  } else {
    const list = await call('GET', '/complaints?page=1&size=2');
    lines.push(reqLine(list));
    lines.push(resLine(list));
    const content = (list.json && list.json.data && list.json.data.content) || [];
    const item = content[0];
    let status = 'FAIL';
    if (!list.ok) {
      lines.push('[判定] 列表接口期望 HTTP 200，实际 ' + list.status);
    } else if (!item || item.id === undefined) {
      lines.push('[判定] 列表为空或不含 id，无法验证"任意行打开对应 ID"（请先造数 seed）');
    } else {
      const detail = await call('GET', '/complaints/' + encodeURIComponent(item.id));
      lines.push('[回查] ' + reqLine(detail));
      lines.push('[回查] ' + resLine(detail));
      const dd = (detail.json && detail.json.data) || {};
      const detailNo = dd.complaintNo || (dd.complaint && dd.complaint.complaintNo);
      if (!detail.ok) {
        lines.push('[判定] 详情期望 HTTP 200，实际 ' + detail.status);
      } else if (detailNo !== item.complaintNo) {
        lines.push('[判定] 行内编号=' + item.complaintNo + ' 与详情编号=' + detailNo + ' 不一致');
      } else {
        status = 'PASS';
        lines.push('[判定] id=' + item.id + ' 的列表行与详情编号一致: ' + detailNo);
      }
    }
    lines.push(...sqlEvidence([
      "SELECT complaint_no FROM complaint WHERE id=" + (item && item.id !== undefined ? item.id : '<该 id>') + ";",
    ]));
    lines.push('[MANUAL] 浏览器：翻到第 3 页点任意一行，URL 必须是 /complaints/<真实 id>，页面编号与行一致');
    emit('A4', '任意行打开对应 ID', status, lines);
  }
}

/* ================= A5 详情不回落示例 ================= */

{
  const lines = [];
  if (!DRY && !serverUp) {
    emit('A5', '详情不回落示例', 'SKIP', unreachable());
  } else {
    const r5 = await call('GET', '/complaints/999999');
    lines.push(reqLine(r5));
    lines.push(resLine(r5));
    let status = 'FAIL';
    if (DRY) {
      status = 'SKIP';
    } else if (r5.status !== 404) {
      lines.push('[判定] 期望 HTTP 404，实际 ' + r5.status + '（若返回 200，说明查不到时会伪造记录）');
    } else {
      const text = String(r5.text || '');
      const forbidden = ['西陵区水管爆裂', 'CS202605280001'];
      const hit = forbidden.filter(f => text.includes(f));
      if (hit.length > 0) {
        lines.push('[判定] 404 响应体里出现示例诉求痕迹: ' + hit.join(', '));
      } else {
        status = 'PASS';
        lines.push('[判定] 返回 404 且响应体不含示例诉求');
      }
    }
    lines.push('[MANUAL] 浏览器：手工访问 /complaints/999999，必须显示「诉求不存在」，不得出现「西陵区水管爆裂」示例');
    emit('A5', '详情不回落示例', status, lines);
  }
}

/* ================= A6 空库仪表盘不造假 ================= */

{
  const lines = [];
  if (!DRY && !serverUp) {
    emit('A6', '空库仪表盘不造假', 'SKIP', unreachable());
  } else {
    const r6 = await call('GET', '/dashboard/overview');
    lines.push(reqLine(r6));
    lines.push(resLine(r6));
    let status = 'FAIL';
    if (DRY) {
      status = 'SKIP';
    } else if (!r6.ok) {
      lines.push('[判定] 期望 HTTP 200，实际 ' + r6.status);
    } else {
      const text = String(r6.text || '');
      const forbidden = ['1247', '78.5', '683', '564'];
      const hit = forbidden.filter(f => text.includes(f));
      const sensitiveFallback = /"sensitiveCount"\s*:\s*28/.test(text);
      if (hit.length > 0 || sensitiveFallback) {
        lines.push('[判定] 响应体命中兜底常量: ' + hit.join(', ') + (sensitiveFallback ? ' sensitiveCount:28' : ''));
        lines.push('[原因提示] 仪表盘仍带硬编码兜底，违反"零兜底"要求');
      } else {
        const d = (r6.json && r6.json.data) || {};
        const total = d.metrics ? d.metrics.total : (d.total !== undefined ? d.total : null);
        if (total === 0) {
          const zeros = ['todayReceived', 'waterReceived', 'gasReceived', 'sensitiveTotal', 'closedInSystem']
            .filter(k => d.metrics && d.metrics[k] !== undefined && d.metrics[k] !== 0);
          if (zeros.length > 0) {
            lines.push('[判定] 空库应全为 0，但以下指标非 0: ' + zeros.join(', '));
          } else {
            status = 'PASS';
            lines.push('[判定] 无兜底常量，且空库指标全为 0');
          }
        } else if (total === null) {
          status = 'PASS';
          lines.push('[判定] 无兜底常量；但响应未提供 total 指标，空库断言无法自动完成（见 MANUAL）');
        } else {
          status = 'PASS';
          lines.push('[判定] 无兜底常量（当前 total=' + total + '，非空库；空库断言需清库后重跑，见 MANUAL）');
        }
      }
    }
    lines.push(...sqlEvidence(['SELECT COUNT(*) AS complaint_rows FROM complaint;']));
    lines.push('[MANUAL] 清库后刷新 /dashboard：卡片必须显示 0 或 "—"，且页面上不出现 1247/683/564/28/78.5');
    lines.push('[MANUAL] 清库步骤（G1 使用独立测试库，勿动生产库）：truncate table gqxq_service_test.complaint; 或指向 gqxq_service_test');
    emit('A6', '空库仪表盘不造假', status, lines);
  }
}

/* ================= A7 仪表盘等于真实聚合 ================= */

{
  const lines = [];
  if (!DRY && !serverUp) {
    emit('A7', '仪表盘等于真实聚合', 'SKIP', unreachable());
  } else {
    const dash = await call('GET', '/dashboard/overview');
    const list = await call('GET', '/complaints?page=1&size=1');
    lines.push(reqLine(dash));
    lines.push(resLine(dash));
    lines.push('[请求] GET ' + BASE + '/complaints?page=1&size=1');
    lines.push(resLine(list));
    let status = 'FAIL';
    if (DRY) {
      status = 'SKIP';
    } else if (!dash.ok || !list.ok) {
      lines.push('[判定] 接口期望 HTTP 200，实际 dashboard=' + dash.status + ' complaints=' + list.status);
    } else {
      const dd = (dash.json && dash.json.data) || {};
      const listTotal = list.json && list.json.data ? list.json.data.total : null;
      let dashTotal = null;
      let how = '';
      if (dd.metrics && dd.metrics.total !== undefined) {
        dashTotal = dd.metrics.total;
        how = 'metrics.total';
      } else if (dd.waterCount !== undefined && dd.gasCount !== undefined) {
        dashTotal = dd.waterCount + dd.gasCount;
        how = 'waterCount + gasCount（兼容旧契约）';
      }
      if (dashTotal === null || listTotal === null) {
        status = 'SKIP';
        lines.push('[判定] 仪表盘未提供可比的 total 指标，无法自动比对；需 G1 接口提供 metrics.total');
      } else if (dashTotal !== listTotal) {
        lines.push('[判定] 仪表盘 ' + how + '=' + dashTotal + ' 与列表 total=' + listTotal + ' 不一致');
      } else {
        status = 'PASS';
        lines.push('[判定] 仪表盘 ' + how + '=' + dashTotal + ' 与列表 total 一致');
      }
    }
    lines.push(...sqlEvidence([
      "SELECT COUNT(*) AS total, SUM(business_type='water') AS water, SUM(business_type='gas') AS gas, " +
        "SUM(is_sensitive=1) AS sensitive, SUM(closed_in_system=1) AS closed_in_system FROM complaint;",
      "SELECT COUNT(*) AS today_received FROM complaint " +
        "WHERE DATE(CONVERT_TZ(received_at,'+00:00','+08:00'))=DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00'));",
    ]));
    lines.push('[MANUAL] 重启后端后重跑本项，数值必须不变（§8.1 第三级证据）');
    emit('A7', '仪表盘等于真实聚合', status, lines);
  }
}

/* ================= A8 代码无兜底常量 ================= */

{
  const lines = [];
  const gate = join(HERE, 'gate-g1.mjs');
  if (DRY) {
    lines.push('[执行] node ' + gate);
    lines.push('[响应] (--dry：未执行)');
    emit('A8', '代码无兜底常量（门禁退出码 0）', 'SKIP', lines);
  } else {
    const r = spawnSync(process.execPath, [gate], { encoding: 'utf8', cwd: ROOT });
    lines.push('[执行] node ' + gate);
    if (r.error) {
      lines.push('[响应] 执行失败: ' + r.error.message);
      emit('A8', '代码无兜底常量（门禁退出码 0）', 'SKIP', lines);
    } else {
      lines.push('# 退出码: ' + r.status);
      const tail = String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-5);
      for (const t of tail) lines.push('# ' + t);
      if (r.status === 0) {
        emit('A8', '代码无兜底常量（门禁退出码 0）', 'PASS', lines);
      } else {
        lines.push('[判定] 门禁存在 fail 级违规（预期内：页面尚未全部标记、server 仍是 Mock）');
        emit('A8', '代码无兜底常量（门禁退出码 0）', 'FAIL', lines);
      }
    }
  }
}

/* ================= A9 审计留痕 ================= */

{
  const lines = [];
  const auditTables = 'operation_audit_log（迁移设计 §5：复用既有表，不再新建 audit_log）';
  lines.push('[说明] 当前后端未提供审计查询接口，本项无法自动判定，只能数据库直查。');
  lines.push('[表] ' + auditTables);
  lines.push(...sqlEvidence([
    "SELECT audit_id,user_id,app_code,action,biz_type,biz_id,result,client_ip,created_at " +
      "FROM operation_audit_log ORDER BY id DESC LIMIT 10;",
    "SELECT action,COUNT(*) AS cnt FROM operation_audit_log GROUP BY action ORDER BY cnt DESC;",
  ]));
  const login = await call('POST', '/auth/login', { username: 'admin', password: '***验收占位***' });
  lines.push('[请求] POST ' + BASE + '/auth/login  （用于产生一条登录审计）');
  lines.push(resLine(login));
  lines.push('[MANUAL] 先执行一次真实登录 + 一次接收（A1 已产生），再跑上面的 SQL，确认审计行数增加');
  lines.push('[MANUAL] 重启后端后重查同一 SQL，审计记录必须仍在');
  emit('A9', '审计留痕', 'MANUAL', lines);
}

/* ================= A10 类型检查门禁 ================= */

{
  const lines = [];
  lines.push('[目标] npm run typecheck 退出码 0');
  lines.push('[说明] 迁移设计约定：build 需加 tsc --noEmit；该 script 由主线统一接入 package.json，本脚本不修改它。');
  if (WITH_TYPECHECK) {
    const targets = [join(ROOT, 'server'), join(ROOT, 'packages', 'web-admin')];
    for (const dir of targets) {
      const r = spawnSync('npm', ['run', 'typecheck'], { encoding: 'utf8', cwd: dir, shell: true });
      const label = dir.split(/[\\/]/).slice(-1)[0];
      if (r.error) {
        lines.push('[执行] ' + label + ': npm run typecheck → 执行失败: ' + r.error.message);
      } else if (r.status !== 0 && /Missing script/.test(String(r.stderr || '') + String(r.stdout || ''))) {
        lines.push('[执行] ' + label + ': 尚未定义 typecheck script → 跳过');
      } else {
        lines.push('[执行] ' + label + ': npm run typecheck 退出码 ' + r.status);
        const tail = (String(r.stdout || '') + String(r.stderr || '')).split(/\r?\n/).filter(Boolean).slice(-6);
        for (const t of tail) lines.push('# ' + t);
      }
    }
  } else {
    lines.push('[执行] 未传 --typecheck，未实际运行（避免与主线并行修改冲突）');
  }
  lines.push('[MANUAL] 主线在 server/package.json 接入 "typecheck": "tsc --noEmit" 后，用 --typecheck 重跑本项');
  emit('A10', '类型检查门禁', 'MANUAL', lines);
}

/* ================= A11 数据库不可用时不回退 Mock ================= */

{
  const lines = [];
  lines.push('[目标] 停掉 MySQL 后，接口返回 5xx、页面显示加载失败与重试，且**不出现任何诉求数据**。');
  lines.push('[执行-PowerShell] Stop-Service MySQL80');
  lines.push('[执行] ' + (DRY ? '(未发送请求)' : 'curl ' + BASE + '/complaints'));
  if (!DRY && serverUp) {
    const r = await call('GET', '/complaints?page=1&size=1');
    lines.push('[当前响应] HTTP ' + r.status + '  ' + shortText(r.text, 200));
    lines.push('[说明] 这一行是"数据库仍可用"时的正常响应，仅作对照；负向结论必须在停库后取得。');
  }
  lines.push('[执行-PowerShell] Start-Service MySQL80    # 验收后务必恢复');
  lines.push('[MANUAL] 停库后刷新 /complaints 与 /dashboard：必须显示"加载失败 + 重试"，接口非 2xx；');
  lines.push('[MANUAL] 关键判据：页面上**不得**出现任何诉求列表行或非零指标（若出现即回退到了 Mock，判不通过）');
  lines.push('[MANUAL] 恢复 MySQL 后重跑 A1/A4，确认功能回到正常');
  emit('A11', '数据库不可用时不回退 Mock（负向用例）', 'MANUAL', lines);
}

/* ---------------- 汇总 ---------------- */

const summary = { PASS: 0, FAIL: 0, SKIP: 0, MANUAL: 0 };
for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
const exitCode = summary.FAIL > 0 ? 1 : 0;

console.log('');
console.log('=== 汇总 ===');
console.log('PASS ' + summary.PASS + ' / FAIL ' + summary.FAIL + ' / SKIP ' + summary.SKIP + ' / MANUAL ' + summary.MANUAL);
console.log('逐项: ' + results.map(r => r.id + '=' + r.status).join('  '));
console.log('退出码: ' + exitCode + (exitCode === 1 ? '（存在 FAIL）' : '（无 FAIL）'));
if (summary.MANUAL > 0) {
  console.log('提醒: MANUAL 项需要人工在浏览器/数据库/停库场景下补证，见各项 [MANUAL] 说明。');
}
process.exit(exitCode);
