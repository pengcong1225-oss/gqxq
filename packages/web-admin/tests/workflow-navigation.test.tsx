import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';
import type { ComplaintDetail, CorrectionItem, LocationClueView } from '../src/types/api';

const memoryStorage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => memoryStorage.set(key, value),
  removeItem: (key: string) => memoryStorage.delete(key),
  clear: () => memoryStorage.clear(),
  key: (index: number) => Array.from(memoryStorage.keys())[index] ?? null,
  get length() {
    return memoryStorage.size;
  },
} as Storage;

let vite: ViteDevServer;
let dom: JSDOM;

before(async () => {
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
  await vite.close();
});

function renderWithRouter(node: React.ReactNode, route: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      {node}
    </MemoryRouter>
  );
}

test('整体纠偏页用覆盖全部字段的名称呈现', async () => {
  const { default: AddressCorrection } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const html = renderWithRouter(<AddressCorrection />, '/address-correction');

  assert.match(html, />整体纠偏</);
  assert.match(html, /待纠偏诉求/);
  assert.doesNotMatch(html, />纠偏待办</);
});

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
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

test('地址搜索返回可供人工选择的候选位置', async () => {
  const module = await vite.ssrLoadModule('/src/components/TiandituLocationPicker.tsx');
  const search = module.searchTiandituPlaces as
    | ((keyword: string, key: string, request: typeof fetch) => Promise<Array<{ name: string; address: string; lng: string; lat: string }>>)
    | undefined;
  assert.equal(typeof search, 'function');
  if (!search) return;
  let requestedUrl = '';
  const request = async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      resultType: 1,
      pois: [{ name: '宜昌市人民政府', address: '湖北省宜昌市西陵区沿江大道', lonlat: '111.286000,30.691000' }],
      status: { infocode: 1000 },
    }), { status: 200 });
  };
  const places = await search('宜昌市人民政府', 'test-key', request as typeof fetch);
  assert.deepEqual(places, [{ name: '宜昌市人民政府', address: '湖北省宜昌市西陵区沿江大道', lng: '111.286000', lat: '30.691000' }]);
  const url = new URL(requestedUrl);
  assert.equal(url.hostname, 'api.tianditu.gov.cn');
  assert.equal(url.searchParams.get('type'), 'query');
  assert.equal(JSON.parse(url.searchParams.get('postStr') ?? '{}').keyWord, '宜昌市人民政府');
});

