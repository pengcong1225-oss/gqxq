import {simulatedSupportData} from '../src/domain/tenderSupportData';
import {test} from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';import express from 'express';
import {createApp} from '../src/app';import {matchRule} from '../src/auth/rolePolicy';import {screenDemands,screenBootstrap,screenEvent,screenCompare,screenEvidence} from '../src/services/screenService';
import { businessFeaturesRouter } from '../src/routes/businessFeatures';
import { screenRouter } from '../src/routes/screen';
import { AppError } from '../src/http/errors';
const access:any={userId:'u',roles:['readonly'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false};
test('大屏路由需要身份且权限策略明确登记',async()=>{const app=createApp();for(const path of ['/api/v1/screen/bootstrap','/api/v1/screen/demands']){const res=await request(app).get(path);assert.equal(res.status,401);}assert.equal(matchRule('GET','/screen/bootstrap')?.permissionCode,'statistics.read');assert.equal(matchRule('GET','/screen/demands')?.permissionCode,'statistics.read');assert.equal(matchRule('POST','/screen/bootstrap'),null);});
test('明细权限回收或过期上下文不能读取',()=>{assert.throws(()=>screenDemands('unknown',1,20,access,['statistics.read','dashboard.read']),/权限/);assert.throws(()=>screenDemands('unknown',1,20,access,['statistics.read','dashboard.read','complaint.read']),/过期/);});

test('真实同期榜单读取上海日期的去年窄窗口，并从原快照查本类证据', async () => {
  const originalGet = pool.getConnection;
  const originalQuery = pool.query;
  const grants = ['statistics.read', 'dashboard.read', 'complaint.read'];
  const row = (id: string, date: string, minorCode: string | null, overrides = {}) => ({
    complaint_id: id, source_system: '宜接就办', source_id: id, district_code: 'D1',
    business_type: 'gas', source_reported_at: date, minor_category_code: minorCode,
    major_category_code: null, ...overrides,
  });
  const scoped = { ...access, rules: [{ kind: 'restricted', districtCodes: ['D1'], enterpriseCodes: [] }] };
  const historical = [
    row('H1', '2025-11-01T16:00:00Z', 'g01'),
    row('H2', '2025-11-02T09:00:00Z', 'g01'),
    row('duplicate-H2', '2025-11-02T09:00:00Z', 'g01', { source_id: 'H2' }),
    row('H3', '2025-11-02T15:59:59Z', null, { major_category_code: 'g02' }),
    row('H4', '2025-11-02T10:00:00Z', 'g03'),
    row('too-old', '2025-11-01T15:59:59Z', 'g01'),
    row('too-new', '2025-11-02T16:00:00Z', 'g01'),
    row('outside-scope', '2025-11-02T09:00:00Z', 'g01', { district_code: 'D2' }),
    row('water', '2025-11-02T09:00:00Z', 'w01', { business_type: 'water' }),
    row('simulation', '2025-11-02T09:00:00Z', 'g01', { source_system: 'simulation' }),
    ...Array.from({ length: 3 }, (_, i) => row(`missing-${i}`, '2025-11-02T09:00:00Z', null)),
  ];
  const queries: unknown[][] = [];
  (pool as any).getConnection = async () => ({
    query: async (sql: string, args: unknown[]) => {
      if (!sql.includes('from complaint c')) return [[], []];
      if (!sql.includes('c.source_reported_at < ?')) {
        return [[row('C1', '2026-11-02T12:00:00Z', 'g01')], []];
      }
      queries.push(args.map((value) => value instanceof Date ? value.toISOString() : value));
      return [historical, []];
    }, rollback: async () => {}, release: () => {},
  });
  (pool as any).query = async () => [[], []];
  try {
    const result = await screenBootstrap({ from: '2026-11-02', to: '2026-11-02', businessType: 'gas' }, scoped, grants);
    assert.equal(result.summary.total, 1);
    assert.equal(result.quality.duplicates, 0);
    assert.equal(result.top3.state, 'partial');
    assert.deepEqual(result.top3.data.items.map(({ code, count }) => [code, count]), [['g01', 2], ['g02', 1], ['g03', 1]]);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].slice(-4), [
      '2025-11-01T16:00:00.000Z', '2025-11-02T16:00:00.000Z',
      '2025-11-01T16:00:00.000Z', '2025-11-02T16:00:00.000Z',
    ]);
    const key = result.top3.data.items[0].evidenceKey;
    const first = screenEvidence(result.contextId, key, 1, 1, scoped, grants);
    const second = screenEvidence(result.contextId, key, 2, 1, scoped, grants);
    assert.equal(first.total, 2);
    assert.deepEqual(first.window, { from: '2025-11-02', to: '2025-11-02' });
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), ['H1', 'H2']);
    assert.throws(() => screenEvidence(result.contextId, key, 1, 1, { ...scoped, rules: [{ kind: 'all' }] }, grants), /不存在/);
  } finally {
    pool.getConnection = originalGet;
    pool.query = originalQuery;
  }
});

