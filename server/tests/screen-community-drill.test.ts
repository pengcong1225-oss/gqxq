import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccessContext } from '../src/auth/accessScope';
import { pool } from '../src/db/pool';
import { screenBootstrap, screenDemands, screenMapPickDemands } from '../src/services/screenService';

const access = { userId: 'community-reviewer', roles: ['readonly'], scopeVersion: 1, rules: [{ kind: 'all' }], canReadSource: false } as AccessContext;
const basic = ['statistics.read', 'dashboard.read', 'complaint.read'];
const spatial = [...basic, 'grid.read', 'heatmap.read'];
const from = '2026-10-28';
const to = '2026-11-26';
const communityCode = 'C-420502-0001';
const adminGridCode = '420502001';

test('chosen industry, report-day precedence, coverage and page boundaries match the ranking', async (t) => {
  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    complaint_id: id, source_id: `source-${id}`, source_system: '宜接就办', business_type: 'water',
    district_code: '420502', enterprise_code: 'ENT-WATER-001', community_code: communityCode,
    admin_grid_code: adminGridCode, minor_category_code: 'w01', major_category_code: 'water_service',
    source_reported_at: new Date('2026-11-26T23:59:59+08:00'), received_at: new Date('2026-11-28T12:00:00+08:00'),
    ...fields,
  });
  const rows = [
    row('gas', { business_type: 'gas' }),
    row('matched'),
    row('old-reported', { source_reported_at: new Date('2026-10-27T23:59:59+08:00'), received_at: new Date('2026-10-28T12:00:00+08:00') }),
    row('late-reported', { source_reported_at: new Date('2026-11-27T00:00:00+08:00'), received_at: new Date('2026-11-26T12:00:00+08:00') }),
    row('received-fallback', { source_reported_at: null, received_at: new Date('2026-10-28T00:00:00+08:00') }),
    row('no-date', { source_reported_at: null, received_at: null }),
    row('no-source-key', { source_id: null }),
    row('missing-community', { community_code: null }),
    row('other-category', { minor_category_code: 'w02' }),
    row('other-grid', { admin_grid_code: '420502002' }),
    row('other-enterprise', { enterprise_code: 'ENT-WATER-002' }),
    row('other-district', { district_code: '420503' }),
  ];
  t.mock.method(pool, 'getConnection', async () => ({
    query: async (sql: string) => [sql.includes('from complaint c') ? rows : [], []],
    rollback: async () => {}, release: () => {},
  }));
  t.mock.method(pool, 'query', async () => [[], []]);
  const filters = { from, to, districtCode: '420502', enterpriseCode: 'ENT-WATER-001', adminGridCode, categoryCode: 'w01' };
  const rank = await screenBootstrap({ ...filters, businessType: 'water' }, access, spatial);
  const mixed = await screenBootstrap(filters, access, spatial);
  const denied = await screenBootstrap({ from, to }, access, basic);
  assert.deepEqual(denied.charts.community, []);
  assert.deepEqual(rank.charts.community.find((r) => r.code === communityCode), { code: communityCode, count: 2 });
  const preview = screenDemands(rank.contextId, 1, 10, access, spatial, { communityCode });
  const first = screenDemands(mixed.contextId, 1, 1, access, spatial, { businessType: 'water', communityCode });
  const second = screenDemands(mixed.contextId, 2, 1, access, spatial, { businessType: 'water', communityCode });
  assert.equal(preview.total, 2);
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
  assert.deepEqual([...first.items, ...second.items].map((r) => [r.id, r.occurredDay]), [
    ['matched', to], ['received-fallback', from],
  ]);
  assert.deepEqual(preview.items.map((r) => r.id), ['matched', 'received-fallback']);
  assert.throws(() => screenDemands(rank.contextId, 1, 10, access, basic, { communityCode }), /权限/);
  assert.throws(() => screenDemands(rank.contextId, 1, 10, { ...access, scopeVersion: 2 }, spatial, { communityCode }), /权限范围/);

  const restricted: AccessContext = {
    ...access,
    rules: [{ kind: 'restricted', enterpriseCodes: ['ENT-WATER-001'], districtCodes: ['420502'] }],
  };
  const scoped = await screenBootstrap({ from, to, categoryCode: 'w01', adminGridCode, businessType: 'water' }, restricted, spatial);
  const scopedPreview = screenDemands(scoped.contextId, 1, 10, restricted, spatial, { communityCode });
  assert.deepEqual(scopedPreview.items.map((r) => r.id), ['matched', 'received-fallback']);
  assert.equal(scopedPreview.total, scoped.charts.community.find((r) => r.code === communityCode)?.count);
});

test('standalone map queries require spatial permissions and only use reception time as fallback', async (t) => {
  const query = t.mock.method(pool, 'query', async (sql: string) => [sql.includes('count(*)') ? [{ n: 0 }] : [], []]);
  const filters = { from, to, businessType: 'water', communityCode };
  await assert.rejects(() => screenMapPickDemands(filters, access, basic), /权限/);
  assert.equal(query.mock.callCount(), 0);
  await screenMapPickDemands(filters, access, spatial);
  for (const call of query.mock.calls) {
    assert.match(call.arguments[0], /c\.source_reported_at is null and c\.received_at >= \?/);
  }
});
