import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('history ticker uses the selected industry and pages the original historical evidence', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('.', import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
  });
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/' };
  const evidenceRequests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, 'http://local.test');
    const params = Object.fromEntries(parsed.searchParams);
    let data;
    if (parsed.pathname.endsWith('/bootstrap')) {
      const industry = params.businessType ?? 'all';
      const code = industry === 'water' ? 'w01' : 'g01';
      data = {
        contextId: industry,
        window: { from: params.from, to: params.to },
        generatedAt: '2026-11-26T12:00:00Z',
        summary: { total: 10, unlocated: 0 },
        charts: { category: [], district: [], enterprise: [], community: [] },
        top3: { state: 'partial', reason: '历史数据覆盖尚未核验', data: {
          items: [{ code, count: 2, evidenceKey: `${industry}-evidence` }],
          from: '2025-10-28', to: '2025-11-26', coverage: '历史覆盖未知',
        } },
      };
    } else {
      assert.ok(parsed.pathname.endsWith('/evidence'));
      evidenceRequests.push(params);
      data = {
        page: Number(params.page), size: 1, total: 2,
        window: { from: '2025-10-28', to: '2025-11-26' },
        items: [{ id: `prior-${params.page}`, businessType: 'water', categoryCode: 'w01', occurredDay: '2025-11-26' }],
      };
    }
    return Response.json({ code: 200, data });
  };
  try {
    const { fetchTopTypes, fetchDemands } = await vite.ssrLoadModule('/src/stats/api.ts');
    const { seedRealSession } = await vite.ssrLoadModule('/src/stats/realSource.ts');
    seedRealSession('test-token');
    const filters = {
      period: '30d', industry: 'WATER', snapshotId: 'REAL',
      window: { from: '2026-10-28', to: '2026-11-26' },
    };
    const top = (await fetchTopTypes(filters)).data;
    assert.equal(top.items[0].typeId, 'w01');
    assert.deepEqual(top.items[0].evidence, { contextId: 'water', key: 'water-evidence' });
    assert.match(top.coverage, /历史覆盖未知/);
    const query = { source: '往年同期', title: top.items[0].title, period: '30d', industry: 'WATER',
      evidence: top.items[0].evidence, filters, pageSize: 1 };
    const first = (await fetchDemands({ ...query, page: 1 })).data;
    const second = (await fetchDemands({ ...query, page: 2 })).data;
    assert.equal(first.total, top.items[0].count);
    assert.deepEqual(first.evidenceWindow, { from: '2025-10-28', to: '2025-11-26' });
    assert.deepEqual([...first.items, ...second.items].map(row => [row.caseNo, row.intakeTime]), [
      ['prior-1', '2025-11-26'], ['prior-2', '2025-11-26'],
    ]);
    assert.deepEqual(evidenceRequests, [1, 2].map(page => ({
      contextId: 'water', page: String(page), size: '1', evidenceKey: 'water-evidence',
    })));
  } finally {
    await vite.close();
    globalThis.location = originalLocation;
    globalThis.fetch = originalFetch;
  }
});
