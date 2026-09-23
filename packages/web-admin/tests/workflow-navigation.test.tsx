import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer, type ViteDevServer } from 'vite';

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
    server: { middlewareMode: true },
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
  assert.doesNotMatch(html, />纠偏待办</);
});

test('敏感交办工作台同时提供规则命中诉求与交办记录', async () => {
  const dispatchModule = await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');
  const { default: DispatchOrders } = dispatchModule;
  const html = renderWithRouter(<DispatchOrders />, '/dispatch');

  assert.match(html, />规则命中诉求</);
  assert.match(html, />交办记录</);
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
  assert.match(html, />预览历史重扫</);
  assert.doesNotMatch(html, /演示数据/);
});
