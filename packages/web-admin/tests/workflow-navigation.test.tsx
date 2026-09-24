import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';
import type { CorrectionItem, LocationClueView } from '../src/types/api';

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