test('不允许覆盖固定账本及传入未执行的筛选',async()=>{const grants=['statistics.read','dashboard.read','complaint.read'];await assert.rejects(()=>screenBootstrap({dataset:'analysis'},access,grants),/不支持/);await assert.rejects(()=>screenBootstrap({serviceGridCode:'G'},access,grants),/不支持/);});
import {pool} from '../src/db/pool';import {shanghaiToday} from '../src/domain/statisticsQuery';
test('模拟数据权限及年度下钻在当前上下文中生效',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;
 poolAny.getConnection=async()=>({query:async()=>[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const to=shanghaiToday(),from=to.slice(0,7)+'-01',grants=['statistics.read','dashboard.read','complaint.read'];const result=await screenBootstrap({mode:'simulation',from,to},access,grants);assert.deepEqual(result.charts.adminGrid,[]);assert.deepEqual(result.spatial.data.grids,[]);assert.deepEqual(result.spatial.data.pipelines,[]);assert.deepEqual(result.supply.data.enterpriseRates,[]);assert.ok(result.research.data.seasons.every((x:any)=>x.topGrids.length===0));
 const page=screenDemands(result.contextId,1,100,access,grants,{metricKey:'year'});assert.equal(page.total,result.periods.year.count);assert.ok(page.items.every(x=>x.adminGridCode===null));assert.throws(()=>screenDemands(result.contextId,1,20,{...access,userId:'other'},grants),/不存在/);assert.throws(()=>screenDemands(result.contextId,1,20,access,['statistics.read','dashboard.read']),/权限/);
 }finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟 bootstrap 不触碰数据库并可比较授权零诉求网格',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;poolAny.getConnection=async()=>{throw Error('不得访问数据库');};poolAny.query=async()=>{throw Error('不得访问数据库');};
 try{const to=shanghaiToday(),from=to.slice(0,7)+'-01',grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read','enterprise.read'];const r=await screenBootstrap({mode:'simulation',from,to},access,grants);assert.equal(r.spatial.state,'available');assert.ok(r.spatial.data.grids.length>0);assert.ok(r.spatial.data.communities.length>0);assert.ok(r.spatial.data.events.length>0);assert.ok(r.spatial.data.pipelines.length>0);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟事件详情保留历史且不需要数据库',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;poolAny.getConnection=async()=>{throw Error('不得访问数据库');};poolAny.query=async()=>{throw Error('不得访问数据库');};
 try{const to=shanghaiToday(),grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:to.slice(0,7)+'-01',to},access,grants);const event=r.spatial.data.events[0] as any;const detail=await screenEvent(r.contextId,event.id,access,grants);assert.ok(detail.history?.length);assert.equal(typeof detail.relatedDemands.total,'number');}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('真实只读快照复用有效户数且仅接纳正式来源',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;let rollback=0;const to=shanghaiToday();
 poolAny.getConnection=async()=>({query:async(sql:string)=>{if(sql.includes('from complaint c'))return [[{source_system:'宜接就办',source_id:'REAL-1',complaint_id:'C1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date(to+'T03:00:00Z'),received_at:null,admin_grid_code:null,community_code:null,major_category_code:null},{source_system:'DEMO-20261110',source_id:'D1',complaint_id:'D1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date(to+'T03:00:00Z')}],[]];if(sql.includes('from enterprise where'))return [[{enterprise_code:'E',district_code:'A'}],[]];if(sql.includes('from enterprise_household_version'))return [[{households:20000,valid_from:to,valid_to:null,version:1}],[]];return [[],[]];},rollback:async()=>{rollback++},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read','enterprise.read'];const r=await screenBootstrap({from:to,to},access,grants);assert.equal(r.summary.total,1);assert.equal((r.supply.data.enterpriseRates[0] as any).per10k,0.5);assert.equal(rollback,1);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟网格比较允许零诉求网格并计算非零网格分类',async()=>{
 const to=shanghaiToday(),sample=simulatedSupportData(to).complaints[0].occurredAt.slice(0,10),grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:sample,to:sample},access,grants);
 const grids=r.spatial.data.grids as any[],page=screenDemands(r.contextId,1,100,access,grants);const active=page.items.find(x=>grids.some(g=>g.id===x.adminGridCode))?.adminGridCode;
 assert.ok(active);const empty=grids.find(g=>!page.items.some(x=>x.adminGridCode===g.id));assert.ok(empty);const c=screenCompare(r.contextId,active+','+empty.id,access,grants);assert.ok(c.rows.length>0);assert.ok(c.rows.every(row=>row.values[1].count===0));
});
test('真实停供详情与图层使用相同事件和版本，只返回授权的历史与关联证据', async () => {
  const originalGet = pool.getConnection;
  const originalQuery = pool.query;
  const date = '2026-10-21';
  const grid = '420502001';
  const event = {
    shutdown_id: 'EV1', enterprise_code: 'E', enterprise_name: '验收水务',
    business_type: 'water', shutdown_type: 'planned', planned_start_time: `${date}T00:00:00Z`,
    planned_end_time: `${date}T10:00:00Z`, admin_grid_codes: JSON.stringify([grid]),
    approval_status: 'approved', emergency_plan: '启用应急供水', affected_households: 18,
    received_at: `${date}T11:00:00Z`, source_version: 2, source_revision: 'published-2',
  };
  const past = { ...event, shutdown_id: 'PAST', planned_start_time: '2026-10-19T01:00:00Z', planned_end_time: '2026-10-19T05:00:00Z' };
  const outside = { ...event, shutdown_id: 'OUTSIDE', admin_grid_codes: JSON.stringify([grid, '420503001']) };
  const privatePast = { ...past, enterprise_code: 'OTHER', shutdown_id: 'PRIVATE-PAST' };
  const ctx = { ...access, rules: [{ kind: 'restricted', enterpriseCodes: ['E'], districtCodes: ['420502'] }] };
  const grants = ['statistics.read', 'dashboard.read', 'complaint.read', 'shutdown.read', 'grid.read', 'heatmap.read'];
  const relationQueries: unknown[][] = [];
  const snapshotRow = {
    source_system: '宜接就办', source_id: 'SOURCE-1', complaint_id: 'C1', complaint_no: 'ORDER-1',
    enterprise_code: 'E', district_code: '420502', business_type: 'water', admin_grid_code: grid,
    major_category_code: 'w08', source_reported_at: `${date}T02:00:00Z`,
  };
  (pool as any).getConnection = async () => ({
    query: async (sql: string) => sql.includes('from complaint c') ? [[snapshotRow, {
      ...snapshotRow, source_id: 'SOURCE-2', complaint_id: 'C2', complaint_no: 'ORDER-2',
      source_reported_at: `${date}T10:00:01Z`,
    }], []] : [[], []], rollback: async () => {}, release: () => {},
  });
  (pool as any).query = async (sql: string, args: unknown[]) => {
    if (sql.includes('from shutdown_application')) return [[event, past, outside, privatePast], []];
    if (sql.includes('order by c.complaint_id limit 10001')) {
      assert.match(sql, /c\.enterprise_code in \(\?\).*c\.district_code in \(\?\)/);
      relationQueries.push(args);
      return [[{ id: 'C1', type: 'w08', gridId: grid, occurredAt: `${date}T02:00:00Z` }], []];
    }
    return [[], []];
  };
  try {
    const summary = await screenBootstrap({ from: date, to: date }, ctx, grants);
    assert.equal(summary.source.shutdownLayerSource, 'table');
    assert.deepEqual(summary.spatial.data.events.map((row: any) => row.id), ['EV1']);
    await assert.rejects(() => screenEvent(summary.contextId, 'OUTSIDE', ctx, grants), /事件不存在/);
    await assert.rejects(() => screenEvent(summary.contextId, 'EV1', ctx, grants.filter((x) => x !== 'shutdown.read')), /无权限/);
    event.source_version = 3;
    await assert.rejects(() => screenEvent(summary.contextId, 'EV1', ctx, grants), /版本/);
    assert.equal(relationQueries.length, 0);
    event.source_version = 2;
    const detail = await screenEvent(summary.contextId, 'EV1', ctx, grants);
    assert.equal(detail.event.plan, '启用应急供水');
    assert.equal(detail.history[0].revision, 2);
    assert.deepEqual(detail.gridHistory?.map((row) => row.id), ['PAST']);
    assert.deepEqual(detail.relatedDemands.items.map((row) => row.id), ['C1']);
    assert.deepEqual(relationQueries[0].slice(0, 5), ['E', '420502', '宜接就办', 'water', grid]);

    const masked = await screenEvent(summary.contextId, 'EV1', ctx, grants.filter((x) => x !== 'heatmap.read'));
    assert.deepEqual(masked.event.gridIds, []);
    assert.deepEqual(masked.gridHistory, []);
    assert.equal(masked.relatedDemands.items[0].gridId, null);
    assert.deepEqual(relationQueries[1].slice(0, 5), relationQueries[0].slice(0, 5));

    const app = express();
    app.use((req, _res, next) => {
      req.accessContext = req.get('x-test-scope') === 'all' ? access : ctx;
      req.user = {
        id: ctx.userId, username: 'test-user', roles: ctx.roles,
        permissionCodes: req.get('x-no-heatmap') ? grants.filter((code) => code !== 'heatmap.read') : grants,
      };
      next();
    });
    app.use(businessFeaturesRouter);
    app.use(screenRouter);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const failure = err as AppError;
      res.status(failure.status ?? 500).json({ message: failure.message });
    });
    const scopedLayer = await request(app).get('/assessment/shutdown-layer').expect(200);
    assert.deepEqual(scopedLayer.body.data.events.map((row: any) => row.eventId), ['EV1', 'PAST']);
    assert.deepEqual(scopedLayer.body.data.markers.map((row: any) => row.markerId), [`EV1@${grid}`, `PAST@${grid}`]);
    assert.deepEqual(Object.keys(scopedLayer.body.data.gridHistory), [grid]);
    const fullLayer = await request(app).get('/assessment/shutdown-layer').set('x-test-scope', 'all').expect(200);
    assert.equal(fullLayer.body.data.events.length, 4);
    assert.equal(fullLayer.body.data.markers.length, 5);

    const layerVersion = scopedLayer.body.data.events[0].layerVersion;
    assert.match(layerVersion, /^[a-f0-9]{64}$/);
    snapshotRow.complaint_no = 'CHANGED-AFTER-BOOTSTRAP';
    const mapDetail = await request(app).get('/screen/events/EV1').query({contextId: summary.contextId, layerVersion}).expect(200);
    assert.equal(mapDetail.body.data.contextId, summary.contextId);
    assert.equal(mapDetail.body.data.event.layerVersion, layerVersion);
    assert.deepEqual(mapDetail.body.data.relatedDemands.items, [{
      id: 'C1', complaintNo: 'ORDER-1', type: 'w08', occurredAt: `${date}T02:00:00.000Z`, gridId: grid,
    }]);
    assert.equal(mapDetail.body.data.relatedDemands.total, 1);
    assert.equal(relationQueries.length, 2, 'map evidence only uses the captured rows');
    await request(app).get('/screen/events/EV1').query({contextId: summary.contextId, layerVersion: '0'.repeat(64)}).expect(409);
    await request(app).get('/screen/events/EV1').query({contextId: summary.contextId, layerVersion})
      .set('x-no-heatmap', '1').expect(403);
    await request(app).get('/screen/events/EV1').query({contextId: summary.contextId, layerVersion})
      .set('x-test-scope', 'all').expect(404);
    await request(app).get('/screen/events/PAST').query({contextId: summary.contextId, layerVersion}).expect(404);
    const pastCapture = await screenBootstrap({from: '2026-10-19', to: '2026-10-19'}, ctx, grants);
    const pastDetail = await request(app).get('/screen/events/PAST')
      .query({contextId: pastCapture.contextId, layerVersion: scopedLayer.body.data.events[1].layerVersion}).expect(200);
    assert.equal(pastDetail.body.data.relatedDemands.total, 0);
  } finally {
    pool.getConnection = originalGet;
    pool.query = originalQuery;
  }
});

