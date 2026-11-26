import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'mysql2/promise';
import {mapUtilityFeed, type FeedReferences, type MappedUtilitySource, type UtilityFeedItem} from '../src/domain/utilityFeed';
import {loadShutdownLayer, readLayerEventsForBootstrap} from '../src/services/shutdownLayerService';

const grids = [
  {id: '420502001', name: '甲网格', districtCode: '420502'},
  {id: '420503001', name: '乙网格', districtCode: '420503'},
];
const refs: FeedReferences = {
  grids, enterprises: [{id: 'G', name: '合成燃气企业', businessType: 'gas'}],
  mappings: [{sourceDepartmentCode: 'GU-9', enterpriseCode: 'G'}],
};
const access = {userId: 'test', scopeVersion: 0, roles: [], rules: [{kind: 'all'} as const], canReadSource: false};

function report(id: number, overrides: Partial<UtilityFeedItem> = {}): UtilityFeedItem {
  return {
    feedId: id, sourceId: String(id), sourceApplicationNo: `TEST-SHUTDOWN-${id}`, kind: 'gas-stops',
    sourceKind: 'native', dataMode: 'real', revision: 'r2', changedAt: null, status: '11',
    enterprise: {subjectId: 'GU-9'},
    fields: {isReportTingqi: '计划停气', gqxqGridCodes: grids.map(grid => grid.id),
      tingqiDate: '2026-11-10 08:00', fugongDate: '2026-11-10 12:00', households: 12, emergencyPlan: '合成应急预案'},
    approvalTraces: [{action: 'APPROVE', operator: '合成审批人', time: '2026-11-09 08:00'}],
    ...overrides,
  };
}

function fixture(sources: MappedUtilitySource[]): Pool {
  return {query: async (sql: string) => {
    if (sql.includes('from admin_grid')) return [grids.map(grid => ({code: grid.id, name: grid.name}))];
    if (sql.includes('from shutdown_application')) return [[]];
    if (sql.includes('from gqxq_tender_support_store')) return [[{content: {sources}}]];
    if (sql.includes('from enterprise')) return [refs.enterprises.map(e => ({enterprise_code: e.id, enterprise_name: e.name, business_type: e.businessType}))];
    if (sql.includes('from community')) return [[{location_lng: 111.3, location_lat: 30.7, admin_grid_code: grids[0].id}]];
    throw Error(`Unexpected query ${sql}`);
  }} as unknown as Pool;
}

test('the shutdown layer includes a verified native planned gas submission as one event with two markers', async () => {
  const mapped = mapUtilityFeed(report(1), 'real', refs);
  assert.equal(mapped.syncStatus, 'mapped');
  assert.equal(mapped.events.length, 2);
  const stale = mapUtilityFeed(report(2), 'real', refs);
  stale.source.revision = 'superseding-revision';
  const db = fixture([mapped, stale]);
  const layer = await loadShutdownLayer(db, 'planned_gas', access);
  assert.deepEqual(layer.events.map(e => e.eventId), [mapped.source.sourceApplicationNo]);
  assert.deepEqual(layer.markers.map(e => e.gridCode), grids.map(grid => grid.id));
  assert.ok(layer.markers.every(marker => marker.eventId === layer.events[0].eventId));
  assert.equal(layer.events[0].enterpriseName, '合成燃气企业');
  assert.equal(layer.events[0].affectedHouseholds, 12);
  assert.equal(layer.events[0].emergencyPlan, '合成应急预案');
  assert.equal(layer.events[0].coordinateAssumed, false);
  assert.equal(layer.gridHistory[grids[1].id].total, 1);
  assert.equal((await readLayerEventsForBootstrap(db)).events[0].eventId, layer.events[0].eventId);
});

test('the shutdown fallback leaves unknown coordinates unlocated in strict mode', async () => {
  const legacy = report(3, {
    sourceKind: 'legacy', status: '00', approvalTraces: [], enterprise: {name: refs.enterprises[0].name},
    fields: {isReportTingqi: '计划外停气', tingqiRange: [{latLog: '111.29,30.69;111.31,30.69;111.31,30.71;111.29,30.71'}]},
  });
  const explicit = {...legacy, feedId: 4, sourceApplicationNo: 'TEST-SHUTDOWN-4', coordinateSystem: 'WGS84'};
  const previous = process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02;
  process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02 = 'false';
  try {
    const db = fixture([legacy, explicit].map(source => mapUtilityFeed(source, 'real', refs)));
    const layer = await loadShutdownLayer(db, 'all', access);
    assert.deepEqual(layer.events.map(e => e.eventId), [explicit.sourceApplicationNo]);
    assert.equal(layer.events[0].coordinateAssumed, false);
  } finally {
    if (previous === undefined) delete process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02;
    else process.env.GQXQ_SHUTDOWN_ASSUME_GCJ02 = previous;
  }
});

test('the shutdown diagnostics count actual pending sources and retain overlapping approval evidence gaps', async () => {
  const unknown = report(5, {enterprise: {name: '合成待确认企业'}, approvalTraces: []});
  const simulation = report(6, {dataMode: 'simulation'});
  const construction = report(7, {kind: 'construction'});
  const db = fixture([unknown, simulation, construction].map(source => mapUtilityFeed(source, source.dataMode, refs)));
  const {blocker} = await loadShutdownLayer(db, 'all', access);
  assert.equal(blocker.sourceTotal, 1);
  assert.equal(blocker.pendingCount, 1);
  assert.equal(blocker.blockedByEnterprise, 1);
  assert.equal(blocker.blockedByApproval, 1);
  assert.equal(blocker.blockedByGrid, 0);
  assert.deepEqual(blocker.pendingEnterprises.map(({name, count}) => ({name, count})), [{name: '合成待确认企业', count: 1}]);
  assert.equal(blocker.pendingIssueGroups[0].count, 1);
  assert.equal(blocker.pendingIssueGroups[0].issues.length, 2);
});
