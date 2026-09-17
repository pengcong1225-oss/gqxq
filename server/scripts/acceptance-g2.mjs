#!/usr/bin/env node
/**
 * G2 验收矩阵执行器 —— 分配与分流。
 *
 * 对应《2026-09-17-诉求平台落地计划.md》G2 的四项验收：
 *   ① 误报归库不产生任务
 *   ② 并发/重复点击同诉求只生成一条交办（DB 唯一约束兜底）
 *   ③ 同一交办两次查询状态一致
 *   ④ 重启后交办列表不变（需人工跨重启比对，见 --snapshot）
 *
 * 用法：
 *   GQXQ_BASE=http://localhost:3313/api/v1 GQXQ_LOGIN_PASSWORD=*** node server/scripts/acceptance-g2.mjs
 *   node server/scripts/acceptance-g2.mjs --snapshot      # 只打印交办列表快照，供重启前后对比
 *   node server/scripts/acceptance-g2.mjs --dry           # 不发任何请求
 *
 * 说明：本脚本会在目标库新建诉求（sourceId 前缀 ACCG2），请指向测试库 gqxq_service_test 运行。
 */

const BASE = (process.env.GQXQ_BASE || 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const DRY = process.argv.includes('--dry');
const SNAPSHOT_ONLY = process.argv.includes('--snapshot');
const DB_NAME = process.env.GQXQ_DB_NAME || 'gqxq_service';

let authToken = null;
const results = [];

function shortJson(v, max) {
  try {
    const t = JSON.stringify(v);
    return t && t.length > (max || 240) ? t.slice(0, max || 240) + ' …' : String(t);
  } catch {
    return '<unserializable>';
  }
}

function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 46 - title.length)));
  console.log('  状态: ' + status);
  for (const l of lines || []) console.log('  ' + l);
}

