import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import View from 'ol/View.js';
import { effectScope } from 'vue';
import { useCimBoundaryOverlay } from './src/components/Map/map2d/cimBoundaryOverlay.ts';

function mountOverlay(t) {
  const scope = effectScope();
  const overlays = new Set();
  const requests = [];
  const view = new View({ projection: 'EPSG:4326', center: [111.32, 30.72], resolution: 0.001 });
  const map = {
    getSize: () => [480, 320],
    getView: () => view,
    addLayer: layer => overlays.add(layer),
    removeLayer: layer => overlays.delete(layer),
  };
  const browser = {
    sessionStorage: { getItem: key => key === 'gqxq-token' ? 'fixture-token' : null },
    createImageBitmap: async () => ({ width: 16, height: 16, close() {} }),
    document: {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/png;base64,aGVsbG8=',
      }),
    },
  };
  for (const [key, value] of Object.entries(browser)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => {
    requests.push({ url: new URL(url, 'http://local.test'), options, resolve });
  }));
  const overlay = scope.run(() => useCimBoundaryOverlay(() => map, '/gqxq/api/v1'));
  t.after(() => { overlay.stop(); scope.stop(); });
  return { overlay, overlays, requests, view };
}

function pngResponse(headers = {}) {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { 'content-type': 'image/png', ...headers },
  });
}

test('selection requests each CIM level and replaces the single reference image', async t => {
  const { overlay, overlays, requests } = mountOverlay(t);
  const initial = overlay.refresh();
  requests[0].resolve(pngResponse());
  await initial;
  assert.equal(requests[0].url.searchParams.get('level'), 'sqwg');
  assert.equal(overlays.size, 1);

  for (const [level, label] of [
    ['sqjcglqy', '社区居村管理区域'],
    ['xzj', '乡镇街'],
    ['qx', '区县'],
    ['sz', '市州'],
  ]) {
    overlay.level.value = level;
    assert.equal(overlays.size, 0);
    const request = requests.at(-1);
    assert.equal(request.url.pathname, '/gqxq/api/v1/cim/grid-overlay');
    assert.equal(request.url.searchParams.get('level'), level);
    assert.equal(request.options.headers.Authorization, 'Bearer fixture-token');
    request.resolve(pngResponse());
    await setImmediate();
    assert.equal(overlays.size, 1);
    assert.equal(overlay.status.value.text, `${label}已显示 · 只读栅格`);
  }
  assert.deepEqual(requests.map(request => request.url.searchParams.get('level')), ['sqwg', 'sqjcglqy', 'xzj', 'qx', 'sz']);
});

test('a failed switch clears the old layer and a retry can identify cached imagery', async t => {
  const { overlay, overlays, requests, view } = mountOverlay(t);
  const initial = overlay.refresh();
  requests[0].resolve(pngResponse());
  await initial;

  overlay.level.value = 'qx';
  requests[1].resolve(new Response(null, { status: 502 }));
  await setImmediate();
  assert.equal(overlays.size, 0);
  assert.deepEqual(overlay.status.value, { text: '区县加载失败（HTTP 502）', retry: true });

  const retry = overlay.refresh();
  requests[2].resolve(pngResponse({ 'x-cim-note': 'fixture-stale-cache' }));
  await retry;
  assert.equal(overlays.size, 1);
  assert.equal(overlay.status.value.text, '区县已显示 · 只读栅格 · 缓存');

  view.setCenter([115, 30.72]);
  await overlay.refresh();
  assert.equal(overlays.size, 0);
  assert.equal(requests.length, 3);
  assert.match(overlay.status.value.text, /宜昌/);
});

test('a bitmap decoded after a switch or shutdown cannot restore a stale layer', async t => {
  const { overlay, overlays, requests } = mountOverlay(t);
  let finishDecode;
  const decoding = new Promise(resolve => { finishDecode = resolve; });
  t.mock.method(globalThis, 'createImageBitmap', () => decoding, { times: 1 });
  const initial = overlay.refresh();
  requests[0].resolve(pngResponse());
  await setImmediate();

  overlay.level.value = 'sqjcglqy';
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve(pngResponse());
  await setImmediate();
  const currentLayer = [...overlays][0];
  assert.ok(currentLayer);

  let closed = false;
  finishDecode({ width: 16, height: 16, close() { closed = true; } });
  await initial;
  assert.deepEqual([...overlays], [currentLayer]);
  assert.equal(closed, true);

  const refresh = overlay.refresh();
  overlay.level.value = '';
  requests[2].resolve(pngResponse());
  await refresh;
  await overlay.refresh();
  assert.equal(requests[2].options.signal.aborted, true);
  assert.equal(requests.length, 3);
  assert.equal(overlays.size, 0);
  assert.equal(overlay.status.value.text, '已关闭');
});
