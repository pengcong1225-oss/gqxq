#!/usr/bin/env node
/**
 * G6 来源适配器「file 形态」契约与不变量验证。
 *
 * 为什么不扩写 verify-source-adapter.mjs：那个脚本从 dist/ 加载编译产物，
 * 而本次改动**不允许 npm run build**（并行改动期间构建会把半成品 dist 编进去，
 * 之后别人重启就会跑一份坏产物）。本脚本用 tsx 直接加载 src/，不需要构建，
 * 因此改完就能立刻验证。它也不连库、不连网络、不起服务。
 *
 * 用法（务必在 server/ 目录下执行）：
 *   npx tsx scripts/verify-file-source-adapter.ts
 *
 * 四种配置各跑一次（shell 里的进程变量优先于 .env，dotenv 不覆盖已存在的变量）：
 *   $env:GQXQ_YJJB_ADAPTER='disabled'                                   # 默认：关闭
 *   $env:GQXQ_YJJB_ADAPTER='file';      $env:GQXQ_YJJB_FILE=''          # file 但缺文件
 *   $env:GQXQ_YJJB_ADAPTER='file';      $env:GQXQ_YJJB_FILE='<快照路径>'  # file 正常
 *   $env:GQXQ_YJJB_ADAPTER='whatever'                                   # 未知形态
 *
 * 断言项：
 *   F1 中文口径映射：每个取值钉 (状态码, 时效标记) 二元组；其余 -> null（绝不猜）
 *   F2 resolveSourceAdapter() 与该 env 组合应有的期望一致
 *   F3 file 激活时：真快照能命中、未命中返回 null、原文保真、码位可映射
 *   F4 错误路径：文件缺失/坏 JSON/顶层类型不对/值不合法/空对象/未配置路径
 *                -> 必须抛错，绝不能返回空成功
 *   F5 不变量：src/ 里 update complaint 的 SET 子句含 source_event_status **或 overtime_flag**
 *              的文件只能有一个（sourceSyncRepo.ts）
 *              （证明 M11 只把时效派生列并进同一条窄 UPDATE，没有新增第二条写路径）
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { env } from '../src/config/env';
import { resolveSourceAdapter } from '../src/adapters';
import { FileSourceAdapter } from '../src/adapters/fileSourceAdapter';
import { mapSourceStatus, mapSourceStatusDetail } from '../src/domain/sourceAdapter';

const SERVER_ROOT = process.cwd();
const results: Array<{ id: string; status: string }> = [];

function emit(id: string, title: string, status: string, lines: string[] = []): void {
  results.push({ id, status });
  console.log('');
  console.log('──── ' + id + ' ' + title + ' ' + '─'.repeat(Math.max(2, 46 - title.length)));
  console.log('  状态: ' + status);
  for (const line of lines) console.log('  ' + line);
}

function checkMapping(): void {
  // 每个用例钉**二元组**：(状态码, 时效标记)。null 时效 = 来源没给时效结论，**不等于 0**。
  const cases: Array<[string, string | null, number | null]> = [
    ['正常在办', 'processing', null],
    ['正常结案', 'completed', 0],
    ['超期结案', 'completed', 1],
    ['  正常在办  ', 'processing', null],
    ['待处理', null, null],
    ['已转办', null, null],
    ['', null, null],
    ['ACCEPTED', 'accepted', null],
    ['某来源特有的状态', null, null],
  ];
  const wrong: string[] = [];
  for (const [input, wantCode, wantOvertime] of cases) {
    const gotCode = mapSourceStatus(input);
    const detail = mapSourceStatusDetail(input);
    const gotOvertime = detail === null ? null : detail.overtimeFlag;
    if (gotCode !== wantCode || gotOvertime !== wantOvertime) {
      wrong.push(
        JSON.stringify(input) + ' -> (' + JSON.stringify(gotCode) + ', ' + JSON.stringify(gotOvertime) + ')' +
          '（期望 (' + JSON.stringify(wantCode) + ', ' + JSON.stringify(wantOvertime) + ')）'
      );
    }
  }
  emit('F1', '中文口径映射：状态轴 + 时效轴二元组（认不出一律 null）', wrong.length === 0 ? 'PASS' : 'FAIL', [
    '共 ' + cases.length + ' 个用例；三个快照口径必须是 (正常在办->processing, NULL) / (正常结案->completed, 0) / (超期结案->completed, 1)',
    '超期是**时效**维度（M11 的 complaint.overtime_flag），不改变 source_event_status 的取值；' +
      '来源没给时效结论的必须仍是 NULL —— 压成 0 就是替来源谎报"没超期"',
    wrong.length > 0 ? '不符: ' + wrong.join('; ') : '全部符合；未列出的取值整体返回 null，由 service 保留原状态并留痕（绝不猜）',
  ]);
}

function expectedResolution(): { name: string; enabled: boolean; misconfigured: boolean } {
  const configured = env.yijiejieban.adapter.trim().toLowerCase();
  if (configured === '' || configured === 'disabled') return { name: 'disabled', enabled: false, misconfigured: false };
  if (configured === 'file') {
    return env.yijiejieban.file.trim() === ''
      ? { name: 'disabled', enabled: false, misconfigured: true }
      : { name: 'file', enabled: true, misconfigured: false };
  }
  return { name: 'disabled', enabled: false, misconfigured: true };
}

function checkResolution(): { name: string; enabled: boolean } {
  const want = expectedResolution();
  const got = resolveSourceAdapter();
  const actual = { name: got.adapter.name, enabled: got.adapter.enabled, misconfigured: got.misconfigured };
  const ok =
    actual.name === want.name && actual.enabled === want.enabled && actual.misconfigured === want.misconfigured;
  emit('F2', 'resolveSourceAdapter() 与配置期望一致', ok ? 'PASS' : 'FAIL', [
    'GQXQ_YJJB_ADAPTER=' + JSON.stringify(env.yijiejieban.adapter) + '  GQXQ_YJJB_FILE=' + JSON.stringify(env.yijiejieban.file),
    '期望: ' + JSON.stringify(want),
    '实际: ' + JSON.stringify(actual),
    'message: ' + got.message,
  ]);
  return actual;
}

async function checkLiveSnapshot(activeName: string): Promise<void> {
  if (activeName !== 'file') {
    emit('F3', '真快照读取与原文保真（需 adapter=file）', 'MANUAL', [
      '当前形态为 ' + activeName + '，跳过真快照读取。',
      "要验证请先设：$env:GQXQ_YJJB_ADAPTER='file'; $env:GQXQ_YJJB_FILE='<快照路径>' 再重跑本脚本。",
    ]);
    return;
  }
  const raw = JSON.parse(readFileSync(env.yijiejieban.file, 'utf8')) as Record<string, string>;
  const keys = Object.keys(raw);
  const adapter = new FileSourceAdapter(env.yijiejieban.file);
  const first = keys[0];
  const snap = await adapter.fetchBySourceId(first);
  const missing = await adapter.fetchBySourceId('__GQXQ_NOT_IN_SNAPSHOT__');

  const dist = new Map<string, number>();
  for (const key of keys) dist.set(raw[key], (dist.get(raw[key]) ?? 0) + 1);
  const unmapped = Array.from(dist.keys()).filter((value) => mapSourceStatus(value) === null);

  const faithful = snap !== null && snap.rawStatus === raw[first];
  const mapped = snap !== null && mapSourceStatus(snap.rawStatus) !== null;
  const ok = faithful && mapped && missing === null;
  const lines = [
    '快照: ' + env.yijiejieban.file + '（' + keys.length + ' 个案件公文号）',
    '命中 ' + JSON.stringify(first) + ' -> rawStatus=' + JSON.stringify(snap === null ? null : snap.rawStatus) +
      ' 映射=' + JSON.stringify(snap === null ? null : mapSourceStatus(snap.rawStatus)),
    '原文保真（rawStatus 必须逐字等于快照值）: ' + faithful,
    '快照未包含的案卷号 ' + JSON.stringify('__GQXQ_NOT_IN_SNAPSHOT__') + ' -> ' + (missing === null ? 'null（正确：来源没有该事件）' : JSON.stringify(missing)),
    '快照取值分布: ' + JSON.stringify(Object.fromEntries(dist)),
    '认不出的取值: ' + (unmapped.length === 0 ? '0 个（全部可映射）' : JSON.stringify(unmapped) + '（这些会在同步时被 service 记 unmapped 并保留原状态）'),
  ];
  emit('F3', '真快照读取与原文保真', ok ? 'PASS' : 'FAIL', lines);
}

async function checkErrorPaths(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gqxq-source-snapshot-'));
  const cases: Array<{ name: string; file: string; write: string | null }> = [
    { name: '文件不存在', file: join(dir, 'missing.json'), write: null },
    { name: '坏 JSON', file: join(dir, 'broken.json'), write: '{ "A": ' },
    { name: '顶层是数组', file: join(dir, 'array.json'), write: '[]' },
    { name: '顶层是字符串', file: join(dir, 'string.json'), write: '"正常结案"' },
    { name: '值不是字符串', file: join(dir, 'badvalue.json'), write: '{ "DH0001": 123 }' },
    { name: '值为空串', file: join(dir, 'emptyvalue.json'), write: '{ "DH0001": "" }' },
    { name: '空对象', file: join(dir, 'empty.json'), write: '{}' },
  ];
  const lines: string[] = [];
  let bad = 0;
  for (const item of cases) {
    if (item.write !== null) writeFileSync(item.file, item.write, 'utf8');
    const adapter = new FileSourceAdapter(item.file);
    let threw: string | null = null;
    let returned: unknown = 'DID_NOT_RESOLVE';
    try {
      returned = await adapter.fetchBySourceId('DH0001');
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    const ok = threw !== null && returned === 'DID_NOT_RESOLVE';
    if (!ok) bad += 1;
    lines.push(
      (ok ? 'OK   ' : 'BAD  ') + item.name + ' -> ' +
        (threw === null ? '没有抛错，返回了 ' + JSON.stringify(returned) + '（错误：等于静默成功）' : '抛错: ' + threw.slice(0, 120))
    );
  }
  const blank = new FileSourceAdapter('');
  let blankThrew = false;
  try {
    await blank.fetchBySourceId('DH0001');
  } catch {
    blankThrew = true;
  }
  if (!blankThrew) bad += 1;
  lines.push((blankThrew ? 'OK   ' : 'BAD  ') + '未配置 GQXQ_YJJB_FILE（空路径） -> ' + (blankThrew ? '抛错（正确）' : '没有抛错（错误）'));
  rmSync(dir, { recursive: true, force: true });
  emit('F4', '错误路径必须如实报错（不得返回空成功）', bad === 0 ? 'PASS' : 'FAIL', lines);
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function checkSingleWriter(): void {
  const files = walk(join(SERVER_ROOT, 'src'));
  const updaters: string[] = [];
  const writers: string[] = [];
  /** 两列都是"来源侧派生列"，共用同一条单写者路径（M11 只扩列、不开第二个写者） */
  const PINNED_COLUMNS = ['source_event_status', 'overtime_flag'];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/update\s+complaint\b/i.test(text)) continue;
    updaters.push(basename(file));
    const re = /update\s+complaint\b/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const setIdx = text.indexOf('set', match.index);
      if (setIdx < 0) continue;
      const whereIdx = text.indexOf('where', setIdx);
      const clause = text.slice(setIdx, whereIdx < 0 ? setIdx + 400 : whereIdx);
      const pinned = PINNED_COLUMNS.filter((col) => clause.includes(col));
      if (pinned.length === 0) continue;
      writers.push(basename(file));
      hits.push(basename(file) + ' 写 ' + pinned.join(' + '));
    }
  }
  const unique = Array.from(new Set(writers));
  const ok = unique.length === 1 && unique[0] === 'sourceSyncRepo.ts';
  emit('F5', '写 source_event_status / overtime_flag 的 UPDATE 只允许一处', ok ? 'PASS' : 'FAIL', [
    '扫描 ' + files.length + ' 个 src/**/*.ts',
    '会 update complaint 的文件: ' + JSON.stringify(updaters),
    '其中 SET 子句含来源派生列的命中: ' + JSON.stringify(hits),
    '命中文件集合: ' + JSON.stringify(unique),
    '期望恰好一个且为 sourceSyncRepo.ts（即 sourceStatusService 唯一的落库出口）——' +
      'M11 把 overtime_flag 并进同一条窄 UPDATE，**没有**新增第二个写者',
  ]);
}

