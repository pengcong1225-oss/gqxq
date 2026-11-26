import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

test('大屏按当前行业的正式规则取色，并用同一筛选快照打开正式网格诉求', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('.', import.meta.url)),
    configFile: false,
    optimizeDeps: {noDiscovery: true},
    server: {middlewareMode: true, ws: false},
    appType: 'custom',
  });
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = {pathname: '/'};
  const requests = [];
  const data = {
    state: 'partial',
    reason: '1 件诉求缺少可核验的正式行政网格关联',
    data: {ruleVersion:'HEAT-WATER',thresholds:[30,150,300,600,900],grids:[
      {code:'GRID-1',count:301,level:'orange',administrativeCommunityName:'金月行政社区',communities:['金月住宅小区']},
      {code:'GRID-2',count:0,level:'green',administrativeCommunityName:null,communities:['另一住宅小区']},
    ]},
  };
  const unavailable = {state:'unavailable',reason:'无已发布热力规则',data:{ruleVersion:null,thresholds:null,grids:[]}};
  globalThis.fetch = async (input) => {
    const url = new URL(input, 'http://local.test');
    const params = Object.fromEntries(url.searchParams);
    requests.push(params);
    const payload = url.pathname.endsWith('/demands')
      ? {page:1,size:10,total:301,items:[]}
      : {
        contextId: params.businessType ?? 'all',
        window: {from:params.from,to:params.to},
        summary: {unlocated:0},
        charts: {adminGrid:[],category:[],district:[],enterprise:[],community:[]},
        heat: params.businessType === 'water' ? data : unavailable,
      };
    return Response.json({code:200,data:payload});
  };
  try {
    const {fetchBundle,pickIndustryBundle,seedRealSession} = await vite.ssrLoadModule('/src/stats/realSource.ts');
    const {fetchDemands} = await vite.ssrLoadModule('/src/stats/api.ts');
    const {formalGridCommunityLabel,formalHeatColor,HEAT_COLORS} = await vite.ssrLoadModule('/src/components/Map/map2d/administrativeHeat.ts');
    seedRealSession('test-token');
    const filters = {period:'30d',industry:'WATER',window:{from:'2026-10-28',to:'2026-11-26'},categoryCode:'w02'};
    const bundle = await fetchBundle(filters);
    const selected = pickIndustryBundle(bundle, filters.industry).heat;
    assert.deepEqual(selected.data.grids.map(grid => formalGridCommunityLabel(grid.administrativeCommunityName)),
      ['行政社区 金月行政社区','行政社区名称未配置']);
    assert.equal(formalHeatColor(selected, selected.data.grids[0].level, true), HEAT_COLORS.orange);
    assert.equal(formalHeatColor(selected, 'orange', false), undefined);
    assert.equal(formalHeatColor(pickIndustryBundle(bundle, 'GAS').heat, 'orange', true), undefined);
    assert.equal(formalHeatColor({...data,data:{...data.data,ruleVersion:'simulation-only'}}, 'orange', true), undefined);
    const result = await fetchDemands({title:'正式网格',source:'地图',filters,period:'30d',industry:'WATER',gridCode:'GRID-1',formalHeatGrid:true,page:1,pageSize:10});
    assert.equal(result.data.total, 301);
    assert.ok(requests.slice(0, 3).every(req => req.categoryCode === 'w02' && req.from === '2026-10-28' && req.to === '2026-11-26'));
    assert.deepEqual(requests.at(-1), {contextId:'water',page:'1',size:'10',heatGridCode:'GRID-1'});
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    await vite.close();
  }
});
