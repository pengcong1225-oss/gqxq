import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';
import { message } from 'antd';
import { Simulate } from 'react-dom/test-utils';
let vite: ViteDevServer;
before(async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} } as any;
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  vite = await createServer({ root, appType: 'custom', server: { port: 0, middlewareMode: true, hmr: false } });
  await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
    ShadowRoot: dom.window.ShadowRoot, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as any;
  const computedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => computedStyle(element)) as any;
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true, value: dom.window.getComputedStyle });
});

for (const scenario of ['enterprise-verification', 'same-field-conflict'] as const) test(scenario === 'enterprise-verification'
  ? 'enterprise verification uses no-correction endpoint with a version and basis'
  : 'same-field conflict refresh shows the winning effective value beside the retained inline draft', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const originalAdapter = request.defaults.adapter;
  const requests: Array<{ url: string; body: any }> = [];
  const isEnterprise = scenario === 'enterprise-verification';
  let refreshed = false;
  request.defaults.adapter = async (config: any) => {
    if (/\/(confirm|reject)$/.test(config.url)) {
      requests.push({ url: config.url, body: JSON.parse(config.data) });
      if (!isEnterprise) {
        refreshed = true;
        const error: any = new Error('Synthetic same-field conflict');
        error.response = { status: 409, data: { code: 'DUPLICATE_CONFLICT', message: 'Synthetic same-field conflict' } };
        throw error;
      }
      return { data: { code: 200, data: { item: { status: 'rejected', editVersion: 2 } } }, status: 200, headers: {}, config };
    }
    const data = config.url === '/complaints/synthetic-CPL/corrections' ? [{
      id: 1, correctionId: 'COR-inline', complaintId: 'synthetic-CPL', assignmentId: null, hasDispatch: false,
      fieldName: isEnterprise ? 'enterprise_name' : 'summary', fieldLabel: isEnterprise ? '企业名称/归属' : '诉求摘要',
      oldValue: isEnterprise ? 'Previously verified enterprise name' : 'Initial text',
      effectiveValue: isEnterprise ? 'SYN-E' : refreshed ? 'Winning window value' : 'Current text',
      newValue: refreshed ? 'Winning window value' : null, basis: null,
      status: refreshed ? 'confirmed' : 'pending', editVersion: refreshed ? 2 : 1,
    }] : config.url === '/complaints/synthetic-CPL'
      ? { complaintId: 'synthetic-CPL', complaintNo: 'synthetic-CS', title: 'Synthetic', locationClues: [], locationConflict: false }
      : { content: [], total: 0 };
    return { data: { code: 200, data }, status: 200, headers: {}, config };
  };
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalUser = useAppStore.getState().userInfo;
  useAppStore.setState({ userInfo: { id: 1, userId: 'synthetic-user', username: 'synthetic', roles: ['handler'], permissions: [] } });
  const { default: Page } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const { render, within, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const ui = render(<MemoryRouter initialEntries={['/address-correction?complaintId=synthetic-CPL']}><Page /></MemoryRouter>);
  try {
    const page = within(document.body);
    await waitFor(() => assert.ok(page.getByRole('button', { name: /核验无误/ })));
    if (isEnterprise) {
      fireEvent.click(page.getByRole('button', { name: /核验无误/ }));
      const basis = page.getByPlaceholderText('例如：电话核实、现场核对、来源系统原始报文') as HTMLTextAreaElement;
      await act(async () => { basis.value = 'Synthetic review basis'; Simulate.change(basis); });
      fireEvent.click(page.getByRole('button', { name: '提交核验' }));
      await waitFor(() => assert.equal(requests.length, 1));
      assert.equal(requests[0].url, '/corrections/COR-inline/reject');
      assert.deepEqual(requests[0].body, { expectedVersion: 1, basis: '核验无误：Synthetic review basis' });
    } else {
      const value = page.getByLabelText('纠偏后取值：诉求摘要') as HTMLTextAreaElement;
      const basis = page.getByLabelText('核对依据：诉求摘要') as HTMLInputElement;
      await act(async () => {
        value.value = 'Losing window draft'; Simulate.change(value);
        basis.value = 'Losing window review basis'; Simulate.change(basis);
      });
      fireEvent.click(page.getByRole('button', { name: '保存该项' }));
      await waitFor(() => assert.equal(requests.length, 1));
      assert.equal(requests[0].body.newValue, 'Losing window draft');
      assert.equal(requests[0].body.basis, 'Losing window review basis');
      await waitFor(() => assert.ok(page.getByRole('button', { name: '刷新核对（保留草稿）' })));
      fireEvent.click(page.getByRole('button', { name: '刷新核对（保留草稿）' }));
      await waitFor(() => assert.match(document.body.textContent ?? '', /Winning window value/));
      assert.match(document.body.textContent ?? '', /Losing window draft/);
      assert.match(document.body.textContent ?? '', /Losing window review basis/);
      assert.equal(page.queryByRole('button', { name: '保存该项' }), null, 'a closed field must not offer stale overwrite');
    }
  } finally {
    await act(async () => { message.destroy(); ui.unmount(); cleanup(); });
    request.defaults.adapter = originalAdapter; useAppStore.setState({ userInfo: originalUser });
  }
});
after(async () => { await vite.close(); });
for (const conflict of [true, false]) test(conflict ? 'position form retains all drafts on 409 and sends the read version' : 'position group uses each successful response version for the next field', async () => {
  const { default: request } = await vite.ssrLoadModule('/src/api/request.ts');
  const originalAdapter = request.defaults.adapter;
  let submitted: any;
  let submissions = 0;
  const submittedVersions: number[] = [];
  request.defaults.adapter = async (config: any) => {
    if (config.url.includes('/confirm')) {
      submissions++;
      submitted = JSON.parse(config.data);
      submittedVersions.push(submitted.expectedVersion);
      if (!conflict) return { data: { code: 200, data: { item: { editVersion: submissions + 1 } } }, status: 200, headers: {}, config };
      const error: any = new Error('synthetic version conflict');
      error.response = { status: 409, data: { code: 'DUPLICATE_CONFLICT', message: 'synthetic version conflict' } };
      throw error;
    }
    const data = config.url === '/complaints/synthetic-CPL/corrections'
      ? ['address', 'location_lng', 'location_lat'].map((field, i) => ({
        id: i, correctionId: 'COR-' + field, complaintId: 'synthetic-CPL', assignmentId: null, hasDispatch: false,
        fieldName: field, fieldLabel: field, oldValue: i === 0 ? 'A' : i === 1 ? '111' : '30', newValue: null,
        status: 'pending', editVersion: 1,
      })) : config.url === '/complaints/synthetic-CPL'
        ? { complaintId: 'synthetic-CPL', complaintNo: 'synthetic-CS', title: 'Synthetic', locationClues: [], locationConflict: false,
          addressCandidate: { value: 'Draft B', evidence: 'Synthetic source evidence', sourceField: 'content', extractorVersion: 'test' } }
        : { content: [], total: 0 };
    return { data: { code: 200, data }, status: 200, headers: {}, config };
  };
  const { useAppStore } = await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalUser = useAppStore.getState().userInfo;
  useAppStore.setState({ userInfo: { id: 1, userId: 'synthetic-user', username: 'synthetic', roles: ['handler'], permissions: [] } });
  const { default: Page } = await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
  const { render, within, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const ui = render(<MemoryRouter initialEntries={['/address-correction?complaintId=synthetic-CPL']}><Page /></MemoryRouter>);
  try {
    const page = within(document.body);
    await waitFor(() => assert.equal((page.getByRole('button', { name: '打开位置组纠偏' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(page.getByRole('button', { name: '打开位置组纠偏' }));
    fireEvent.click(page.getByRole('button', { name: '填入待核实地址' }));
    fireEvent.click(page.getByRole('button', { name: '保存位置组' }));
    await waitFor(() => assert.ok(submissions > 0));
    if (conflict) {
      assert.equal(submitted.expectedVersion, 1);
      await waitFor(() => assert.match(document.body.textContent ?? '', /刷新核对/));
      assert.equal((page.getByPlaceholderText('人工核对后填写地址') as HTMLInputElement).value, 'Draft B');
      assert.equal(submissions, 1, 'must stop the group after a stale-version conflict');
      fireEvent.click(page.getAllByRole('button', { name: '刷新核对（保留草稿）' }).at(-1)!);
      await waitFor(() => assert.match(document.body.textContent ?? '', /已刷新当前有效值与版本/));
      assert.equal((page.getByPlaceholderText('人工核对后填写地址') as HTMLInputElement).value, 'Draft B');
    } else {
      await waitFor(() => assert.equal(submissions, 3));
      assert.deepEqual(submittedVersions, [1, 2, 3]);
    }
  } finally {
    await act(async () => { message.destroy(); ui.unmount(); cleanup(); });
    request.defaults.adapter = originalAdapter; useAppStore.setState({ userInfo: originalUser });
  }
});