test('敏感交办工作台同时提供规则命中诉求与交办记录', async () => {
  const dispatchModule = await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');
  const { default: DispatchOrders } = dispatchModule;
  const html = renderWithRouter(<DispatchOrders />, '/dispatch');

  assert.match(html, />规则命中诉求</);
  assert.match(html, />交办记录</);
  assert.match(html, /本表直接发起交办/);
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
  installDom();
  const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { message } = await import('antd');
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
    assert.match(ui.container.textContent ?? '', /版本重算/);
    assert.match(ui.container.textContent ?? '', /\[已脱敏\]/);
    assert.doesNotMatch(ui.container.textContent ?? '', /示例家园18号1301|13800000000/);
    fireEvent.click(executeButton);
    assert.equal(await screen.findByText(/位置线索预计新增\/更新\/移除 2 条/).then(() => true), true);
    fireEvent.click(await screen.findByRole('button', { name: '取 消' }));
    assert.equal(executeCalls, 0);
    fireEvent.click(executeButton);
    fireEvent.click(await screen.findByRole('button', { name: '确认执行', exact: true }));
    await waitFor(() => assert.equal(executeCalls, 1));
    assert.equal(await screen.findByText(/位置线索新增 2/).then(() => true), true);
    assert.match(ui.container.textContent ?? '', /地址候选新增 0，更新 0，未变 4，移除 0/);
  } finally { ui.unmount(); cleanup(); message.success = originalSuccess; }
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
  installDom();
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

test('真实整体纠偏抽屉和位置窗体不允许带入有冲突的地址候选', async () => {
  installDom();
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const axiosRequest = request as { defaults: { adapter: unknown } };
  const originalAdapter = axiosRequest.defaults.adapter;
  axiosRequest.defaults.adapter = async (config: { url?: string }) => {
    const responses: Record<string, unknown> = {
      '/corrections/pending-complaints': { content: [], total: 0 },
      '/enterprises': { content: [], total: 0 },
      '/complaints/CPL-TEST': locationDetailFixture,
      '/complaints/CPL-TEST/corrections': ['address', 'location_lng', 'location_lat'].map(locationCorrectionFixture),
    };
    if (!(config.url && config.url in responses)) throw new Error(`Unexpected test API: ${config.url}`);
    return { data: { code: 200, data: responses[config.url] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalUser = useAppStore.getState().userInfo;
  useAppStore.setState({ userInfo: { id: 1, userId: 'tester', username: 'tester', realName: '测试经办', roles: ['handler'], permissions: ['complaint.read','complaint.correct'], mustChangePassword:false, authorizationVersion:1 } });
  const { default: AddressCorrectionPage } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const { render, within, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
  const ui = render(<MemoryRouter initialEntries={['/address-correction?complaintId=CPL-TEST']}>
    <AddressCorrectionPage />
  </MemoryRouter>);
  try {
    const page = within(document.body);
    await waitFor(() => assert.match(document.body.textContent ?? '', /待核实位置线索.*样例社区20号1301/));
    assert.match(document.body.textContent ?? '', /位置冲突/);
    await waitFor(() => assert.equal((page.getByRole('button', { name: '打开位置组纠偏' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(page.getByRole('button', { name: '打开位置组纠偏' }));
    assert.match(document.body.textContent ?? '', /位置组纠偏/);
    assert.equal(page.queryByRole('button', { name: '填入待核实地址' }), null);
    assert.equal((page.getByPlaceholderText('人工核对后填写地址') as HTMLInputElement).value, '来源地址原值');
  } finally {
    ui.unmount(); cleanup(); axiosRequest.defaults.adapter = originalAdapter;
    useAppStore.setState({ userInfo: originalUser });
  }
});
test('来源原件按钮只对当前有效原件权限显示并按需取件',async()=>{
 installDom();const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts');const original=request.defaults.adapter;let sourceCalls=0;
 request.defaults.adapter=async(config:any)=>{let data:any;
  if(config.url==='/complaints/CPL-TEST/source-document'){sourceCalls++;data={complaintId:'CPL-TEST',sourcePayload:{address:'原件地址'},sourceFields:null,sourcePayloadHash:'synthetic'};}
  else if(config.url==='/complaints/CPL-TEST')data=locationDetailFixture;
  else if(config.url.endsWith('/timeline'))data={content:[],total:0};
  else data={enabled:false,message:'未接入'};
  return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};
 };
 const {default:Page}=await vite.ssrLoadModule('/src/views/ComplaintDetail.tsx');const {render,within,waitFor,cleanup,fireEvent}=await import('@testing-library/react');
 try{for(const allowed of [false,true]){
  useAppStore.setState({userInfo:{roles:['readonly'],permissions:allowed?['complaint.read','source_document.read']:['complaint.read'],mustChangePassword:false}});
  const ui=render(<MemoryRouter initialEntries={['/complaints/CPL-TEST']}><Routes><Route path="/complaints/:id" element={<Page/>}/></Routes></MemoryRouter>);
  await waitFor(()=>assert.ok(within(ui.container).getByText('基本信息')));const button=within(ui.container).queryByRole('button',{name:'查看来源原件'});
  assert.equal(Boolean(button),allowed);assert.equal(sourceCalls,0);
  if(button){fireEvent.click(button);await waitFor(()=>assert.equal(sourceCalls,1));await waitFor(()=>assert.match(document.body.textContent??'',/原件地址/));}
  ui.unmount();cleanup();
 }}finally{request.defaults.adapter=original;}
});
