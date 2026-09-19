#!/usr/bin/env node
/**
 * G6 来源适配器**契约测试**。
 *
 * 与 acceptance-gN.mjs 的区别：那些是端到端验收，这个是"契约与安全不变量"的检查。
 * 它不依赖真实宜接就办接口（那个还没提供），而是钉住三件必须永远成立的事：
 *
 *   一、契约本身可满足：用内存假适配器实现契约，证明接口自洽（真实实现照此写即可）。
 *   二、状态映射不猜：认不出来的来源状态必须返回 null，绝不能映射成某个已知状态。
 *       G6-6 另钉「时效轴」（M11 的 overtime_flag）同样不猜：来源没说超期与否的必须仍是 NULL。
 *   三、安全不变量（本批次最重要）：
 *         * 开关关闭时调用即报未实现，不返回任何来源状态；
 *         * 配置成未知适配器时不构造假适配器，而是回报配置无效；
 *         * 无论成功失败，不得改动 reporting_status（填报结果）与 closed_*（本系统办结）——
 *           因此同步 SQL 只允许写 source_event_status / overtime_flag / source_synced_at 三列，
 *           这一条直接扫源码按**精确允许集合**断言。
 *
 * 用法：
 *   cd server && npm run build
 *   node scripts/verify-source-adapter.mjs                      # 静态与纯函数检查，不连库
 *   GQXQ_BASE=http://localhost:33xx/api/v1 GQXQ_LOGIN_PASSWORD=*** \
 *     node scripts/verify-source-adapter.mjs --http             # 追加真实 HTTP 栈检查
 *     （注意：G6-5 断言"开关关闭时同步被拒"，要求被测服务以 GQXQ_YJJB_ADAPTER=disabled 运行；
 *       若服务配成 file，该项会如实标 MANUAL 而不是 FAIL。）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');
const BASE = (process.env.GQXQ_BASE || 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const WITH_HTTP = process.argv.includes('--http');

const results = [];
function emit(id, title, status, lines) {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 44 - title.length)));
  console.log('  状态: ' + status);
  for (const l of lines || []) console.log('  ' + l);
}

async function checkMapping() {
  // Windows 上必须用 file:// URL：直接 import('D:\\...') 会被当成协议名
  const mod = await import(pathToFileURL(join(SERVER_ROOT, 'dist/domain/sourceAdapter.js')).href).catch(() => null);
  if (mod === null) {
    emit('G6-1', '状态映射不猜（认不出来返回 null）', 'FAIL', ['无法加载 dist/domain/sourceAdapter.js，请先在 server/ 执行 npm run build']);
    return;
  }
  const cases = [
    ['ACCEPTED', 'accepted'],
    ['processing', 'processing'],
    [' completed ', 'completed'],
    ['CLOSED', 'closed'],
    ['某来源特有的状态', null],
    ['UNKNOWN_XYZ', null],
    ['', null],
  ];
  const wrong = [];
  for (const pair of cases) {
    const input = pair[0];
    const expected = pair[1];
    const got = mod.mapSourceStatus(input);
    if (got !== expected) {
      wrong.push(JSON.stringify(input) + ' -> ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(expected) + '）');
    }
  }
  emit('G6-1', '状态映射不猜（认不出来返回 null）', wrong.length === 0 ? 'PASS' : 'FAIL', [
    '共 ' + cases.length + ' 个用例：认不出的输入必须返回 null，不得猜成某个已知状态',
    wrong.length > 0 ? '不符: ' + wrong.join('; ') : '全部符合：已知状态正确映射，未知状态一律 null（调用方保留原状态并留痕）',
  ]);

  // G6-6：超期是**时效**维度（M11 的 complaint.overtime_flag），与状态轴并行。
  // 判据的关键不是"1 有没有映射上"，而是**来源没说的必须仍是 null**：
  // 把「正常在办」或英文 COMPLETED 猜成 0，等于替来源撒一句"这批件没超期"。
  const overtimeCases = [
    ['正常在办', 'processing', null],
    ['正常结案', 'completed', 0],
    ['超期结案', 'completed', 1],
    ['COMPLETED', 'completed', null],
    ['ACCEPTED', 'accepted', null],
    ['某来源特有的状态', null, null],
    ['', null, null],
  ];
  const overtimeWrong = [];
  for (const [input, wantCode, wantOvertime] of overtimeCases) {
    const got = mod.mapSourceStatusDetail(input);
    const gotCode = got === null ? null : got.code;
    const gotOvertime = got === null ? null : got.overtimeFlag;
    if (gotCode !== wantCode || gotOvertime !== wantOvertime) {
      overtimeWrong.push(
        JSON.stringify(input) + ' -> ' + JSON.stringify(got) +
          '（期望 code=' + JSON.stringify(wantCode) + ' overtime=' + JSON.stringify(wantOvertime) + '）'
      );
    }
  }
  const overtimeOk = mod.mapSourceStatus('超期结案') === 'completed' &&
    mod.mapSourceStatusDetail('超期结案').overtimeFlag === 1;
  emit('G6-6', '时效映射三态（来源没说的一律 NULL，不压成 0）', overtimeWrong.length === 0 && overtimeOk ? 'PASS' : 'FAIL', [
    '共 ' + overtimeCases.length + ' 个用例：状态轴 + 时效轴二元组必须同时正确',
    '「超期结案」必须是 (completed, 1) 且旧签名 mapSourceStatus 仍返回 completed（G6 契约不破坏）-> ' + overtimeOk,
    overtimeWrong.length > 0 ? '不符: ' + overtimeWrong.join('; ') : '全部符合；未列出的取值整体返回 null，两轴都保留原值',
  ]);

  const fake = {
    name: 'in-memory-fake',
    enabled: true,
    async fetchBySourceId(sourceId) {
      return { sourceId, rawStatus: 'ACCEPTED', updatedAt: '2026-09-17T00:00:00.000Z', raw: { sourceId } };
    },
  };
  const snap = await fake.fetchBySourceId('YJJB202609140001');
  const okSnap = snap.sourceId === 'YJJB202609140001' && mod.mapSourceStatus(snap.rawStatus) === 'accepted';
  emit('G6-2', '契约可满足（真实实现照此写即可）', okSnap ? 'PASS' : 'FAIL', [
    '内存假适配器实现 SourceStatusAdapter 的 name / enabled / fetchBySourceId',
    '断言：返回的 sourceId 与请求一致，且 rawStatus 可映射为 accepted -> ' + String(okSnap),
  ]);
}

function checkWriteScope() {
  const file = join(SERVER_ROOT, 'src/repositories/sourceSyncRepo.ts');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    emit('G6-3', '同步 SQL 只允许写来源状态三列', 'FAIL', ['读不到 ' + file + ': ' + String(err)]);
    return;
  }
  const m = /update\s+complaint\s+set([\s\S]*?)where/i.exec(text);
  const setClause = m ? m[1] : '';
  // **精确允许集合**（不是"不含禁用列即通过"）：新增列必须显式在这里登记，
  // 这样"顺手在同一条 UPDATE 里多写一列"一定会被拦下。
  // overtime_flag 是 M11 的超期时效派生列，与 source_event_status 共用同一条单写者路径。
  const ALLOWED = ['source_event_status', 'overtime_flag', 'source_synced_at'];
  const assigned = [...setClause.matchAll(/([a-z_][a-z0-9_]*)\s*=/gi)].map((x) => x[1].toLowerCase());
  const leaked = assigned.filter((col) => !ALLOWED.includes(col));
  const missing = ALLOWED.filter((col) => !assigned.includes(col));
  const duplicated = assigned.filter((col, i) => assigned.indexOf(col) !== i);
  const pass = setClause !== '' && leaked.length === 0 && missing.length === 0 && duplicated.length === 0;
  emit('G6-3', '同步 SQL 只允许写来源状态三列', pass ? 'PASS' : 'FAIL', [
    '扫源码 ' + file + ' 里 update complaint 的 SET 子句：',
    '  SET' + setClause.replace(/\s+/g, ' ').trim(),
    '解析出的赋值列: ' + JSON.stringify(assigned),
    '精确允许集合: ' + JSON.stringify(ALLOWED) + '（超出即失败；缺列同样失败，防止窄接口被改窄后静默降级）',
    leaked.length > 0 ? '越界列: ' + leaked.join(', ') : '未发现越界列',
    missing.length > 0 ? '缺少必需列: ' + missing.join(', ') : '三个必需列齐备',
    duplicated.length > 0 ? '重复赋值列: ' + duplicated.join(', ') : '无重复赋值',
    '说明：这条是 G6 的核心不变量——来源适配器无论成功失败，都不得改动填报结果与本系统办结状态；',
    '      来源侧只允许 source_event_status + overtime_flag（时效派生）+ source_synced_at（时间戳）三列。',
  ]);
}

async function checkDisabledSwitch() {
  // 本项检查的是"开关关闭"这个**特定状态**，因此必须自己固定前置条件。
  // 环境里可能配着 file（读来源快照，见 adapters/fileSourceAdapter.ts）以便联调，
  // 此时适配器本来就是"开"的；不固定这一行就会把"开着的适配器正常返回状态"
  // 误判成"关闭时返回了状态"——那是拿环境差异当缺陷。
  // dotenv 不覆盖已存在的 process.env，所以在 import 之前设置即可生效。
  process.env.GQXQ_YJJB_ADAPTER = 'disabled';
  const mod = await import(pathToFileURL(join(SERVER_ROOT, 'dist/adapters/index.js')).href).catch(() => null);
  if (mod === null) {
    emit('G6-4', '开关关闭时不返回任何来源状态', 'FAIL', ['无法加载 dist/adapters/index.js，请先 npm run build']);
    return;
  }
  const resolved = mod.resolveSourceAdapter();
  let threw = false;
  let returned = null;
  try {
    returned = await resolved.adapter.fetchBySourceId('YJJB202609140001');
  } catch {
    threw = true;
  }
  const pass = resolved.adapter.enabled === false && threw && returned === null;
  emit('G6-4', '开关关闭时不返回任何来源状态', pass ? 'PASS' : 'FAIL', [
    '默认配置解析: adapter=' + resolved.adapter.name + ' enabled=' + resolved.adapter.enabled + ' misconfigured=' + resolved.misconfigured,
    '调用 fetchBySourceId -> ' + (threw ? '抛错（正确）' : '返回了 ' + JSON.stringify(returned) + '（错误：不该返回任何状态）'),
    '判据：关闭时宁可明确报未实现，也不能返回看似正常的模拟状态。',
  ]);
}

async function checkHttp() {
  if (!WITH_HTTP) {
    emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', 'MANUAL', [
      '未传 --http。用法：GQXQ_BASE=... GQXQ_LOGIN_PASSWORD=*** node server/scripts/verify-source-adapter.mjs --http',
      '该项会断言：适配器关闭时 POST /complaints/:idOrNo/source-sync 返回 501，',
      '且该诉求的 source_event_status / reporting_status / closed_in_system 三者前后完全一致，并写下一条 sync_log。',
    ]);
    return;
  }
  const username = process.env.GQXQ_LOGIN_USERNAME || 'admin';
  const password = process.env.GQXQ_LOGIN_PASSWORD || '';
  if (password === '') {
    emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', 'FAIL', ['未设置 GQXQ_LOGIN_PASSWORD']);
    return;
  }
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, password: password }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const token = login && login.data && login.data.token;
  if (!token) {
    emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', 'FAIL', ['登录失败: ' + JSON.stringify(login).slice(0, 200)]);
    return;
  }
  const headers = { Authorization: 'Bearer ' + token };
  const list = await fetch(BASE + '/complaints?size=1', { headers }).then((r) => r.json());
  const target = list && list.data && list.data.content && list.data.content[0];
  if (!target) {
    emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', 'FAIL', ['列表为空，无法取样本诉求']);
    return;
  }
  const state = await fetch(BASE + '/source-status', { headers }).then((r) => r.json());
  // 前置条件：本项断言的是"开关关闭时同步被拒"。服务端的配置来自环境，脚本改不动——
  // 若当前配成 file，适配器是开的，同步会成功而不是 501。
  // 此时如实标 MANUAL 并说清原因，而不是报一个假 FAIL。
  if (state && state.data && state.data.enabled === true) {
    emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', 'MANUAL', [
      'GET /source-status: ' + JSON.stringify(state.data),
      '当前服务的来源适配器是【启用】状态，而本项要求开关关闭（GQXQ_YJJB_ADAPTER=disabled）。',
      '请在 disabled 配置下重启服务后重跑：cd server && $env:GQXQ_YJJB_ADAPTER="disabled"; node dist/index.js',
      '适配器启用时的正向同步路径由 scripts/verify-file-source-adapter.ts 覆盖（tsx 直跑 src）。',
    ]);
    return;
  }
  const syncRes = await fetch(BASE + '/complaints/' + encodeURIComponent(target.id) + '/source-sync', { method: 'POST', headers: headers });
  const syncBody = await syncRes.json().catch(() => ({}));
  const after = await fetch(BASE + '/complaints/' + encodeURIComponent(target.id), { headers: headers }).then((r) => r.json());
  const a = after && after.data ? after.data : {};
  const pass =
    syncRes.status === 501 &&
    a.sourceEventStatusCode === target.sourceEventStatusCode &&
    a.reportingStatusCode === target.reportingStatusCode &&
    a.closedInSystem === target.closedInSystem;
  emit('G6-5', 'HTTP 栈：同步被拒且业务状态不变', pass ? 'PASS' : 'FAIL', [
    'GET /source-status: ' + JSON.stringify(state.data),
    'POST /complaints/' + target.id + '/source-sync -> HTTP ' + syncRes.status + ' ' + JSON.stringify(syncBody).slice(0, 220),
    '同步前后（必须完全一致）: source_event_status ' + target.sourceEventStatusCode + ' -> ' + a.sourceEventStatusCode +
      '；reporting_status ' + target.reportingStatusCode + ' -> ' + a.reportingStatusCode +
      '；closed_in_system ' + target.closedInSystem + ' -> ' + a.closedInSystem,
    '[SQL] SELECT result, error_message FROM sync_log WHERE biz_id = ' + JSON.stringify(target.complaintId) + ' ORDER BY id DESC LIMIT 1;',
  ]);
}

async function main() {
  console.log('=== G6 来源适配器契约测试 verify-source-adapter.mjs ===');
  console.log('HTTP 模式: ' + (WITH_HTTP ? '开（' + BASE + '）' : '关'));
  await checkMapping();
  checkWriteScope();
  await checkDisabledSwitch();
  await checkHttp();
  const auto = results.filter((r) => r.status !== 'MANUAL');
  const failed = auto.filter((r) => r.status === 'FAIL');
  console.log('');
  console.log('=== 汇总 ===');
  console.log('PASS ' + auto.filter((r) => r.status === 'PASS').length + ' / FAIL ' + failed.length + ' / MANUAL ' + results.filter((r) => r.status === 'MANUAL').length);
  console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('执行失败: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
