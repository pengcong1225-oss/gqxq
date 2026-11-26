import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transformWithEsbuild } from 'vite';

const sourceUrl = new URL('./src/components/Map/map2d/cimTileSource.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');

async function probe(t, amapFlag, amapStatus = 503) {
  const { code } = await transformWithEsbuild(source, sourceUrl.pathname, {
    loader: 'ts',
    define: {
      'import.meta.env.VITE_BASEMAP_AMAP': amapFlag === undefined ? 'undefined' : JSON.stringify(amapFlag),
    },
  });
  const compiled = `${code}\n//# sourceURL=cimTileSource.ts`;
  const { probeCimTiles } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const requests = [];
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  t.after(() => { globalThis.window = originalWindow; });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url, 'http://local.test');
    requests.push(parsed);
    if (parsed.hostname.endsWith('.autonavi.com') && amapStatus === 200) {
      return new Response(new Uint8Array(600), { headers: { 'content-type': 'image/png' } });
    }
    return new Response(null, { status: parsed.hostname === 'local.test' ? 502 : amapStatus });
  });
  return { result: await probeCimTiles(), requests };
}

test('CIM source failures finish without high-de map requests when its switch is omitted', async (t) => {
  const { result, requests } = await probe(t, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.source, null);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.hostname === 'local.test'));
});

test('an unrecognized high-de switch leaves external tile requests disabled', async (t) => {
  const { requests } = await probe(t, 'off', 200);
  assert.ok(requests.every((request) => request.hostname === 'local.test'));
});

test('explicit opt-in tries the high-de raster endpoint after both CIM sources fail', async (t) => {
  const { result, requests } = await probe(t, 'true', 200);
  assert.equal(result.source, 'amap');
  assert.equal(requests.length, 5);
  const amapRequest = requests.at(-1);
  assert.equal(amapRequest.hostname, 'webst01.is.autonavi.com');
  assert.equal(amapRequest.pathname, '/appmaptile');
  assert.deepEqual([...amapRequest.searchParams.keys()].sort(), ['style', 'x', 'y', 'z']);
});

test('a failed high-de request returns its status in the map diagnostic', async (t) => {
  const { result } = await probe(t, 'true');
  assert.equal(result.ok, false);
  assert.match(result.reason, /高德：HTTP 503/);
});
