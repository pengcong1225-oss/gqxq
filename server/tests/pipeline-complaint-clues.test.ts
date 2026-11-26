import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { AccessContext } from '../src/auth/accessScope';
import { matchRule } from '../src/auth/rolePolicy';
import { findPipelineComplaintClues } from '../src/services/pipelineComplaintClues';

const access: AccessContext = {
  userId: 'u', roles: ['staff'], scopeVersion: 1, canReadSource: false,
  rules: [{ kind: 'restricted', enterpriseCodes: ['E-WATER'], districtCodes: ['420500'] }],
};
const project = {
  projectId: 'P-A', gridCodes: ['GRID-A', 'GRID-B'], businessType: 'water',
  startsAt: '2026-01-01T08:00:00+08:00', endsAt: '2026-01-01T10:00:00+08:00',
};
const now = Date.parse('2026-01-01T09:30:00+08:00');

test('pipeline work order endpoint is registered as an assessment read', () => {
  assert.equal(matchRule('GET', '/assessment/pipeline-layer/projects/P-A/complaints')?.permissionCode, 'assessment.read');
});

test('pipeline match never queries an outside grid or guesses a missing project window', async () => {
  const db = { query: async () => { assert.fail('must not query the complaint ledger'); } } as unknown as Pool;
  await assert.rejects(
    findPipelineComplaintClues(db, project, 'OTHER', 1, access, now),
    { status: 404 },
  );
  const missing = await findPipelineComplaintClues(db, { ...project, startsAt: null }, 'GRID-A', 1, access, now);
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.total, null);
  const future = await findPipelineComplaintClues(db, project, 'GRID-A', 1, access, now - 8 * 60 * 60 * 1000);
  assert.equal(future.state, 'unavailable');
  assert.equal(future.total, null);
});

test('pipeline page uses the selected grid, sector, exact time and complaint scope, with work order identifiers', async () => {
  const db = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /c\.deleted/);
      assert.match(sql, /c\.source_system = '宜接就办' and c\.source_id <> ''/);
      assert.match(sql, /c\.enterprise_code in \(\?\) and c\.district_code in \(\?\)/);
      assert.match(sql, /c\.business_type = \? and c\.admin_grid_code = \?/);
      assert.match(sql, /c\.source_reported_at between \? and \?.*c\.source_reported_at is null and c\.received_at between \? and \?/s);
      assert.deepEqual(params, [
        'E-WATER', '420500', 'water', 'GRID-B',
        new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T01:30:00Z'),
        new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T01:30:00Z'), 10, 10,
      ]);
      return [[{
        total: '11', id: 'CPL-1', complaintNo: '123', title: '供水水压咨询', type: 'W01',
        occurredAt: new Date('2026-01-01T01:00:00Z'), gridId: 'GRID-B',
      }], []];
    },
  } as unknown as Pool;
  const result = await findPipelineComplaintClues(db, project, 'GRID-B', 2, access, now);
  assert.equal(result.state, 'available');
  assert.equal(result.total, 11);
  assert.equal(result.page, 2);
  assert.deepEqual(result.items, [{
    id: 'CPL-1', complaintNo: '123', title: '供水水压咨询', type: 'W01',
    occurredAt: '2026-01-01T01:00:00.000Z', gridId: 'GRID-B',
  }]);
});

test('an eligible grid with zero rows reports a verified zero and keeps its own grid identity', async () => {
  const db = { query: async () => [[{ total: 0, id: null }], []] } as unknown as Pool;
  const result = await findPipelineComplaintClues(db, project, 'GRID-A', 1, access, now);
  assert.equal(result.state, 'available');
  assert.equal(result.gridCode, 'GRID-A');
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
});
