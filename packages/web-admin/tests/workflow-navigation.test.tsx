import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer, type ViteDevServer } from 'vite';
import type { CorrectionItem } from '../src/types/api';

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