async function call(method, path, body) {
  if (DRY) return { dry: true, status: 0 };
  const init = { method, headers: {} };
  if (authToken && path !== '/auth/login') init.headers.Authorization = 'Bearer ' + authToken;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function login() {
  if (DRY) return;
  const username = process.env.GQXQ_LOGIN_USERNAME || 'admin';
  const password = process.env.GQXQ_LOGIN_PASSWORD || '';
  if (!password) {
    console.log('[鉴权] 未设置 GQXQ_LOGIN_PASSWORD，受保护接口会 401。');
    return;
  }
  const res = await call('POST', '/auth/login', { username, password });
  const token = res && res.json && res.json.data && res.json.data.token;
  if (res && res.status === 200 && token) {
    authToken = token;
    console.log('[鉴权] 已登录 ' + username);
  } else {
    console.log('[鉴权] 登录失败 HTTP ' + (res && res.status) + ' ' + shortJson(res && res.json));
  }
}

/** 通过入站接口新建一条诉求，保证它一定没有交办 */
async function createComplaint(tag, opts) {
  const sourceId = 'ACCG2' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const body = {
    sourceId,
    title: '[G2验收] ' + (opts && opts.title ? opts.title : tag),
    content: opts && opts.content ? opts.content : 'G2 验收用例。',
    source: 'G2验收',
    districtName: '西陵区',
  };
  const res = await call('POST', '/external/yijiejieban/appeal', body);
  const data = res && res.json && res.json.data;
  return {
    sourceId,
    res,
    complaintId: data ? data.complaintId : null,
    complaintNo: data ? data.complaintNo : null,
  };
}

async function main() {
  console.log('=== G2 验收矩阵执行器 acceptance-g2.mjs ===');
  console.log('接口基址: ' + BASE + (DRY ? '   (--dry)' : ''));
  console.log('目标库(仅用于打印清理 SQL): ' + DB_NAME);

  await login();
  if (!authToken && !DRY) {
    console.log('[中止] 未取得令牌，受保护接口都会 401。');
    process.exitCode = 1;
    return;
  }

  /* ---------- ② 先做并发，拿到一条交办供 ③ 与 ④ 使用 ---------- */
  const c2 = await createComplaint('CONC', { title: '并发创建交办' });
  const body2 = {
    complaintId: c2.complaintId,
    targetEnterpriseCode: 'ENT-WATER-001',
    targetEnterpriseName: '宜昌市供水总公司',
    reason: 'G2验收-并发',
    requirement: '请核实并填报处置结果。',
    deadline: new Date(Date.now() + 3 * 86400000).toISOString(),
    dispatchType: 'manual',
    triggerType: 'manual_flag',
  };
  const concurrent = await Promise.all(
    [0, 1, 2, 3, 4, 5].map(() => call('POST', '/dispatch/orders', body2))
  );
  const okCount = concurrent.filter((r) => r.status === 200).length;
  const createdTrue = concurrent.filter((r) => r.json && r.json.data && r.json.data.created === true).length;
  const ids = Array.from(
    new Set(concurrent.map((r) => (r.json && r.json.data && r.json.data.order ? r.json.data.order.assignmentId : null)).filter(Boolean))
  );
  const list2 = await call('GET', '/dispatch/orders?complaintId=' + encodeURIComponent(c2.complaintId));
  const total2 = list2.json && list2.json.data ? list2.json.data.total : null;
  const pass2 = okCount === 6 && createdTrue === 1 && ids.length === 1 && total2 === 1;
  emit('G2-②', '并发/重复点击只生成一条交办', pass2 ? 'PASS' : 'FAIL', [
    '诉求 ' + c2.complaintId + ' 并发 6 路 POST /dispatch/orders',
    'HTTP200=' + okCount + '/6  created=true 的路数=' + createdTrue + '（应为 1）',
    '返回的 assignmentId 去重后个数=' + ids.length + '（应为 1）：' + ids.join(','),
    'GET /dispatch/orders?complaintId= 的 total=' + total2 + '（应为 1）',
    '[SQL] SELECT count(*) FROM dispatch_order WHERE complaint_id=\'' + c2.complaintId + '\';',
    '判据：唯一性由 uk_active_dispatch 生成列唯一键裁决，不是应用层先查后插。',
  ]);

  const assignmentId = ids[0] || null;

  /* ---------- ③ 同一交办两次查询状态一致 ---------- */
  const a1 = await call('GET', '/dispatch/orders/' + assignmentId);
  const a2 = await call('GET', '/dispatch/orders/' + assignmentId);
  const d1 = a1.json && a1.json.data;
  const d2 = a2.json && a2.json.data;
  const same =
    !!d1 && !!d2 &&
    d1.status === d2.status &&
    d1.orderNo === d2.orderNo &&
    d1.assignmentId === d2.assignmentId &&
    d1.requestId === d2.requestId;
  emit('G2-③', '同一交办两次查询状态一致', same ? 'PASS' : 'FAIL', [
    'GET /dispatch/orders/' + assignmentId + ' 两次',
    '第一次: status=' + (d1 && d1.status) + ' orderNo=' + (d1 && d1.orderNo) + ' requestId=' + (d1 && d1.requestId),
    '第二次: status=' + (d2 && d2.status) + ' orderNo=' + (d2 && d2.orderNo) + ' requestId=' + (d2 && d2.requestId),
    '判据：同一记录两次查询必须返回相同状态，不得现场随机生成。',
  ]);

  /* ---------- ① 误报归库不产生任务 ---------- */
  const c1 = await createComplaint('FALSEPOS', {
    title: '误报归库-爆管大面积停水',
    content: '标题含敏感词用于验证误报归库：爆管、大面积停水。',
  });
  const before = await call('GET', '/complaints/' + encodeURIComponent(c1.complaintId));
  const sensitiveBefore = before.json && before.json.data ? before.json.data.isSensitive : null;
  const disp = await call('POST', '/complaints/' + encodeURIComponent(c1.complaintId) + '/disposition', {
    disposition: 'false_positive',
    reason: 'G2验收-人工判定为误报',
  });
  const after = await call('GET', '/complaints/' + encodeURIComponent(c1.complaintId));
  const sensitiveAfter = after.json && after.json.data ? after.json.data.isSensitive : null;
  const list1 = await call('GET', '/dispatch/orders?complaintId=' + encodeURIComponent(c1.complaintId));
  const total1 = list1.json && list1.json.data ? list1.json.data.total : null;
  const pass1 =
    disp.status === 200 &&
    total1 === 0 &&
    sensitiveBefore === true &&
    sensitiveAfter === true;
  emit('G2-①', '误报归库不产生任务', pass1 ? 'PASS' : 'FAIL', [
    '诉求 ' + c1.complaintId + '（标题/content 含敏感词，落库后 isSensitive=' + sensitiveBefore + '）',
    'POST /complaints/:id/disposition {disposition:false_positive} -> HTTP ' + disp.status,
    '响应: ' + shortJson(disp.json && disp.json.data),
    '归库后 GET /dispatch/orders?complaintId= 的 total=' + total1 + '（应为 0 —— 这是核心判据）',
    'is_sensitive 归库前后 = ' + sensitiveBefore + ' / ' + sensitiveAfter + '（应保持 true，误报判定只记在 complaint_disposition）',
    '[SQL] SELECT disposition, is_sensitive_before, reason FROM complaint_disposition WHERE complaint_id=\'' + c1.complaintId + '\';',
    '[SQL] SELECT count(*) FROM dispatch_order WHERE complaint_id=\'' + c1.complaintId + '\';',
  ]);

  /* ---------- ④ 重启后列表不变 ---------- */
  const snap = await call('GET', '/dispatch/orders?size=100');
  const snapIds = snap.json && snap.json.data ? snap.json.data.content.map((x) => x.assignmentId).sort() : [];
  emit('G2-④', '重启后交办列表不变', 'MANUAL', [
    '快照 total=' + (snap.json && snap.json.data ? snap.json.data.total : '?') + '，assignmentId 共 ' + snapIds.length + ' 个',
    'G2_SNAPSHOT total=' + (snap.json && snap.json.data ? snap.json.data.total : '?') + ' ids=' + snapIds.join(','),
    '做法：记录上面这行 -> 重启后端 -> 再跑一次本脚本（或 --snapshot）-> 比对 total 与 ids 完全一致。',
    '[SQL] SELECT assignment_id, status FROM dispatch_order ORDER BY assignment_id;',
  ]);

  /* ---------- 清理 SQL ---------- */
  console.log('');
  console.log('=== 本脚本新建的数据（请指向测试库时自行清理）===');
  console.log('[SQL] DELETE FROM dispatch_order WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG2%\');');
  console.log('[SQL] DELETE FROM complaint_field_version WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG2%\');');
  console.log('[SQL] DELETE FROM complaint_disposition WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG2%\');');
  console.log('[SQL] DELETE FROM complaint_assignment WHERE complaint_id IN (SELECT complaint_id FROM complaint WHERE source_id LIKE \'ACCG2%\');');
  console.log('[SQL] DELETE FROM complaint_source_log WHERE source_id LIKE \'ACCG2%\';');
  console.log('[SQL] DELETE FROM complaint WHERE source_id LIKE \'ACCG2%\';');

  const auto = results.filter((r) => r.status !== 'MANUAL');
  const failed = auto.filter((r) => r.status === 'FAIL');
  console.log('');
  console.log('=== 汇总 ===');
  console.log('PASS ' + auto.filter((r) => r.status === 'PASS').length +
    ' / FAIL ' + failed.length +
    ' / MANUAL ' + results.filter((r) => r.status === 'MANUAL').length);
  console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function snapshotOnly() {
  await login();
  const snap = await call('GET', '/dispatch/orders?size=100');
  const data = snap.json && snap.json.data;
  const ids = data ? data.content.map((x) => x.assignmentId).sort() : [];
  console.log('G2_SNAPSHOT total=' + (data ? data.total : '?') + ' ids=' + ids.join(','));
}

(DRY || SNAPSHOT_ONLY ? (SNAPSHOT_ONLY ? snapshotOnly() : Promise.resolve()) : main()).catch((err) => {
  console.error('执行失败: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