test('真实管线详情继续从申请台账读取版本历史和关联诉求', async () => {
  const originalGet = pool.getConnection;
  const originalQuery = pool.query;
  const date = '2026-10-21';
  const grants = ['statistics.read', 'dashboard.read', 'complaint.read', 'pipeline.read'];
  const event = {
    id: 'PIPE', mode: 'real', kind: 'pipeline', enterpriseId: 'E', districtCode: '420502',
    businessType: 'water', title: '管线改造', startsAt: `${date}T00:00:00Z`, endsAt: `${date}T10:00:00Z`,
    approvalStatus: 'approved', revision: 2, updatedAt: `${date}T11:00:00Z`, gridIds: ['420502001'],
  };
  (pool as any).getConnection = async () => ({ query: async () => [[], []], rollback: async () => {}, release: () => {} });
  (pool as any).query = async (sql: string, args: unknown[]) => {
    if (args?.[0] === 'utility-real') {
      return sql.includes('gqxq_tender_support_history')
        ? [[{ revision: 1, content: { events: [{ ...event, revision: 1 }] } }], []]
        : [[{ revision: event.revision, content: { events: [{ ...event }], deliveries: {} } }], []];
    }
    if (sql.includes('order by c.complaint_id limit 10001'))
      return [[{ id: 'PIPE-C1', type: 'w08', gridId: '420502001', occurredAt: `${date}T02:00:00Z` }], []];
    return [[], []];
  };
  try {
    const summary = await screenBootstrap({ from: date, to: date }, access, grants);
    event.revision++;
    await assert.rejects(() => screenEvent(summary.contextId, 'PIPE', access, grants), /版本/);
    event.revision--;
    const detail = await screenEvent(summary.contextId, 'PIPE', access, grants);
    assert.equal(detail.history[0].revision, 1);
    assert.equal(detail.relatedDemands.total, 1);
    assert.equal(detail.relatedDemands.items[0].gridId, null);
  } finally {
    pool.getConnection = originalGet;
    pool.query = originalQuery;
  }
});