async function main(): Promise<void> {
  console.log('=== 来源适配器 file 形态验证 verify-file-source-adapter.ts ===');
  console.log('cwd: ' + SERVER_ROOT);
  console.log('GQXQ_YJJB_ADAPTER=' + JSON.stringify(env.yijiejieban.adapter) + '  GQXQ_YJJB_FILE=' + JSON.stringify(env.yijiejieban.file));
  checkMapping();
  const resolution = checkResolution();
  await checkLiveSnapshot(resolution.name);
  await checkErrorPaths();
  checkSingleWriter();

  const auto = results.filter((r) => r.status !== 'MANUAL');
  const failed = auto.filter((r) => r.status === 'FAIL');
  console.log('');
  console.log('=== 汇总 ===');
  console.log(
    'PASS ' + auto.filter((r) => r.status === 'PASS').length + ' / FAIL ' + failed.length +
      ' / MANUAL ' + results.filter((r) => r.status === 'MANUAL').length
  );
  console.log('逐项: ' + results.map((r) => r.id + '=' + r.status).join('  '));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (!existsSync(join(SERVER_ROOT, 'src', 'adapters', 'fileSourceAdapter.ts'))) {
  console.error('请在 server/ 目录下运行：npx tsx scripts/verify-file-source-adapter.ts');
  process.exit(2);
}

main().catch((err) => {
  console.error('执行失败: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
