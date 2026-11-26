import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, nextTick, reactive } from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createServer, transformWithEsbuild } from 'vite';

const grids = ['420502001', '420502011', '420503003'].map((code, index) => ({
  code, name: `网格 ${index + 1}`, version: 1, hasGeometry: true,
}));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

let vite;
let Panel;
before(async () => {
  globalThis.location = { pathname: '/gqxq/screen/' };
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    plugins: [{
      name: 'grid-compare-test',
      transform(source, id) {
        if (id.endsWith('/EChart.vue')) {
          return `import { h } from 'vue';
            export default { props: ['option'], render() { return h('div', { 'data-chart': this.option }); } };`;
        }
        if (id.endsWith('/GridComparePanel.vue')) {
          const { descriptor } = parse(source, { filename: id });
          const script = compileScript(descriptor, { id, inlineTemplate: true }).content;
          return transformWithEsbuild(script, id, { loader: 'ts' });
        }
      },
    }],
  });
  ({ default: Panel } = await vite.ssrLoadModule('/src/pages/accept/panels/GridComparePanel.vue'));
});
after(async () => { await vite?.close(); });

const node = (tag, text = '') => ({ tag, text, children: [], props: {}, addEventListener() {} });
const renderer = createRenderer({
  createElement: node,
  createText: text => node('#text', text),
  createComment: () => node('#comment'),
  setElementText: (el, text) => { el.text = text; el.children = []; },
  setText: (el, text) => { el.text = text; },
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insert(el, parent, anchor) {
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, el);
    el.parent = parent;
  },
  remove(el) {
    const siblings = el.parent.children;
    siblings.splice(siblings.indexOf(el), 1);
  },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1],
});
const contentOf = el => [typeof el.text === 'string' ? el.text : '', ...el.children.map(contentOf)].join('');
const nodesOf = el => [el, ...el.children.flatMap(nodesOf)];

async function mount(t, demo = false) {
  const originals = { fetch: globalThis.fetch, location: globalThis.location, sessionStorage: globalThis.sessionStorage, window: globalThis.window };
  const pending = [];
  const timers = new Map();
  let timerId = 0;
  globalThis.location = { pathname: '/gqxq/screen/', hash: demo ? '#/accept?drawer=compare&cmp=3' : '#/accept?drawer=compare' };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  globalThis.window = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.fetch = url => {
    const parsed = new URL(url, 'http://local.test');
    if (parsed.pathname.endsWith('/assessment/admin-grids')) return Promise.resolve(Response.json({ code: 200, data: grids }));
    assert.ok(parsed.pathname.endsWith('/assessment/grid-comparison'));
    return new Promise(resolve => pending.push({ query: Object.fromEntries(parsed.searchParams), resolve }));
  };
  const range = reactive({ fromDate: '2026-10-28', toDate: '2026-11-26' });
  const root = node('root');
  const app = renderer.createApp({ render: () => h(Panel, { ...range }) });
  app.mount(root);
  let mounted = true;
  const unmount = () => { if (mounted) { app.unmount(); mounted = false; } };
  t.after(() => { unmount(); Object.assign(globalThis, originals); });
  await settle();
  const click = async (label) => {
    const button = nodesOf(root).find(el => el.tag === 'button' && contentOf(el).includes(label));
    assert.ok(button, `missing button: ${label}`);
    button.props.onClick();
    await nextTick();
  };
  const respond = async (index, categoryCodes, highestCodes, snapshotId = 'snapshot') => {
    const { query, resolve } = pending[index];
    const selectedGrids = grids.filter(({ code }) => query.adminGridCodes.split(',').includes(code));
    const counts = Object.fromEntries(selectedGrids.map(({ code }) => [code, highestCodes.includes(code) ? 5 : 1]));
    const count = Object.values(counts).reduce((sum, n) => sum + n, 0);
    resolve(Response.json({ code: 200, data: {
      snapshotId, grids: selectedGrids, categoryLevel: query.categoryLevel, unlocatedCount: 1,
      totals: Object.fromEntries(Object.entries(counts).map(([code, n]) => [code, n * categoryCodes.length])),
      categories: categoryCodes.map(code => ({ code, dictionaryVersion: '1', count, counts, highest: highestCodes })),
    } }));
    await settle();
  };
  const fail = async (index, message) => {
    pending[index].resolve(Response.json({ code: 2002, message }, { status: 500 }));
    await settle();
  };
  return { root, range, pending, timers, click, respond, fail, unmount };
}

