import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React from 'react';
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null } as unknown as Storage;
let vite: ViteDevServer;
const documents: JSDOM[] = [];
const originalChannel=globalThis.MessageChannel;
const channels:MessageChannel[]=[];
before(async () => {
  Object.defineProperty(globalThis,'MessageChannel',{configurable:true,writable:true,value:class extends originalChannel{constructor(){super();channels.push(this);}}});
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  documents.push(dom);
  for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Node', 'MutationObserver'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  dom.window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as any;
  ({ MemoryRouter } = await import('react-router-dom'));
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom',
    cacheDir:fileURLToPath(new URL('../node_modules/.vite-shell-test',import.meta.url)),
    server: { port: 0, middlewareMode: true, hmr: false },
  });
});
after(async () => {
  for (const dom of documents) dom.window.close();
  await vite.close();
  for(const channel of channels){channel.port1.close();channel.port2.close();}
  Object.defineProperty(globalThis,'MessageChannel',{configurable:true,writable:true,value:originalChannel});
});

async function shell(route: string, permissions: string[], mustChangePassword = false) {
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const { default: MainLayout } = await vite.ssrLoadModule('/src/layouts/MainLayout.tsx');
  useAppStore.setState({ token: null, userInfo: {
    id: 1, userId: 'test', username: 'test', realName: '测试', roles: ['admin'],
    permissions, mustChangePassword, authorizationVersion: 1,
  } });
  const { render, act, cleanup } = await import('@testing-library/react');
  let ui: ReturnType<typeof render>;
  await act(async () => { ui = render(<MemoryRouter initialEntries={[route]}><MainLayout /></MemoryRouter>); });
  const snapshot = new JSDOM(ui!.container.innerHTML);
  documents.push(snapshot);
  cleanup();
  return snapshot.window.document;
}

test('complaint detail keeps its parent menu selected and permission filtering intact', async () => {
  const doc = await shell('/complaints/CPL-123', ['complaint.read']);
  assert.equal(doc.querySelector('.ant-menu-item-selected')?.textContent, '诉求管理');
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 2);
  assert.match(doc.querySelector('.ant-breadcrumb')?.textContent ?? '', /诉求管理/);
});

test('archive selects the specific route instead of the dispatch parent', async () => {
  const doc = await shell('/dispatch/archive', ['dispatch.read']);
  assert.equal(doc.querySelectorAll('.ant-menu-item-selected').length, 1);
  assert.equal(doc.querySelector('.ant-menu-item-selected')?.textContent, '交办归档');
});

test('initial password gate exposes no business menu', async () => {
  const doc = await shell('/complaints', ['complaint.read', 'dispatch.read'], true);
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 0);
});

test('import navigation still requires an authorized target domain', async () => {
  const denied = await shell('/master-data/imports', ['masterdata.import']);
  assert.equal(denied.querySelectorAll('[role="menuitem"]').length, 0);
  const allowed = await shell('/master-data/imports', ['masterdata.import', 'enterprise.manage']);
  assert.equal(allowed.querySelector('.ant-menu-item-selected')?.textContent, '导入批次');
});

test('connected source business modules appear with their own capabilities', async () => {
  const doc = await shell('/dashboard', ['dashboard.read', 'shutdown.read', 'pipeline.read']);
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 4);
  assert.equal(doc.querySelector('.ant-menu-item-selected')?.textContent, '数据概览');
  assert.match(doc.body.textContent ?? '', /停供管理/);
  assert.match(doc.body.textContent ?? '', /管道施工/);
});
