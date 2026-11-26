import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';
import type { ComplaintDetail, CorrectionItem, LocationClueView } from '../src/types/api';

let vite: ViteDevServer;
let dom: JSDOM;
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
let Route: typeof import('react-router-dom').Route;
let Routes: typeof import('react-router-dom').Routes;

before(async () => {
  // The SPA selects its login storage when modules load. Keep the storage and
  // interaction queries on the same window for the lifetime of this suite.
  installDom();
  // React Router loads ReactDOM, which detects input-event support at import time.
  ({ MemoryRouter, Route, Routes } = await import('react-router-dom'));
  const webRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  vite = await createServer({
    root: webRoot,
    cacheDir: path.join(webRoot, 'node_modules', '.vite-workflow-test'),
    appType: 'custom',
    // Avoid colliding with the user's persistent 5173 preview / its HMR websocket.
    server: { port: 0, middlewareMode: true, hmr: false },
  });
});

after(async () => {
  try { await vite?.close(); } finally { dom?.window.close(); }
});

function renderWithRouter(node: React.ReactNode, route: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      {node}
    </MemoryRouter>
  );
}

test('总账的来源分类补齐先显示预览，再提交该批确认摘要', async () => {
  const { default: SourceCategoryBackfillDialog } = await vite.ssrLoadModule('/src/components/SourceCategoryBackfillDialog.tsx');
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const { cleanup, fireEvent, render, within } = await import('@testing-library/react');
  const originalUser = useAppStore.getState().userInfo;
  const originalAdapter = request.defaults.adapter;
  const calls: { url: string; data?: string }[] = [];
  const digest = 'a'.repeat(64);
  let refreshed = 0;
  useAppStore.setState({ userInfo: { userId: 'fx', username: 'fx', roles: ['admin'], permissions: ['complaint.correct'] } });
  request.defaults.adapter = async (config: { url: string; data?: string }) => {
    calls.push({ url: config.url, data: config.data });
    const data = config.url.endsWith('/preview') ? {
      digest, dictionaryVersion: '29', candidates: 1, remaining: 0,
      skipped: { manualDecision: 0, analysisRecord: 0, noExactSourceCategory: 0 },
      byCategory: [{ majorCode: 'water_service', minorCode: 'w11', minorName: '农村停水问题', count: 1 }],
    } : { revised: 1, remaining: 0, dictionaryVersion: '29' };
    return { data: { code: 200, data }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const ui = render(<SourceCategoryBackfillDialog onApplied={() => { refreshed++; }} />);
  try {
    const page = within(document.body);
    fireEvent.click(page.getByRole('button', { name: '补齐来源分类' }));
    await page.findByText('农村停水问题');
    assert.deepEqual(calls.map(call => call.url), ['/categories/source-backfill/preview']);
    fireEvent.click(page.getByRole('button', { name: '确认补齐 1 件' }));
    await page.findByText('已补齐 1 件来源分类');
    assert.deepEqual(calls.map(call => call.url), ['/categories/source-backfill/preview', '/categories/source-backfill/apply']);
    assert.equal(JSON.parse(calls[1].data!).digest, digest);
    assert.equal(refreshed, 1);
  } finally {
    ui.unmount();
    cleanup();
    request.defaults.adapter = originalAdapter;
    useAppStore.setState({ userInfo: originalUser });
  }
});

test('诉求核验页用覆盖全部字段的名称呈现', async () => {
  const { default: AddressCorrection } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const html = renderWithRouter(<AddressCorrection />, '/address-correction');

  assert.match(html, />诉求核验</);
  assert.match(html, /待核验诉求/);
  assert.doesNotMatch(html, />纠偏待办</);
});

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
    HTMLBodyElement: dom.window.HTMLBodyElement, HTMLHtmlElement: dom.window.HTMLHtmlElement,
    ShadowRoot: dom.window.ShadowRoot, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof dom.window.matchMedia;
  const computedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => computedStyle(element)) as typeof dom.window.getComputedStyle;
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true, value: dom.window.getComputedStyle });
}

