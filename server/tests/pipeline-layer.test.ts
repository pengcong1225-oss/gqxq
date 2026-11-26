import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import type {Pool} from 'mysql2/promise';
import type {AccessContext} from '../src/auth/accessScope';
import {pool} from '../src/db/pool';
import {mapUtilityFeed, type FeedReferences, type UtilityFeedItem} from '../src/domain/utilityFeed';
import {AppError} from '../src/http/errors';
import {businessFeaturesRouter} from '../src/routes/businessFeatures';
import {loadPipelineLayer, loadPipelineProject} from '../src/services/pipelineLayerService';

const grids = [
  {id: '420502001', name: '第一网格', districtCode: '420502'},
  {id: '420503001', name: '第二网格', districtCode: '420503'},
];
const refs: FeedReferences = {
  grids,
  enterprises: [
    {id: 'W', name: '测试供水企业', businessType: 'water'},
    {id: 'G', name: '测试燃气企业', businessType: 'gas'},
  ],
  mappings: [],
};
const all: AccessContext = {userId: 'test', roles: [], rules: [{kind: 'all'}], scopeVersion: 1, canReadSource: false};
const restricted = (enterpriseCodes: string[], districtCodes: string[]): AccessContext => ({
  ...all, rules: [{kind: 'restricted', enterpriseCodes, districtCodes}],
});

function application(number: number, businessType: 'water' | 'gas', gridCodes: string[], overrides: Partial<UtilityFeedItem> = {}) {
  const source: UtilityFeedItem = {
    feedId: number, sourceApplicationNo: `TEST-APPLY-${number}`, sourceId: String(number),
    sourceKind: 'native', kind: 'construction', dataMode: 'real', revision: 'a', status: '11',
    changedAt: '2026-11-12T00:00:00Z',
    fields: {
      title: `施工申请 ${number}`, companyName: businessType === 'water' ? refs.enterprises[0].name : refs.enterprises[1].name,
      businessType, gqxqGridCodes: gridCodes, startsAt: '2026-11-12 01:30:00', endsAt: '2026-11-13 15:00:00',
      reason: '管道更换', emergencyPlan: '测试预案', projectStatus: 'in_progress',
    },
    approvalTraces: [{action: 'APPROVE', operator: '测试审批员', time: '2026-11-11 12:00:00'}],
    ...overrides,
  };
  return mapUtilityFeed(source, source.dataMode, refs);
}

const old = (id: string, values: Record<string, unknown> = {}) => ({
  project_id: id, project_name: id, business_type: 'water', enterprise_code: 'W', ...values,
});

test('construction contractor alone does not identify the reporting utility enterprise', () => {
  const contractor = application(8, 'gas', [], {fields: {
    projectType: '供气工程', sgdwName: refs.enterprises[1].name,
    kgDate: '2026-11-12', jhwcDate: '2026-11-13',
  }});
  assert.equal(contractor.syncStatus, 'pending_mapping');
  assert.deepEqual(contractor.events, []);
  const reporter = application(8, 'gas', [], {fields: {
    ...contractor.source.fields, reportCompany: refs.enterprises[1].name, sgdwName: refs.enterprises[0].name,
  }});
  assert.equal(reporter.events[0].enterpriseId, 'G');
});

function fixture() {
  const water = application(1, 'water', grids.map(grid => grid.id));
  const gas = application(2, 'gas', [grids[0].id], {fields: {
    projectName: '计划施工测试燃气项目', companyName: refs.enterprises[1].name, projectType: '供气工程',
    isPlanShigong: '计划施工', kgDate: '2026-11-12', jhwcDate: '2026-11-13', isZtjgys: '是',
    shigongDescribe: '测试施工说明', gqxqGridCodes: [grids[0].id],
  }});
  const unlocated = application(3, 'gas', ['INVALID']);
  const pending = application(4, 'water', [grids[0].id], {approvalStatus: 'PENDING'});
  const simulation = application(5, 'water', [grids[0].id], {dataMode: 'simulation'});
  const updated = application(6, 'water', [grids[0].id], {sourceApplicationNo: 'TEST-APPLY-4', approvalStatus: 'REJECTED', changedAt: '2026-11-14T00:00:00Z'});
  const imported = application(7, 'gas', [grids[0].id]).events.map(event => ({...event, sourceSystem: undefined, hasVerifiedGrid: undefined}));
  const sources = [updated, water, gas, unlocated, pending, simulation];
  const legacy = [
    old('duplicate-water', {source_apply_no: 'TEST-APPLY-1', admin_grid_codes: [grids[0].id]}),
    old('duplicate-pending', {source_apply_no: 'TEST-APPLY-4', admin_grid_codes: [grids[0].id]}),
    old('legacy-mapped', {admin_grid_codes: JSON.stringify([grids[0].id, grids[0].id]), start_date: '2026-10-09'}),
    old('legacy-unlocated'),
    old('legacy-invalid', {admin_grid_codes: [grids[0].id, '000000']}),
  ];
  const db = {query: async (sql: string, params: string[] = []) => {
    if (sql.includes('gqxq_tender_support_store')) {
      if (params[0] === 'utility-feed-real') return [[{revision: 1, content: JSON.stringify({sources})}]];
      if (params[0] === 'utility-real') return [[{revision: 1, content: {events: imported}}]];
    }
    if (sql.includes('from pipeline_project')) return [legacy];
    if (sql.includes('from admin_grid')) return [grids.map(grid => ({code: grid.id, district_code: grid.districtCode}))];
    if (sql.includes('from enterprise')) return [refs.enterprises.map(company => ({enterprise_code: company.id, enterprise_name: company.name, business_type: company.businessType}))];
    throw Error(`Unexpected query ${sql}`);
  }} as unknown as Pool;
  return {db, sources, legacy};
}