const categoryRows = root => nodesOf(root).find(el => el.tag === 'tbody')?.children.filter(el => el.tag === 'tr' && el.props.class !== 'cmp__totalrow') ?? [];
const loading = root => nodesOf(root).some(el => el.props['aria-busy'] === 'true');

test('the late major response preserves the active minor rows and their tied highlights', async t => {
  const { root, click, pending, respond } = await mount(t);
  await click(grids[0].code);
  await click(grids[1].code);
  await click('开始对比');
  await click('大类');
  await click('小类');
  assert.deepEqual(pending.map(({ query }) => query.categoryLevel), ['minor', 'major', 'minor']);
  const minorCodes = ['g01', 'g02', 'g03', 'g04', 'g05', 'g06', 'w01', 'w02', 'w03', 'w04', 'w05'];
  await respond(2, minorCodes, [grids[0].code, grids[1].code]);
  await respond(1, ['gas_service', 'water_service'], [grids[1].code]);
  assert.equal(categoryRows(root).length, 11);
  await respond(0, ['g01'], [grids[0].code]);
  const rows = categoryRows(root);
  assert.equal(rows.length, 11);
  assert.ok(rows.every(row => nodesOf(row).filter(el => el.props.class?.includes('is-max')).length === 2));
  assert.match(contentOf(root), /诉求类型（小类）/);
});

test('major comparison copy and chart distinguish the selected scope and its highest grid', async t => {
  const { root, click, respond } = await mount(t);
  await click('大类');
  await click(grids[0].code);
  await click(grids[1].code);
  await click('开始对比');
  await respond(0, ['gas_service'], [grids[1].code]);
  assert.match(contentOf(root), /分类口径诉求大类/);
  assert.match(contentOf(root), /按诉求大类并列对比/);
  const chart = nodesOf(root).find(el => el.props['data-chart'])?.props['data-chart'];
  assert.equal(chart.series[1].data[0].itemStyle.color, '#86fbe7');
  assert.notEqual(chart.series[0].data[0].itemStyle.color, '#86fbe7');
});

test('reselecting grids isolates their loading and errors from the old comparison', async t => {
  const { root, click, pending, respond, fail } = await mount(t);
  await click(grids[0].code);
  await click(grids[1].code);
  await click('开始对比');
  await click('重新选择');
  await click(grids[1].code);
  await click(grids[2].code);
  await click('开始对比');
  assert.equal(pending[1].query.adminGridCodes, `${grids[0].code},${grids[2].code}`);
  await fail(0, '旧查询失败');
  assert.ok(loading(root));
  await fail(1, '当前查询失败');
  assert.match(contentOf(root), /当前查询失败/);
  assert.doesNotMatch(contentOf(root), /旧查询失败/);
  await click('重新对比');
  await respond(2, ['g01'], [grids[2].code]);
  assert.equal(categoryRows(root).length, 1);
});

test('changing the date range reloads the result using the current window', async t => {
  const { root, click, pending, range, respond } = await mount(t);
  await click(grids[0].code);
  await click(grids[1].code);
  await click('开始对比');
  range.fromDate = '2026-11-01';
  range.toDate = '2026-11-25';
  await nextTick();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].query.from, '2026-11-01');
  assert.equal(pending[1].query.to, '2026-11-25');
  await respond(0, ['g01'], [grids[0].code], 'previous-window');
  assert.ok(loading(root));
  await respond(1, ['w01'], [grids[1].code], 'current-window');
  assert.match(contentOf(root), /current-window/);
  assert.doesNotMatch(contentOf(root), /previous-window/);
});

test('closing the component prevents the delayed demo from requesting a comparison', async t => {
  const { pending, timers, unmount } = await mount(t, true);
  assert.equal(timers.size, 1);
  unmount();
  for (const callback of timers.values()) callback();
  assert.equal(pending.length, 0);
});