test('待纠偏字段在抽屉中直接呈现可编辑值和逐项保存入口', async () => {
  const module = await vite.ssrLoadModule('/src/components/InlineCorrectionField.tsx').catch(() => ({}));
  const InlineCorrectionField = module.default as React.ComponentType<{
    item: CorrectionItem;
    enterpriseOptions: [];
    enterpriseLoading: boolean;
    disabled: boolean;
    saving: boolean;
    onSearchEnterprises: (keyword: string) => void;
    onSave: (value: string, basis: string) => void;
  }> | undefined;
  assert.equal(typeof InlineCorrectionField, 'function');
  if (!InlineCorrectionField) return;
  const item: CorrectionItem = {
    id: 1, correctionId: 'COR-1', complaintId: 'CPL-1', assignmentId: null,
    hasDispatch: false, fieldName: 'district', fieldLabel: '归属区域',
    oldValue: '夷陵区', newValue: null, basis: null, status: 'pending',
    statusName: '待纠偏', confirmerId: null, confirmerName: null,
    confirmedAt: null, createdAt: null,
  };
  const html = renderToStaticMarkup(<InlineCorrectionField
    item={item}
    enterpriseOptions={[]}
    enterpriseLoading={false}
    disabled={false}
    saving={false}
    onSearchEnterprises={() => {}}
    onSave={() => {}}
  />);
  assert.match(html, /aria-label="纠偏后取值：归属区域"/);
  assert.match(html, /value="夷陵区"/);
  assert.match(html, />保存该项</);
});

test('长文本纠偏项直接提供多行输入而非单行框', async () => {
  const { default: InlineCorrectionField } = await vite.ssrLoadModule('/src/components/InlineCorrectionField.tsx');
  const item: CorrectionItem = {
    id: 2, correctionId: 'COR-2', complaintId: 'CPL-1', assignmentId: null,
    hasDispatch: false, fieldName: 'disposal_result', fieldLabel: '企业处置结果',
    oldValue: null, newValue: null, basis: null, status: 'pending',
    statusName: '待纠偏', confirmerId: null, confirmerName: null,
    confirmedAt: null, createdAt: null,
  };
  const html = renderToStaticMarkup(<InlineCorrectionField
    item={item} enterpriseOptions={[]} enterpriseLoading={false}
    disabled={false} saving={false} onSearchEnterprises={() => {}} onSave={() => {}}
  />);
  assert.match(html, /<textarea[^>]*aria-label="纠偏后取值：企业处置结果"/);
});

test('选择高德地图：WGS84↔GCJ-02 转换可用且旧选点组件已删除', async () => {
  const module = await vite.ssrLoadModule('/src/components/amapSdk.ts');
  const wgs84ToGcj02 = module.wgs84ToGcj02 as (lng: number, lat: number) => [number, number];
  const gcj02ToWgs84 = module.gcj02ToWgs84 as (lng: number, lat: number) => [number, number];
  const ringToGcj02 = module.ringToGcj02 as (ring: number[][]) => [number, number][];
  const [gcjLng, gcjLat] = wgs84ToGcj02(111.286, 30.692);
  assert.ok(Math.abs(gcjLng - 111.286) > 0.0005, '宜昌坐标应存在 GCJ-02 偏移');
  assert.ok(Math.abs(gcjLat - 30.692) > 0.0005, '宜昌坐标应存在 GCJ-02 偏移');
  const [backLng, backLat] = gcj02ToWgs84(gcjLng, gcjLat);
  assert.ok(Math.abs(backLng - 111.286) < 1e-4 && Math.abs(backLat - 30.692) < 1e-4, '往返误差应在米级以内');
  assert.deepEqual(ringToGcj02([[111.286, 30.692]]), [[gcjLng, gcjLat]]);
  // 旧选点组件已下线：模块不再存在
  await assert.rejects(() => vite.ssrLoadModule('/src/components/TiandituLocationPicker.tsx'));
});

test('敏感交办工作台同时提供规则命中诉求与交办记录', async () => {
  const dispatchModule = await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');
  const { default: DispatchOrders } = dispatchModule;
  const html = renderWithRouter(<DispatchOrders />, '/dispatch');

  assert.match(html, />规则命中诉求</);
  assert.match(html, />交办记录</);
  assert.match(html, /搜索诉求编号、标题或内容/);
});

test('规则命中诉求查询始终带服务端敏感标记筛选', async () => {
  const dispatchModule = await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');
  const buildParams = dispatchModule.buildSensitiveComplaintParams as
    | ((page: number, size: number, keyword?: string) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof buildParams, 'function');
  assert.deepEqual(buildParams?.(2, 20, '爆管'), {
    page: 2,
    size: 20,
    keyword: '爆管',
    isSensitive: 1,
  });
});