test('停供来源快照校验发布版本并隔离模拟记录', async () => {
  const originalGet = pool.getConnection;
  const originalQuery = pool.query;
  const date = '2026-10-21';
  const grants = ['statistics.read', 'dashboard.read', 'complaint.read', 'shutdown.read', 'grid.read', 'heatmap.read'];
  const source = {
    kind: 'water-stops', dataMode: 'real', sourceKind: 'legacy', sourceApplicationNo: 'SOURCE-1', revision: 'a1',
    changedAt: `${date}T11:00:00Z`, enterprise: { name: '验收水务' }, approvalStatus: '10',
    fields: {
      isReportTingshui: '计划停水', startsAt: `${date}T00:00:00Z`, endsAt: `${date}T10:00:00Z`,
      plan: '上游发布预案', tingshuiRange: [{ latLog: '111.25,30.65;111.35,30.65;111.35,30.75;111.25,30.75' }],
    },
  };
  (pool as any).getConnection = async () => ({ query: async () => [[], []], rollback: async () => {}, release: () => {} });
  (pool as any).query = async (sql: string) => {
    if (sql.includes("where store_key = 'utility-feed-real'")) return [[{ content: { sources: [
      { source }, { source: { ...source, dataMode: 'simulation', sourceApplicationNo: 'SIM' } },
    ] } }], []];
    if (sql.includes('select enterprise_code, enterprise_name'))
      return [[{ enterprise_code: 'E', enterprise_name: '验收水务', business_type: 'water' }], []];
    if (sql.includes('select code, name, district_code from admin_grid'))
      return [[{ code: '420502001', name: '验收网格', district_code: '420502' }], []];
    if (sql.includes('select location_lng, location_lat'))
      return [[{ location_lng: 111.3, location_lat: 30.7, admin_grid_code: '420502001' }], []];
    return [[], []];
  };
  try {
    const summary = await screenBootstrap({ from: date, to: date }, access, grants);
    assert.deepEqual(summary.spatial.data.events.map((row: any) => row.id), ['SOURCE-1']);
    assert.equal(summary.source.shutdownLayerSource, 'snapshot');
    source.revision = 'a2';
    await assert.rejects(() => screenEvent(summary.contextId, 'SOURCE-1', access, grants), /版本/);
    source.revision = 'a1';
    const detail = await screenEvent(summary.contextId, 'SOURCE-1', access, grants);
    assert.equal(detail.event.plan, '上游发布预案');
    assert.equal('detailSource' in detail && detail.detailSource, 'snapshot');
    assert.equal('sourceRevision' in detail.history[0] && detail.history[0].sourceRevision, 'a1');
    assert.equal(detail.history[0].updatedAt, new Date(source.changedAt).toISOString());
  } finally {
    pool.getConnection = originalGet;
    pool.query = originalQuery;
  }
});
test('未知维度的汇总编码与全局筛选、明细下钻一致',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query,to=shanghaiToday();const all:any={...access,rules:[{kind:'all'}]};
 poolAny.getConnection=async()=>({query:async(sql:string)=>sql.includes('from complaint c')?[[{source_system:'宜接就办',source_id:'R1',complaint_id:'C1',enterprise_code:null,district_code:null,business_type:'water',source_reported_at:new Date(to+'T03:00:00Z'),major_category_code:null,admin_grid_code:null,community_code:null}],[]]:[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read'];const r=await screenBootstrap({from:to,to,districtCode:'__missing__',enterpriseCode:'__missing__',adminGridCode:'__missing__',communityCode:'__missing__',categoryCode:'__missing__'},all,grants);assert.equal(r.summary.total,1);const page=screenDemands(r.contextId,1,20,all,grants,{districtCode:'__missing__',enterpriseCode:'__missing__',adminGridCode:'__missing__',communityCode:'__missing__',categoryCode:'__missing__'});assert.equal(page.total,1);assert.equal(r.charts.category[0].code,'__missing__');}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('上下文创建后撤销网格权限立即遮盖事件与诉求网格',async()=>{
 const to=shanghaiToday(),allGrants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:to.slice(0,7)+'-01',to},access,allGrants);const event=r.spatial.data.events[0] as any;
 const reduced=allGrants.filter(x=>x!=='heatmap.read');const detail=await screenEvent(r.contextId,event.id,access,reduced);assert.deepEqual(detail.event.gridIds,[]);const page=screenDemands(r.contextId,1,20,access,reduced);assert.ok(page.items.every(x=>x.adminGridCode===null));
});
test('预警与历史五季、月度、网格和往年Top3证据与摘要件数一致',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','enterprise.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 const checks:any[]=[];for(const w of r.warnings.data.items)checks.push([w.evidenceKey,w.count]);for(const t of r.top3.data.items)checks.push([t.evidenceKey,t.count]);for(const s of r.research.data.seasons){for(const y of s.years)checks.push([y.evidenceKey,y.count]);for(const m of s.months){checks.push([m.currentEvidenceKey,m.currentCount],[m.previousEvidenceKey,m.previousCount]);}for(const g of s.topGrids)checks.push([g.currentEvidenceKey,g.count],[g.previousEvidenceKey,g.previousCount]);}
 assert.ok(checks.length>10);for(const [key,count] of checks){assert.equal(typeof key,'string');const e=screenEvidence(r.contextId,key,1,100,access,grants);assert.equal(e.total,count);}
 const first=checks[0][0];assert.throws(()=>screenEvidence(r.contextId,first,1,10,{...access,userId:'other'},grants),/不存在/);assert.throws(()=>screenEvidence(r.contextId,first,1,10,access,['statistics.read','dashboard.read']),/权限/);
});
test('模拟热力按含首尾天数和模拟系数计算并保留零值网格',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);assert.equal(r.heat.state,'available');assert.equal(r.heat.data.days,10);assert.deepEqual(r.heat.data.thresholds,[0.3,1,3,10,30]);assert.equal(r.heat.data.ruleVersion,'simulation-only');assert.equal(r.heat.data.grids.length,r.spatial.data.grids.length);assert.equal(r.heat.data.grids.reduce((n,g)=>n+g.count,0),r.summary.total);assert.ok(r.heat.data.grids.every(g=>g.level!==null));
 const denied=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants.filter(x=>x!=='heatmap.read'));assert.equal(denied.heat.state,'unavailable');assert.equal(denied.heat.data.days,null);assert.deepEqual(denied.heat.data.grids,[]);
});
test('模拟事件按明确标注的行业、网格、时间和问题类型给出可复核的关联',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 let found=false;for(const e of r.spatial.data.events){const detail=await screenEvent(r.contextId,e.id,access,grants);assert.match(detail.relatedDemands.reason,/模拟/);if(detail.relatedDemands.total&&detail.relatedDemands.total>0){found=true;assert.equal(detail.relatedDemands.items.length,detail.relatedDemands.total);const row=detail.relatedDemands.items[0] as any;assert.ok(row.type&&row.occurredAt&&row.gridId);assert.match(detail.relatedDemands.reason,/筛选交集/);break;}}assert.equal(found,true);
});
import {screenContexts} from '../src/services/screenContext';
test('专题证据分页、范围变化、空间权限回收及过期均受控',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 const warning=r.warnings.data.items.find(x=>(x.count??0)>1)!;assert.ok(warning?.evidenceKey);const first=screenEvidence(r.contextId,warning.evidenceKey,1,1,access,grants);assert.equal(first.items.length,1);assert.equal(first.total,warning.count);
 assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,0,20,access,grants),/页码/);assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,1,20,{...access,scopeVersion:2},grants),/不存在/);
 const grid=r.research.data.seasons.flatMap(s=>s.topGrids)[0];assert.ok(grid?.currentEvidenceKey);assert.throws(()=>screenEvidence(r.contextId,grid.currentEvidenceKey,1,20,access,grants.filter(x=>x!=='heatmap.read')),/权限/);
 const item=screenContexts.get(r.contextId)!;item.expires=Date.now()-1;assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,1,20,access,grants),/过期/);
});
test('正式预警无发布证据时返回空证据原因，不伪造零值',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query,to=shanghaiToday();poolAny.getConnection=async()=>({query:async()=>[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read'];const r=await screenBootstrap({from:to,to},access,grants);const e=screenEvidence(r.contextId,r.warnings.data.items[0].evidenceKey,1,20,access,grants);assert.equal(e.state,'unavailable');assert.equal(e.total,null);assert.ok(e.reason);assert.deepEqual(e.items,[]);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('预警携带模拟规则元数据，证据规则版本与摘要一致',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);for(const w of r.warnings.data.items){assert.ok(w.threshold&&w.days);assert.equal(typeof w.enabled,'boolean');assert.equal(w.ruleVersion,'simulation-warning-v1');const e=screenEvidence(r.contextId,w.evidenceKey,1,1,access,grants);assert.equal(e.ruleVersion,w.ruleVersion);}
});