test('pipeline layer projects each real application once across grids and preserves identifiable legacy rows', async () => {
  const {db, sources} = fixture();
  const layer = await loadPipelineLayer(db, 'all', all);
  assert.equal(layer.projectCount, 7);
  assert.equal(layer.gridCount, 2);
  assert.equal(layer.cells[0].projectCount, 4);
  const water = layer.cells[0].projects.find(project => project.sourceApplyNo === 'TEST-APPLY-1')!;
  assert.equal(layer.cells[1].projects[0].projectId, water.projectId);
  assert.deepEqual(water.gridCodes, grids.map(grid => grid.id));
  assert.equal(water.source, 'utility-application');
  assert.equal(water.enterpriseCode, 'W');
  assert.equal(water.enterpriseName, '测试供水企业');
  assert.equal(water.startsAt, '2026-11-11T17:30:00.000Z');
  assert.equal(water.startDate, '2026-11-12');
  assert.equal(water.status, 'in_progress');
  assert.equal(water.workerCount, null);
  assert.equal(water.emergencyPlan, '测试预案');
  assert.deepEqual(await loadPipelineProject(db, water.projectId, all), water);
  sources.reverse();
  assert.deepEqual(await loadPipelineLayer(db, 'all', all), layer);

  const legacy = layer.cells[0].projects.find(project => project.projectId === 'legacy-mapped')!;
  assert.equal(legacy.source, 'legacy-project');
  assert.equal(legacy.sourceApplyNo, null);
  assert.equal(legacy.startDate, '2026-10-09');
  assert.equal(legacy.startsAt, null);
  assert.deepEqual(layer.unlocatedProjects.map(project => project.sourceApplyNo).sort(), ['TEST-APPLY-3', null, null].sort());
  const gas = await loadPipelineLayer(db, 'gas', all);
  assert.equal(gas.projectCount, 3);
  assert.deepEqual(gas.cells[0].projects.map(project => project.sourceApplyNo).sort(), ['TEST-APPLY-2', 'TEST-APPLY-7']);
  const dateOnly = gas.cells[0].projects.find(project => project.sourceApplyNo === 'TEST-APPLY-2')!;
  assert.equal(dateOnly.startDate, '2026-11-12');
  assert.equal(dateOnly.endDate, '2026-11-13');
  assert.equal(dateOnly.startsAt, null);
  assert.equal(dateOnly.endsAt, null);
  assert.equal(dateOnly.status, 'completed');
  assert.equal(dateOnly.constructionReason, '测试施工说明');
});

test('pipeline layer authorizes complete coverage and does not leak out-of-scope project metadata', async () => {
  const {db} = fixture();
  const areaAccess = restricted([], ['420502']);
  const layer = await loadPipelineLayer(db, 'all', areaAccess);
  assert.equal(layer.projectCount, 3);
  assert.deepEqual(layer.unlocatedProjects, []);
  assert.deepEqual(layer.cells[0].projects.map(project => project.sourceApplyNo).sort(), ['TEST-APPLY-2', 'TEST-APPLY-7', null]);
  const unrestricted = await loadPipelineLayer(db, 'all', all);
  const crossDistrict = unrestricted.cells[1].projects[0];
  assert.equal(await loadPipelineProject(db, crossDistrict.projectId, areaAccess), null);
  assert.equal(await loadPipelineProject(db, 'legacy-unlocated', areaAccess), null);
  const waterAccess = await loadPipelineLayer(db, 'all', restricted(['W'], []));
  assert.equal(waterAccess.projectCount, 4);
  assert.ok(waterAccess.cells.every(cell => cell.projects.every(project => project.enterpriseCode === 'W')));
  assert.equal((await loadPipelineLayer(db, 'all', {...all, rules: []})).projectCount, 0);
});

test('pipeline layer HTTP route checks pipeline permission and forwards user scope', async (t) => {
  const {db} = fixture();
  const query = t.mock.method(pool, 'query', db.query);
  const app = express();
  app.use((req, _res, next) => {
    req.accessContext = restricted([], ['420502']);
    req.user = {
      id: all.userId, username: 'test-user', roles: [],
      permissionCodes: req.get('x-pipeline-reader') ? ['assessment.read', 'pipeline.read'] : ['assessment.read'],
    };
    next();
  });
  app.use(businessFeaturesRouter);
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({message: error.message});
  });

  await request(app).get('/assessment/pipeline-layer').expect(403);
  assert.equal(query.mock.callCount(), 0);
  const response = await request(app).get('/assessment/pipeline-layer?businessType=gas')
    .set('x-pipeline-reader', 'true').expect('Cache-Control', 'no-store').expect(200);
  assert.equal(response.body.data.gridCount, 1);
  assert.equal(response.body.data.projectCount, 2);
  assert.deepEqual(response.body.data.unlocatedProjects, []);
});