test('敏感词管理展示真实维护与安全重扫入口', async () => {
  const dictModule = await vite.ssrLoadModule('/src/views/DictManager.tsx');
  const SensitiveWordManager = dictModule.SensitiveWordManager as React.ComponentType | undefined;

  assert.equal(typeof SensitiveWordManager, 'function');
  const html = renderWithRouter(<SensitiveWordManager />, '/dicts');
  assert.match(html, />新增敏感词</);
  assert.match(html, /当前敏感诉求/);
  assert.match(html, /历史证据行数/);
  assert.match(html, />预览历史重扫</);
  assert.doesNotMatch(html, /演示数据/);
});

test('存量地址候选先预览，取消不执行，确认后才调用执行 API', { concurrency: false }, async () => {
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { Modal, message } = await import('antd');
  const originalSuccess = message.success;
  message.success = (() => Promise.resolve()) as typeof message.success;
  const { AddressCandidateBackfillControls, addressBackfillOutcome } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  assert.equal(addressBackfillOutcome({ total: 4, failed: 0, errors: { scan: 0, row: 0, audit: 0 } }), 'success');
  assert.equal(addressBackfillOutcome({ total: 4, failed: 1, errors: { scan: 0, row: 1, audit: 0 } }), 'partial');
  assert.equal(addressBackfillOutcome({ total: 4, failed: 4, errors: { scan: 0, row: 2, audit: 2 } }), 'failed');
  const preview = async () => ({ total: 4, extractable: 3, noCandidate: 1, created: 2, updated: 0, unchanged: 1, removed: 0, failed: 0,
    townshipClues: 1, settlementClues: 2, conflicts: 1, unresolved: 1, clueCreated: 2, clueUpdated: 0, clueUnchanged: 1, clueRemoved: 0, recomputedForVersion: 3,
    errors: { scan: 0, row: 0, audit: 0 },
    samples: [{ item: 1, action: 'create', category: 'address' as const, value: '[已脱敏]' as const }] });
  const execute = async () => ({ total: 4, extractable: 3, noCandidate: 1, created: 0, updated: 0, unchanged: 4, removed: 0, failed: 0,
    townshipClues: 1, settlementClues: 2, conflicts: 1, unresolved: 1, clueCreated: 2, clueUpdated: 0, clueUnchanged: 1, clueRemoved: 0, recomputedForVersion: 3,
    errors: { scan: 0, row: 0, audit: 0 } });
  let executeCalls = 0;
  const runExecute = async () => { executeCalls++; return execute(); };
  const ui = render(<AddressCandidateBackfillControls adminAccess={{ can: true, tip: '' }} previewApi={preview} executeApi={runExecute} />);
  try {
    const executeButton = screen.getByRole('button', { name: '确认执行存量补提取' });
    assert.equal((executeButton as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole('button', { name: '预览存量地址候选' }));
    await screen.findByText(/预计写入\/移除/);
    assert.equal((executeButton as HTMLButtonElement).disabled, false);
    assert.match(ui.container.textContent ?? '', /乡镇线索/);
    assert.match(ui.container.textContent ?? '', /村社区小区线索/);
    assert.match(ui.container.textContent ?? '', /位置冲突/);
    assert.match(ui.container.textContent ?? '', /版本重算\s*3/);
    assert.match(ui.container.textContent ?? '', /\[已脱敏\]/);
    assert.doesNotMatch(ui.container.textContent ?? '', /示例家园18号1301|13800000000/);
    const confirmName = '确认执行存量地址候选补提取？';
    fireEvent.click(executeButton);
    const previewDialog = within(await screen.findByRole('dialog', { name: confirmName }));
    assert.ok(previewDialog.getByText(/位置线索预计新增\/更新\/移除 2 条/));
    fireEvent.click(previewDialog.getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => assert.ok(!screen.queryByRole('dialog', { name: confirmName }), '取消后关闭确认框'));
    assert.equal(executeCalls, 0);
    fireEvent.click(executeButton);
    const executeDialog = within(await screen.findByRole('dialog', { name: confirmName }));
    fireEvent.click(executeDialog.getByRole('button', { name: '确认执行', exact: true }));
    await waitFor(() => assert.equal(executeCalls, 1));
    assert.ok(await screen.findByText(/位置线索新增 2/));
    assert.match(ui.container.textContent ?? '', /地址候选新增 0，更新 0，未变 4，移除 0/);
    await waitFor(() => assert.ok(!screen.queryByRole('dialog', { name: confirmName }), '执行后关闭确认框'));
  } finally {
    await act(async () => Modal.destroyAll());
    ui.unmount(); cleanup(); message.success = originalSuccess;
  }
});

test('地址候选分开展示来源与候选，待处理时经办点击才允许填入', async () => {
  const module = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const Candidate = module.AddressCandidateCorrection as React.ComponentType<{
    sourceAddress: string | null; candidate: { value: string; evidence: string; sourceField: 'title' | 'content'; extractorVersion: string } | null;
    pending: boolean; locationConflict?: boolean; onUse: () => void;
  }>;
  const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
  let copies = 0;
  const candidate = { value: '点军区联棚乡示例小区18号1301', evidence: '点军区联棚乡示例小区18号1301', sourceField: 'content' as const, extractorVersion: 'address-extract.v1' };
  const ui = render(<Candidate sourceAddress="来源地址原值" candidate={candidate} pending onUse={() => copies++} />);
  try {
    assert.match(ui.container.textContent ?? '', /来源地址原值/);
    assert.match(ui.container.textContent ?? '', /待核实/);
    assert.match(ui.container.textContent ?? '', /address-extract\.v1/);
    assert.equal(copies, 0);
    fireEvent.click(screen.getByRole('button', { name: '填入待核实地址' }));
    assert.equal(copies, 1);
    ui.rerender(<Candidate sourceAddress="来源地址原值" candidate={candidate} pending={false} onUse={() => copies++} />);
    assert.equal(screen.queryByRole('button', { name: '填入待核实地址' }), null);
    assert.equal(copies, 1);
    ui.rerender(<Candidate sourceAddress="来源地址原值" candidate={candidate} pending locationConflict onUse={() => copies++} />);
    assert.equal(screen.queryByRole('button', { name: '填入待核实地址' }), null);
    assert.equal(copies, 1);
  } finally { ui.unmount(); cleanup(); }
});

test('地址纠偏证据组合在存在位置冲突时保留线索且不允许带入候选', async () => {
  const module = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const Panel = module.AddressLocationEvidence as React.ComponentType<{
    sourceAddress: string | null;
    candidate: { value: string; evidence: string; sourceField: 'title' | 'content'; extractorVersion: string } | null;
    pending: boolean;
    conflict: boolean;
    clues: LocationClueView[];
    onUse: () => void;
  }> | undefined;
  assert.equal(typeof Panel, 'function');
  const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
  let copies = 0;
  const clue: LocationClueView = {
    kind: 'settlement', value: '样例社区', evidence: '样例社区', sourceField: 'content',
    townshipCode: null, districtCode: null, districtName: null,
    parentMatch: 'unresolved', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923',
  };
  const ui = render(<Panel sourceAddress="来源地址" candidate={{
    value: '联棚乡示例家园18号1301', evidence: '联棚乡示例家园18号1301', sourceField: 'content', extractorVersion: 'address-extract.v2',
  }} pending conflict clues={[clue]} onUse={() => copies++} />);
  try {
    assert.match(ui.container.textContent ?? '', /示例家园18号1301/);
    assert.match(ui.container.textContent ?? '', /样例社区/);
    assert.match(ui.container.textContent ?? '', /位置冲突/);
    assert.equal(screen.queryByRole('button', { name: '填入待核实地址' }), null);
    fireEvent.click(screen.getByText('样例社区'));
    assert.equal(copies, 0);
  } finally { ui.unmount(); cleanup(); }
});

test('位置线索只读展示证据、父级及冲突，不提供地址带入操作', async () => {
  const { render, screen, cleanup } = await import('@testing-library/react');
  const { default: LocationClues } = await vite.ssrLoadModule('/src/components/LocationClues.tsx');
  const clues: LocationClueView[] = [{
    kind: 'township', value: '联棚乡', evidence: '联棚乡', sourceField: 'content',
    townshipCode: '420504202', districtCode: '420504', districtName: '点军区',
    parentMatch: 'unique_township', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923',
  }, {
    kind: 'settlement', value: '示例花园', evidence: '示例花园', sourceField: 'content',
    townshipCode: null, districtCode: null, districtName: null,
    parentMatch: 'unresolved', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923',
  }];
  const ui = render(<LocationClues clues={[clues[0]]} conflict={false} />);
  try {
    assert.match(ui.container.textContent ?? '', /待核实位置线索/);
    assert.match(ui.container.textContent ?? '', /点军区/);
    assert.match(ui.container.textContent ?? '', /证据：联棚乡/);
    assert.doesNotMatch(ui.container.textContent ?? '', /位置冲突/);
    assert.equal(screen.queryByRole('button', { name: /带入|填入/ }), null);
    ui.rerender(<LocationClues clues={clues} conflict />);
    assert.match(ui.container.textContent ?? '', /位置冲突/);
    assert.equal(screen.queryByRole('button', { name: /带入|填入/ }), null);
  } finally { ui.unmount(); cleanup(); }
});

test('敏感词规则分值明确为固定规则分值且空词表不可用', async () => {
  const module = await vite.ssrLoadModule('/src/views/ComplaintDetail.tsx');
  const label = module.sensitiveRuleScoreLabel as ((confidence: number | null, version: string | null) => string) | undefined;
  assert.equal(typeof label, 'function');
  assert.equal(label?.(0.72, 'classify.v1+sensitive_word/3'), '敏感词规则分值：未命中固定 72%（非地址准确度）');
  assert.equal(label?.(0.72, 'classify.v1+sensitive_word/0'), '敏感词规则分值：词表为空，判定不可用');
  assert.equal(label?.(0.6, 'historical-unknown'), '敏感词规则分值：历史数值 60%（规则口径不可确认）');
});

test('旧诉求的位置项不匹配新选择或仍在加载时不可用于候选采用', async () => {
  const module = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const matches = module.positionItemsMatchSelection as ((loading: boolean, itemsComplaintId: string | null, selectedId: string | null) => boolean) | undefined;
  assert.equal(typeof matches, 'function');
  assert.equal(matches?.(false, 'A', 'B'), false);
  assert.equal(matches?.(true, 'B', 'B'), false);
  assert.equal(matches?.(false, 'B', 'B'), true);
});

const locationDetailFixture: ComplaintDetail = {
  id: 1, complaintId: 'CPL-TEST', complaintNo: 'CS-TEST', title: '虚构位置核查',
  sourceSystem: null, sourceId: null, sourceChannel: null,
  businessTypeCode: 'gas', businessTypeName: '燃气', complaintTypeCode: 'complaint', complaintTypeName: '投诉',
  urgencyLevelCode: 'normal', urgencyLevelName: '普通', districtCode: null, districtName: null,
  enterpriseCode: null, enterpriseName: null, isSensitive: false, sensitiveKeywords: [],
  correctionStatusCode: 'pending', correctionStatusName: '待纠偏', correctionConfidence: null,
  sourceEventStatusCode: 'unknown', sourceEventStatusName: '未接入', overtimeFlag: null,
  overtimeFlagName: '无时效信息', supervisionStatusCode: 'none', supervisionStatusName: '未交办',
  reportingStatusCode: 'not_started', reportingStatusName: '未开始', closedInSystem: false,
  activeDispatchId: null, activeDispatchStatusCode: null, activeDispatchStatusName: null,
  legacyStatus: 'pending', sourceReportedAt: null, receivedAt: null, createdAt: null,
  content: '联棚乡示例家园18号1301，样例社区20号1301', address: '来源地址原值',
  correctedAddress: null, locationLng: null, locationLat: null, ruleConfidence: null, ruleVersion: null,
  addressCandidate: {
    value: '联棚乡示例家园18号1301', evidence: '联棚乡示例家园18号1301', sourceField: 'content',
    extractorVersion: 'address-extract.v2', districtCode: null, parentMatch: null, snapshotId: null,
  },
  locationClues: [{
    kind: 'settlement', value: '样例社区20号1301', evidence: '样例社区20号1301', sourceField: 'content',
    townshipCode: null, districtCode: null, districtName: null, parentMatch: 'unresolved',
    extractorVersion: 'location-extract.v2', snapshotId: 'test-snapshot',
  }],
  locationConflict: true, sourcePayload: null, sourcePayloadHash: null, sourceUpdatedAt: null,
  responsibleMatchedAt: null, responsibleMatchReason: null, closedAt: null, closedBy: null,
  closedByName: null, closedBasis: null, analysisIncluded: false, analysisRecordId: null, updatedAt: null,
};

function locationCorrectionFixture(fieldName: string): CorrectionItem {
  return {
    id: fieldName === 'address' ? 1 : fieldName === 'location_lng' ? 2 : 3,
    correctionId: `COR-${fieldName}`, complaintId: 'CPL-TEST', assignmentId: null, hasDispatch: false,
    fieldName, fieldLabel: fieldName, oldValue: fieldName === 'address' ? '来源地址原值' : null,
    newValue: null, basis: null, status: 'pending', statusName: '待纠偏',
    confirmerId: null, confirmerName: null, confirmedAt: null, createdAt: null,
  };
}

test('真实详情页把接口位置冲突传到只读线索区域', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const axiosRequest = request as { defaults: { adapter: unknown } };
  const originalAdapter = axiosRequest.defaults.adapter;
  axiosRequest.defaults.adapter = async (config: { url?: string }) => {
    const responses: Record<string, unknown> = {
      '/complaints/CPL-TEST': locationDetailFixture,
      '/complaints/CPL-TEST/timeline': { content: [], total: 0 },
      '/complaints/CPL-TEST/source-status': { enabled: false, batch: 'G6', message: '未接入' },
    };
    if (!(config.url && config.url in responses)) throw new Error(`Unexpected test API: ${config.url}`);
    return { data: { code: 200, data: responses[config.url] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const { default: ComplaintDetailPage } = await vite.ssrLoadModule('/src/views/ComplaintDetail.tsx');
  const { render, within, cleanup, waitFor } = await import('@testing-library/react');
  const ui = render(<MemoryRouter initialEntries={['/complaints/CPL-TEST']}><Routes>
    <Route path="/complaints/:id" element={<ComplaintDetailPage />} />
  </Routes></MemoryRouter>);
  try {
    const page = within(document.body);
    await waitFor(() => assert.match(ui.container.textContent ?? '', /待核实位置线索.*样例社区20号1301/));
    assert.match(ui.container.textContent ?? '', /位置冲突/);
    assert.equal(page.queryByRole('button', { name: '填入待核实地址' }), null);
  } finally { ui.unmount(); cleanup(); axiosRequest.defaults.adapter = originalAdapter; }
});

test('真实诉求核验抽屉保留冲突原文且不自动采用候选', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const axiosRequest = request as { defaults: { adapter: unknown } };
  const originalAdapter = axiosRequest.defaults.adapter;
  axiosRequest.defaults.adapter = async (config: { url?: string }) => {
    const responses: Record<string, unknown> = {
      '/corrections/pending-complaints': { content: [], total: 0 },
      '/enterprises': { content: [], total: 0 },
      '/complaints/CPL-TEST': locationDetailFixture,
      '/complaints/CPL-TEST/corrections': ['address', 'location_lng', 'location_lat'].map(locationCorrectionFixture),
      '/complaints/CPL-TEST/location-correction-options': { districts: [], adminGrids: [], communities: [] },
    };
    if (!(config.url && config.url in responses)) throw new Error(`Unexpected test API: ${config.url}`);
    return { data: { code: 200, data: responses[config.url] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalUser = useAppStore.getState().userInfo;
  useAppStore.setState({ userInfo: { id: 1, userId: 'tester', username: 'tester', realName: '测试经办', roles: ['handler'], permissions: ['complaint.correct', 'dispatch.create', 'assessment.read'] } });
  const { default: AddressCorrectionPage } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const { render, within, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
  const ui = render(<MemoryRouter initialEntries={['/address-correction?complaintId=CPL-TEST']}>
    <AddressCorrectionPage />
  </MemoryRouter>);
  try {
    const page = within(document.body);
    await waitFor(() => assert.match(document.body.textContent ?? '', /原文区划或候选存在冲突/));
    assert.match(document.body.textContent ?? '', /联棚乡示例家园18号1301，样例社区20号1301/);
    assert.match(document.body.textContent ?? '', /位置核验/);
    const reference = page.getByRole('link', { name: '查看 CIM 行政边界' });
    assert.equal(reference.getAttribute('href'), '/screen/#/accept?cimLevel=sqjcglqy');
    assert.equal(reference.getAttribute('target'), '_blank');
    assert.equal(reference.getAttribute('rel'), 'noopener noreferrer');
    assert.match(document.body.textContent ?? '', /仅显示边界概览/);
    await waitFor(() => assert.equal((page.getByRole('button', { name: '调整位置' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(page.getByRole('button', { name: '调整位置' }));
    assert.equal(page.queryByRole('button', { name: '填入待核实地址' }), null);
    assert.equal((page.getByRole('textbox', { name: '核实后的地址' }) as HTMLInputElement).value, '来源地址原值');
    fireEvent.click(page.getByRole('button', { name: '确认位置', exact: true }));
    await waitFor(() => assert.match(document.body.textContent ?? '', /调整或存在冲突时，请填写核对依据/));
    assert.equal((page.getByRole('textbox', { name: '核实后的地址' }) as HTMLInputElement).value, '来源地址原值');
    useAppStore.setState({ userInfo: { ...useAppStore.getState().userInfo, permissions: ['complaint.correct'] } });
    await page.findByText('当前账号未获 CIM 参考边界查看授权。');
    await waitFor(() => assert.equal(page.queryByRole('link', { name: '查看 CIM 行政边界' }), null));
  } finally {
    ui.unmount(); cleanup(); axiosRequest.defaults.adapter = originalAdapter;
    useAppStore.setState({ userInfo: originalUser });
  }
});

test('CIM 地址参考仅使用有效的有来源 WGS84 位置，并排除区县代表点', async () => {
  const { cimAddressReference } = await vite.ssrLoadModule('/src/utils/cimAddressReference.ts');
  const saved = {
    ...locationDetailFixture, locationLng: 111.30042, locationLat: 30.70052,
    locationCoordinateSystem: 'WGS84', locationCoordinateSource: '高德地址解析（门牌号）',
    citizenName: '测试人名', citizenPhone: '测试号码',
  };
  const { href, hasPoint } = cimAddressReference('/gqxq', saved);
  assert.equal(href, '/gqxq/screen/#/accept?cimLevel=sqjcglqy&lon=111.30042&lat=30.70052');
  assert.equal(hasPoint, true);
  const url = new URL(href, 'https://platform.example.test');
  assert.equal(url.search, '');
  for (const change of [
    { locationLng: null }, { locationLat: null }, { locationLng: 0 },
    { locationLng: Infinity }, { locationLat: 33 },
    { locationCoordinateSystem: 'CGCS2000' }, { locationCoordinateSystem: 'unknown' },
    { locationCoordinateSource: '' }, { locationCoordinateSource: null },
    { locationCoordinateSource: '待纠偏：西陵区区县代表点，非诉求实际发生位置' },
    { locationCoordinateSource: '已人工核验（原近似来源）：DataV行政区中心' },
  ]) {
    assert.deepEqual(cimAddressReference('/gqxq', { ...saved, ...change }), {
      href: '/gqxq/screen/#/accept?cimLevel=sqjcglqy', hasPoint: false,
    });
  }
});


test('规则命中诉求可直接交办，且必须填写处置说明和企业填报截止时间', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalAdapter = request.defaults.adapter;
  const originalUser = useAppStore.getState().userInfo;
  const calls: string[] = [];
  const submissions: Array<{ requirement?: string; deadline?: string }> = [];
  const enterprise = { enterpriseCode: 'E-TEST', enterpriseName: '隔离测试企业' };
  request.defaults.adapter = async (config: { url: string; method: string; data?: string }) => {
    calls.push(config.method + ' ' + config.url);
    if (config.url === '/dispatch/orders' && config.method === 'post') {
      submissions.push(JSON.parse(config.data || '{}'));
      return { data: { code: 200, data: { created: true, order: { assignmentId: 'A-TEST', orderNo: 'JB-TEST' } } }, status: 200, headers: {}, config };
    }
    const responses: Record<string, unknown> = {
      '/complaints': { content: [{ ...locationDetailFixture, ...enterprise, isSensitive: true, sensitiveKeywords: ['爆管'] }], total: 1 },
      '/enterprise-options': [enterprise],
      '/dispatch/orders/A-TEST': { assignmentId: 'A-TEST', orderNo: 'JB-TEST', status: 'processing', sensitiveWords: ['爆管'] },
      '/dispatch/orders/A-TEST/push-logs': { content: [], total: 0 },
      '/dispatch/orders/A-TEST/approval-trace': { content: [], total: 0 },
      '/dispatch/orders/A-TEST/reporting-result': { taskUrl: null, events: [{
        eventId: 'EVENT-TEST', state: 'applied',
        payload: { eventType: 'TASK_SUBMITTED', submissionVersion: 1, enterpriseDisposalResult: { result: '企业已复查并提交整改记录' } },
      }] },
    };
    if (config.url.startsWith('/dicts/')) return { data: { code: 200, data: [] }, status: 200, headers: {}, config };
    if (!(config.url in responses)) throw new Error(`Unexpected test API: ${config.url}`);
    return { data: { code: 200, data: responses[config.url] }, status: 200, headers: {}, config };
  };
  useAppStore.setState({ userInfo: { id: 1, userId: 'tester', username: 'tester', realName: '测试经办', roles: ['handler'], permissions: ['dispatch.create'] } });
  const { default: DispatchOrders } = await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');
  const { render, within, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const ui = render(<MemoryRouter><DispatchOrders /></MemoryRouter>);
  try {
    const page = within(document.body);
    const create = await page.findByRole('button', { name: '创建交办' });
    assert.equal((create as HTMLButtonElement).disabled, false);
    fireEvent.click(create);
    const dialog = await page.findByRole('dialog', { name: '发起交办 · CS-TEST' });
    const form = within(dialog);
    assert.ok(form.getByText('交办企业'));
    assert.equal(calls.some(call => !call.startsWith('get ')), false);
    const requirement = form.getByRole('textbox', { name: '企业处置说明' });
    await act(async () => fireEvent.change(requirement, { target: { value: ' 　\n ' } }));
    await act(async () => fireEvent.click(form.getByRole('button', { name: '创建交办' })));
    await waitFor(() => {
      assert.match(dialog.textContent ?? '', /请填写企业处置说明/);
      assert.match(dialog.textContent ?? '', /请选择企业填报截止时间/);
    }, { timeout: 5000 });
    assert.equal(submissions.length, 0);
    await act(async () => fireEvent.change(requirement, { target: { value: '  核实现场并反馈整改时间  ' } }));
    const deadline = form.getByRole('textbox', { name: '企业填报截止时间' });
    fireEvent.mouseDown(deadline);
    fireEvent.click(deadline);
    const now = await page.findByText('Now', { exact: true });
    await act(async () => fireEvent.click(now));
    await act(async () => fireEvent.click(form.getByRole('button', { name: '创建交办' })));
    await waitFor(() => assert.equal(submissions[0]?.requirement, '核实现场并反馈整改时间'));
    assert.match(submissions[0]?.deadline ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.ok(await page.findByText('企业已复查并提交整改记录'));
  } finally { ui.unmount(); cleanup(); request.defaults.adapter = originalAdapter; useAppStore.setState({ userInfo: originalUser }); }
});


test('固定报告保留默认口径，显式切换采购口径才发送采购模板', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalAdapter = request.defaults.adapter, originalUser = useAppStore.getState().userInfo;
  const submitted: Array<{templateCode:string;query:{comparisonPolicyId:string}}> = [];
  request.defaults.adapter = async (config: {url:string;method:string;data?:string}) => {
    assert.equal(config.url, '/reports');
    let data: unknown = { content: [], hasMore: false, continuation: null };
    if (config.method === 'post') {
      submitted.push(JSON.parse(config.data!));
      data = { reportId:'RPT-test',state:'pending' };
    }
    return { data:{code:200,data},status:200,headers:{},config };
  };
  useAppStore.setState({userInfo:{id:1,userId:'tester',username:'tester',realName:'测试经办',roles:['handler'],permissions:['report.read','report.generate','statistics.read','complaint.read','dashboard.read']}});
  const {default: FixedReportPanel} = await vite.ssrLoadModule('/src/views/FixedReportPanel.tsx');
  const {render,within,fireEvent,waitFor,cleanup} = await import('@testing-library/react');
  const ui = render(<FixedReportPanel todoIds={[]} />);
  try {
    const page = within(document.body);
    assert.match(document.body.textContent??'', /当前模板：现有固定统计报告/);
    fireEvent.click(page.getByRole('button',{name:'生成统计报告'}));
    await waitFor(()=>assert.equal(submitted.length,1));
    assert.equal(submitted[0].templateCode,'statistics-draft');
    assert.equal(submitted[0].query.comparisonPolicyId,'candidate-calendar-v1');
    await waitFor(()=>assert.equal((page.getByRole('button',{name:'生成统计报告'}) as HTMLButtonElement).disabled,false));
    fireEvent.mouseDown(page.getByRole('combobox',{name:'统计口径'}));
    fireEvent.click(await page.findByText('标书采购范围（来源明确办结的水气诉求）'));
    assert.match(document.body.textContent??'', /当前模板：标书采购统计报告/);
    fireEvent.click(page.getByRole('button',{name:'生成统计报告'}));
    await waitFor(()=>assert.equal(submitted.length,2));
    assert.equal(submitted[1].templateCode,'procurement-statistics');
    assert.equal(submitted[1].query.comparisonPolicyId,'procurement-source-completed-v2');
  } finally {ui.unmount();cleanup();request.defaults.adapter=originalAdapter;useAppStore.setState({userInfo:originalUser});}
});
