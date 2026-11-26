/**
 * verify-boundary-pack.ts —— 边界数据包离线校验（不经过 HTTP / 登录）
 *
 * 用途：每次「换数据」（换 OSM 快照、换甲方导出、换商业数据）后跑一遍：
 *   npm run verify:boundary-pack
 *
 * 它做三件事：
 *   1) 按服务端同一套加载器解析数据包（坐标系/闭合/越界/大小上限都会真实触发）；
 *   2) 用真实库数据跑一遍 buildStreetBoundaries，统计 official / pack / buffer 分布与编码对齐率；
 *   3) 断言：数据包可解析、几何环全部闭合、至少有一个要素与网格编码对齐。
 *
 * 退出码 0 = 可用；1 = 有硬问题（打印原因，不静默通过）。
 */
import {loadBoundaryPack} from '../src/services/boundaryPackService';
import {loadStreetBoundaryInput, buildStreetBoundaries, invalidateStreetBoundaryCache} from '../src/services/streetBoundaryService';
import {pool} from '../src/db/pool';

function ringClosed(ring: number[][]): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

async function main() {
  const {pack, error, configuredFile} = loadBoundaryPack();
  if (!configuredFile) {
    console.error('[verify] GQXQ_BOUNDARY_PACK 未配置 —— 当前只有 official/buffer 两条路径。');
    process.exit(1);
  }
  if (!pack) {
    console.error('[verify] 数据包加载失败：' + error);
    process.exit(1);
  }
  console.log('[verify] 文件：' + pack.file);
  console.log('[verify] 元数据：provider=' + (pack.meta.provider ?? '-') +
    ' license=' + (pack.meta.license ?? '-') +
    ' srid=' + (pack.meta.srid ?? 4326) +
    ' fetchedAt=' + (pack.meta.fetchedAt ?? '-'));
  console.log('[verify] 要素数=' + pack.features.length +
    ' 丢弃统计=' + JSON.stringify(pack.dropped));

  let rings = 0;
  let unclosed = 0;
  for (const f of pack.features) {
    for (const ring of f.polygons) {
      rings += 1;
      if (!ringClosed(ring)) unclosed += 1;
    }
  }
  console.log('[verify] 环数=' + rings + ' 未闭合=' + unclosed);

  invalidateStreetBoundaryCache();
  const input = await loadStreetBoundaryInput(pool);
  const boundaries = buildStreetBoundaries({...input, pack});
  const bySource = {official: 0, pack: 0, buffer: 0} as Record<string, number>;
  for (const b of boundaries) bySource[b.source] += 1;
  const packItems = boundaries.filter((b) => b.source === 'pack');
  const matched = packItems.filter((b) => b.packMatched).length;
  console.log('[verify] 生成边界：official=' + bySource.official + ' pack=' + bySource.pack + ' buffer=' + bySource.buffer);
  console.log('[verify] 数据包编码对齐：' + matched + '/' + packItems.length);
  for (const b of packItems.slice(0, 10)) {
    console.log('   - ' + b.code + ' ' + b.name + (b.packMatched ? '' : '（未对齐）') + ' 环=' + b.polygons.length + ' 社区=' + (b.communityCount ?? 0));
  }
  const unmatched = packItems.filter((b) => !b.packMatched);
  if (unmatched.length) {
    console.warn('[verify] 警告：' + unmatched.length + ' 个数据包面没有对上网格编码，诉求量会聚不上：' +
      unmatched.map((b) => b.name).join(' / '));
  }

  const problems: string[] = [];
  if (unclosed > 0) problems.push(unclosed + ' 个环未闭合');
  if (pack.features.length === 0) problems.push('数据包没有任何可用要素');
  if (packItems.length > 0 && matched === 0) problems.push('没有任何要素与 admin_grid 编码对齐（全部会显示 0 件诉求）');
  await pool.end();
  if (problems.length) {
    console.error('[verify] 未通过：' + problems.join('；'));
    process.exit(1);
  }
  console.log('[verify] 通过');
}

main().catch((e) => {
  console.error('[verify] 异常：' + (e as Error)?.message);
  process.exit(1);
});
