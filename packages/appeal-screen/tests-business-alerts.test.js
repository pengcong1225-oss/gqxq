import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';
import { createServer, transformWithEsbuild } from 'vite';

let vite;
let Panel;
const scheduled = [];

before(async () => {
  globalThis.location = { pathname: '/gqxq/screen/', hash: '#/accept?drawer=warnings&eval=1' };
  globalThis.window = { setTimeout: callback => scheduled.push(callback) };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    plugins: [{
      name: 'business-alerts-client-test',
      transform(source, id) {
        if (!id.endsWith('/BusinessAlertsPanel.vue')) return;
        const { descriptor } = parse(source, { filename: id });
        const script = compileScript(descriptor, { id, inlineTemplate: true }).content;
        return transformWithEsbuild(script, id, { loader: 'ts' });
      },
    }],
  });
  ({ default: Panel } = await vite.ssrLoadModule('/src/pages/accept/panels/BusinessAlertsPanel.vue'));
});

after(async () => { await vite?.close(); });

function node(tag, text = '') {
  return { tag, text, children: [], props: {}, addEventListener() {} };
}

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
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

async function mount(t, rulesResponse, evaluation = null, { alerts = [], history } = {}) {
  const fetchBefore = globalThis.fetch;
  const requests = [];
  scheduled.length = 0;
  globalThis.fetch = async (url, { method }) => {
    requests.push(`${method} ${url}`);
    if (url.endsWith('/rules')) return Response.json(rulesResponse.body, { status: rulesResponse.status });
    if (url.endsWith('/history') && history) return Response.json({ code: 200, data: await history(url) });
    return Response.json({ code: 200, data: url.endsWith('/evaluate') ? evaluation : alerts });
  };
  const root = node('root');
  const app = renderer.createApp(Panel);
  t.after(() => { app.unmount(); globalThis.fetch = fetchBefore; });
  app.mount(root);
  await settle();
  return { root, requests };
}

const rule = {
  ruleId: 'three-piece', name: '安装推进', scene: 'gas_three_piece', businessType: 'gas',
  scope: 'city', ruleVersion: 3, threshold: 133, windowDays: 7, majorCodes: [],
  minorCodes: ['g01', 'g02', 'g04', 'g05'], dictionaryVersion: '20',
  effectiveFrom: '2025-01-01', effectiveTo: '2027-12-31', state: 'enabled',
};
const response = (data) => ({ status: 200, body: { code: 200, data } });

test('the warnings drawer is read-only on entry, including with the old eval=1 URL', async t => {
  const { root, requests } = await mount(t, response({
    asOf: '2026-11-26', canEvaluate: false, draftScenes: ['gas_three_piece', 'summer'],
    rules: [rule, { ...rule, ruleId: 'planned', scene: 'planned_shutdown', state: 'disabled', threshold: 10 }],
  }));
  for (const callback of scheduled) callback();
  await settle();
  assert.deepEqual(requests.sort(), [
    'GET /gqxq/api/v1/business-alerts', 'GET /gqxq/api/v1/business-alerts/rules',
  ]);
  const text = contentOf(root);
  assert.match(text, /已发布 v3.*7 天.*133 件.*g01.*g02.*g04.*g05/);
  assert.match(text, /有未发布草稿/);
  assert.match(text, /仅有未发布草稿/);
  assert.match(text, /未配置正式规则/);
  assert.match(text, /已禁用.*10 件/);
  assert.match(text, /暂无已保存预警/);
  assert.doesNotMatch(text, /定义.*待业务确认|今日评估/);
});

test('permission and server failures are displayed separately from unconfigured rules', async t => {
  for (const [status, label] of [[401, /请登录后查看预警规则/], [403, /无权限查看预警规则/], [500, /预警规则加载失败/]]) {
    await t.test(`HTTP ${status}`, async sub => {
      const { root } = await mount(sub, { status, body: { code: status, message: 'fixture error' } });
      assert.match(contentOf(root), label);
      assert.doesNotMatch(contentOf(root), /未配置正式规则|133 件/);
    });
  }
});

test('explicit evaluation displays the exact rule version and threshold used by that evaluation', async t => {
  const { root, requests } = await mount(t, response({
    asOf: '2026-11-26', canEvaluate: true, draftScenes: null, rules: [rule],
  }), { created: 0, statuses: [{ ...rule, ruleVersion: 4, windowDays: 8, threshold: 140, count: 100, status: 'below_threshold' }] });
  for (const callback of scheduled) callback();
  await settle();
  assert.equal(requests.some(req => req.startsWith('POST')), false);
  const button = nodesOf(root).find(el => el.tag === 'button' && contentOf(el) === '今日评估');
  assert.ok(button);
  button.props.onClick();
  await settle();
  assert.equal(requests.filter(req => req.startsWith('POST')).length, 1);
  assert.match(contentOf(root), /已发布 v3.*133 件/);
  assert.match(contentOf(root), /v4.*8 天.*140 件/);
});

test('planned alert shows its frozen application and a late history cannot replace the next detail', async t => {
  let finishPlanned;
  const plannedHistory = new Promise(resolve => { finishPlanned = resolve; });
  const base = { ruleId: 'rule', ruleVersion: 2, scope: 'city', state: 'resolved', from: '2026-11-24', to: '2026-11-26',
    quantity: 1, threshold: 1, complaintIds: ['CASE-1'] };
  const { root } = await mount(t, response({ rules: [rule] }), null, {
    alerts: [
      { ...base, alertId: 'planned', scene: 'planned_shutdown', ruleName: '计划停水例', utilityEvidence: [
        { sourceApplicationNo: 'APP-17', sourceRevision: 'r4', eventId: 'EV-10', eventRevision: 3, complaintId: 'CASE-1' },
      ] },
      { ...base, alertId: 'install', scene: 'gas_three_piece', ruleName: '三件套例', complaintIds: ['CASE-2'] },
    ],
    history: (url) => url.endsWith('/planned/history') ? plannedHistory : [{ action: 'resolve', notes: '三件套已核实' }],
  });
  const [planned, install] = nodesOf(root).filter(el => el.tag === 'article' && el.props.title?.includes('点击查看预警详情'));
  planned.props.onClick();
  await settle();
  const dialog = () => nodesOf(root).find(el => el.props.role === 'dialog');
  assert.match(contentOf(dialog()), /计划停供来源.*APP-17.*来源版本 r4.*EV-10.*v3.*CASE-1/);
  nodesOf(dialog()).find(el => el.tag === 'button' && contentOf(el).includes('关闭')).props.onClick();
  install.props.onClick();
  await settle();
  finishPlanned([{ action: 'resolve', notes: '停水已核实' }]);
  await settle();
  assert.match(contentOf(dialog()), /三件套例.*CASE-2.*三件套已核实/);
  assert.doesNotMatch(contentOf(dialog()), /APP-17|停水已核实/);
});
