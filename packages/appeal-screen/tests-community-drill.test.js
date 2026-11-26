import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('community preview and every drawer page use the ranking window, scope, and industry context', async () => {
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
  const waterIds = Array.from({ length: 11 }, (_, i) => `water-${i + 1}`);
  const bootstrapRequests = [];
  const detailRequests = [];
  const from = '2026-10-28';
  const to = '2026-11-26';
  const communityCode = 'C-420502-0001';
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, 'http://local.test');
    const params = Object.fromEntries(parsed.searchParams);
    let data;
    if (parsed.pathname.endsWith('/bootstrap')) {
      bootstrapRequests.push(params);
      const count = params.businessType === 'water' ? waterIds.length : 12;
      data = {
        contextId: params.businessType ?? 'all',
        window: { from: params.from, to: params.to },
        generatedAt: `${to}T12:00:00Z`,
        summary: { total: count, unlocated: 0 },
        charts: { category: [], district: [], enterprise: [], community: [{ code: communityCode, count }], monthly: [] },
      };
    } else {
      assert.ok(parsed.pathname.endsWith('/demands'));
      detailRequests.push(params);
      const ids = params.contextId === 'water' ? waterIds : ['gas-1', ...waterIds];
      const page = Number(params.page);
      const size = Number(params.size);
      data = {
        page, size, total: ids.length,
        items: ids.slice((page - 1) * size, page * size).map((id) => ({
          id, businessType: id.split('-')[0], communityCode, categoryCode: 'w01', occurredDay: from,
        })),
      };
    }
    return Response.json({ code: 200, data });
  };
  try {
    const { fetchSupply, fetchDemands } = await vite.ssrLoadModule('/src/stats/api.ts');
    const { seedRealSession, setRealAsOf } = await vite.ssrLoadModule('/src/stats/realSource.ts');
    seedRealSession('test-token');
    setRealAsOf('2026-11-30');
    const filters = {
      period: '30d', industry: 'WATER', snapshotId: 'REAL', window: { from, to },
      districtCode: '420502', gridCode: '420502001', enterpriseCode: 'ENT-WATER-001',
      communityCode, categoryCode: 'w01',
    };
    const ranking = await fetchSupply(filters);
    const query = { source: '地图点位', title: '小区明细', period: '30d', industry: 'WATER', communityCode, communityName: 'C-小区别名', filters };
    const preview = await fetchDemands({ ...query, page: 1, pageSize: 10 });
    const first = await fetchDemands({ ...query, page: 1, pageSize: 8 });
    const next = await fetchDemands({ ...query, page: 2, pageSize: 8 });
    assert.equal(bootstrapRequests.length, 3);
    for (const params of bootstrapRequests) {
      assert.deepEqual({ ...params, businessType: undefined }, {
        from, to, businessType: undefined, districtCode: '420502', adminGridCode: '420502001',
        enterpriseCode: 'ENT-WATER-001', communityCode, categoryCode: 'w01',
      });
    }
    assert.ok(detailRequests.every((params) => params.contextId === 'water' && params.communityCode === communityCode));
    for (const result of [preview, first, next]) {
      assert.equal(result.data.total, ranking.data.communityTop.items[0].count);
    }
    assert.deepEqual(preview.data.items.map((item) => item.caseNo), waterIds.slice(0, 10));
    assert.deepEqual([...first.data.items, ...next.data.items].map((item) => item.caseNo), waterIds);
  } finally {
    await vite.close();
    globalThis.location = originalLocation;
    globalThis.fetch = originalFetch;
  }
});
