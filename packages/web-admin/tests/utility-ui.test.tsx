import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
import type {UtilityEvent} from '../src/utility/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost'});
for (const key of ['window', 'document', 'HTMLElement', 'HTMLBodyElement', 'HTMLInputElement', 'Element', 'SVGElement', 'Node', 'MutationObserver', 'ShadowRoot']) Object.defineProperty(globalThis, key, {value: (dom.window as any)[key], configurable: true});
Object.defineProperty(globalThis, 'navigator', {value: dom.window.navigator, configurable: true});
const computed = dom.window.getComputedStyle.bind(dom.window);
dom.window.getComputedStyle = ((element: Element) => computed(element)) as any;
globalThis.getComputedStyle = dom.window.getComputedStyle;
dom.window.matchMedia = ((query: string) => ({matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true})) as any;
(globalThis as any).ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
const {render, fireEvent, waitFor, cleanup} = await import('@testing-library/react');
const {default: EventForm} = await import('../src/utility/EventForm');
const {default: ComplaintTable} = await import('../src/utility/ComplaintTable');
test.afterEach(() => cleanup());
test.after(() => dom.window.close());
const event: UtilityEvent = {id: 'SIM-E', kind: 'shutdown', title: '模拟停供', businessType: 'water', enterpriseId: 'SIM-W', gridIds: ['SIM-G'], districtCode: 'D', startsAt: '2026-11-10T08:00:00+08:00', endsAt: '2026-11-10T18:00:00+08:00', restoredAt: null, households: 100, workers: 3, reason: '检修', area: '模拟区域', plan: '模拟计划', housing: '模拟小区', sourceApplicationNo: 'SIM-APPLY', approvalStatus: 'approved', approvalNote: '模拟通过', approvedBy: '模拟审批人', approvedAt: '2026-11-09T12:00:00+08:00', relatedTypes: ['水压问题'], revision: 1, updatedAt: '2026-11-10T00:00:00Z', mode: 'simulation'};
const options = {enterprises: [{id: 'SIM-W', name: '模拟水企', businessType: 'water' as const}], grids: [{id: 'SIM-G', name: '模拟网格', districtCode: 'D'}]};
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.replace(/\s/g, '') === text)!;

test('a new simulated record can be filled and submitted without a client-generated id', async () => {
  let saved: Partial<UtilityEvent> | undefined;
  render(<EventForm kind="pipeline" options={options} busy={false} onCancel={() => {}} onSave={async value => {saved = value;}}/>);
  const change = (id: string, value: string) => fireEvent.change(document.querySelector(`#${id}`)!, {target: {value}});
  const choose = async (id: string, label: string) => {
    fireEvent.mouseDown(document.querySelector(`#${id}`)!.closest('.ant-select-selector')!);
    await waitFor(() => assert.ok([...document.querySelectorAll('.ant-select-item-option-content')].find(i => i.textContent === label)), {timeout: 5000});
    fireEvent.click([...document.querySelectorAll('.ant-select-item-option-content')].find(i => i.textContent === label)!);
  };
  change('title', '模拟新增管道施工');
  await choose('enterpriseId', '模拟水企');
  await choose('gridIds', '模拟网格');
  change('startsAt', '2026-11-10T08:00'); change('endsAt', '2026-11-10T18:00');
  change('sourceApplicationNo', 'SIM-NEW'); change('reason', '设备改造'); change('area', '模拟区域'); change('plan', '模拟施工方案');
  await choose('relatedTypes', '水压问题');
  fireEvent.click(button('保存模拟记录'));
  await waitFor(() => assert.ok(saved), {timeout: 5000});
  assert.equal(saved!.id, undefined);
  assert.equal(saved!.kind, 'pipeline');
  assert.equal(saved!.mode, 'simulation');
  assert.equal(saved!.approvedAt, null);
  assert.deepEqual(saved!.gridIds, ['SIM-G']);
  assert.match(saved!.startsAt!, /Z$/);
});

test('editing saves source fields and timezone-bearing dates; invalid order cannot save', async () => {
  let saved: Partial<UtilityEvent> | undefined;
  const view = render(<EventForm kind="shutdown" record={event} options={options} busy={false} onCancel={() => {}} onSave={async value => {saved = value;}}/>);
  fireEvent.click(button('保存模拟记录'));
  await waitFor(() => assert.ok(saved), {timeout: 5000});
  assert.equal(saved!.id, event.id);
  assert.equal(Date.parse(saved!.startsAt!), Date.parse(event.startsAt));
  assert.match(saved!.startsAt!, /Z$/);
  assert.equal(saved!.restoredAt, null);
  assert.equal(saved!.approvedBy, '模拟审批人');
  assert.deepEqual(saved!.gridIds, ['SIM-G']);
  saved = undefined;
  fireEvent.change(document.querySelector('#endsAt')!, {target: {value: '2026-11-01T00:00'}});
  fireEvent.click(button('保存模拟记录'));
  await waitFor(() => assert.match(document.body.textContent ?? '', /计划结束时间必须晚于开始时间/), {timeout: 5000});
  assert.equal(saved, undefined);
  view.unmount(); cleanup();
});

test('a simulated linked complaint opens its own details without a real-ledger link', async () => {
  const row = {id: 'SIM-C', title: '模拟水压问题', type: '水压问题', occurredAt: '2026-11-10T08:00:00Z', gridId: 'SIM-G'};
  const view = render(<ComplaintTable complaints={[row]} mode="simulation" options={options}/>);
  fireEvent.click(button('模拟水压问题'));
  await waitFor(() => assert.match(document.body.textContent ?? '', /【模拟】关联诉求明细/), {timeout: 5000});
  assert.match(document.body.textContent ?? '', /SIM-C/);
  assert.equal(document.querySelector('a[href^="/complaints/"]'), null);
  view.unmount(); cleanup();
});
