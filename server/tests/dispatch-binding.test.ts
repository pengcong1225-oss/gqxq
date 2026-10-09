import assert from 'node:assert/strict';
import { scopedTest as test } from './helpers/scopedTest';

// Never load developer credentials or connect to a business database.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'nonexistent-dispatch-binding.env', GQXQ_DB_HOST: '127.0.0.1', GQXQ_DB_PORT: '1',
  GQXQ_DB_USER: 'synthetic', GQXQ_DB_PASSWORD: 'synthetic', GQXQ_DB_NAME: 'synthetic_dispatch',
  GQXQ_JWT_SECRET: 'synthetic-local-only', GQXQ_PU_APP_CODE: 'gqxq',
});
const ctx = { userId: 'synthetic-operator', userName: 'Synthetic', clientIp: null };
const terminal = ['completed', 'rejected', 'cancelled', 'archived'];

/** SQL boundary double: production services, transactions, validation and signatures remain real. */
class MemoryDb {
  complaints: Record<string, any>[] = [{ id: 1, complaint_id: 'C1', complaint_no: 'CS1', title: 'Synthetic',
    enterprise_code: 'E1', enterprise_name: 'Enterprise One', supervision_status: 'none',
    reporting_status: 'not_started', source_status: 'synthetic-source-open', status: 'open',
    is_sensitive: 1, sensitive_keywords: 'synthetic', edit_version: 7, effective_field_state: '{}' }];
  enterprises = [{ id: 1, enterprise_code: 'E1', enterprise_name: 'Enterprise One' },
    { id: 2, enterprise_code: 'E2', enterprise_name: 'Enterprise Two' }];
  orders: Record<string, any>[] = [];
  events = new Map<string, any>();
  fieldVersions: any[][] = [];
  assignments: any[][] = [];
  audits: any[][] = [];
  traces: any[][] = [];
  sequence = 0;
  snapshot: any;
  failAudit = false;
  async beginTransaction() {
    this.snapshot = structuredClone([this.complaints, this.orders, this.events, this.fieldVersions,
      this.assignments, this.audits, this.traces, this.sequence]);
  }
  async commit() {}
  async rollback() {
    [this.complaints, this.orders, this.events, this.fieldVersions, this.assignments,
      this.audits, this.traces, this.sequence] = this.snapshot;
  }
  release() {}
  async query(sql: string, p: any[] = []): Promise<any> {
    if (sql.startsWith('insert into number_sequence')) return [{ insertId: ++this.sequence }, []];
    if (sql.includes('from enterprise e')) return [this.enterprises.filter(e => e.enterprise_code.toLowerCase() === String(p[0]).toLowerCase()), []];
    if (sql.includes('from correction_item')) return [[{ complaintId: 'C1' }], []];
    if (sql.includes('from dispatch_order')) {
      let rows = this.orders;
      if (sql.includes('where d.assignment_id = ?')) rows = rows.filter(o => o.assignment_id === p[0]);
      else if (sql.includes('where d.reporting_task_id = ?')) rows = rows.filter(o => o.reporting_task_id === p[0]);
      else if (sql.includes('active_complaint_id = ?')) rows = rows.filter(o => o.complaint_id === p[0] && !terminal.includes(o.status));
      else throw new Error('unexpected dispatch query: ' + sql);
      return [rows.map(o => sql.includes('as assignmentId') ? {
        assignmentId: o.assignment_id, complaintId: o.complaint_id, status: o.status, requestId: o.request_id,
        subjectCode: o.target_enterprise_code, taskId: o.reporting_task_id ?? null,
        reportingItemId: o.reporting_item_id ?? null, lastEventSequence: o.last_event_sequence ?? 0,
        pushPayload: o.pushPayload,
      } : { ...o }), []];
    }
    if (sql.includes('from complaint ')) return [this.complaints.filter(c => c.complaint_id === p[0] || c.complaint_no === p[0]).map(c => ({ ...c })), []];
    if (sql.includes("processed_result='pending'")) return [[...this.events.values()].filter(e => e.processedResult === 'pending' && e.taskId === p[0])
      .map(e => ({ id: e.id, eventId: e.eventId, payload: e.payload })), []];
    if (sql.includes('processed_result as state')) return [[{ state: this.events.get(p[0])?.processedResult }], []];
    if (sql.includes('from business_event where event_id')) return [this.events.has(p[0]) ? [this.events.get(p[0])] : [], []];
    throw new Error('unexpected query: ' + sql);
  }
  async execute(sql: string, p: any[] = []): Promise<any> {
    if (sql.startsWith('insert into dispatch_order')) {
      if (this.orders.some(o => o.complaint_id === p[2] && !terminal.includes(o.status))) {
        throw Object.assign(new Error("Duplicate entry for key 'dispatch_order.uk_active_dispatch'"), { code: 'ER_DUP_ENTRY' });
      }
      this.orders.push({ assignment_id: p[0], order_no: p[1], complaint_id: p[2], complaint_title: p[3],
        target_enterprise_code: p[7], target_enterprise_name: p[8], status: p[9], request_id: p[13],
        reporting_task_id: null, reporting_item_id: null, last_event_sequence: 0 });
    } else if (sql.startsWith('update complaint set ')) {
      const row = this.complaints.find(c => c.complaint_id === p.at(-1))!;
      sql.split(' set ')[1].split(' where ')[0].split(', ').forEach((part, i) => { row[part.split(' = ')[0]] = p[i]; });
    } else if (sql.startsWith('insert into complaint_assignment')) this.assignments.push(p);
    else if (sql.startsWith('insert into complaint_field_version')) this.fieldVersions.push(p);
    else if (sql.startsWith('insert into operation_audit_log')) {
      if (this.failAudit && p[4] === 'DISPATCH_CREATE') throw new Error('synthetic audit failure');
      this.audits.push(p);
    } else if (sql.startsWith('insert into business_event')) {
      this.events.set(p[0], { id: this.events.size + 1, eventId: p[0], eventType: p[1], sourceBusinessId: p[3],
        taskId: p[4], payload: JSON.parse(p[13]), processedResult: p[16], processedMessage: p[17], ackBody: p[18] });
    } else if (sql.startsWith('update business_event')) Object.assign(this.events.get(p[2]), { processedResult: p[0], processedMessage: p[1] });
    else if (sql.startsWith('update dispatch_order')) {
      const order = this.orders.find(o => o.assignment_id === p[5])!;
      Object.assign(order, { status: p[0], last_event_sequence: p[2],
        reporting_item_id: order.reporting_item_id ?? p[3], reporting_task_id: order.reporting_task_id ?? p[4] });
    } else if (sql.startsWith('insert into approval_trace')) this.traces.push(p);
    else throw new Error('unexpected execute: ' + sql);
    return [{ affectedRows: 1 }, []];
  }
  businessState() { return structuredClone([this.complaints, this.orders, this.fieldVersions, this.assignments, this.traces]); }
}

async function withDb(run: (db: MemoryDb) => Promise<void>) {
  const { pool } = await import('../src/db/pool');
  const original = { query: pool.query, execute: pool.execute, getConnection: pool.getConnection };
  const db = new MemoryDb();
  Object.assign(pool, { query: db.query.bind(db), execute: db.execute.bind(db), getConnection: async () => db });
  try { await run(db); } finally { Object.assign(pool, original); }
}
const request = (code = 'E2', name = 'Enterprise Two') => ({ complaintId: 'C1', targetEnterpriseCode: code, targetEnterpriseName: name });

for (const [code, name, field] of [['UNKNOWN', 'Unknown', 'targetEnterpriseCode'], ['E2', 'Wrong Name', 'targetEnterpriseName']]) {
  test('direct dispatch rejects ' + field + ' outside master data without business writes', async () => withDb(async db => {
    const { createDispatch } = await import('../src/services/dispatchService');
    const before = db.businessState();
    await assert.rejects(createDispatch(request(code, name), ctx), (e: any) => e.status === 400 && e.fieldErrors.some((f: any) => f.field === field));
    assert.deepEqual(db.businessState(), before);
  }));
}
test('allowed reassignment uses canonical master identity and audits the difference', async () => withDb(async db => {
  const { createDispatch } = await import('../src/services/dispatchService');
  const result = await createDispatch(request('e2', ' Enterprise Two '), ctx);
  assert.equal(result.created, true);
  assert.equal(result.order.targetEnterpriseCode, 'E2');
  assert.equal(result.order.targetEnterpriseName, 'Enterprise Two');
  assert.equal(db.complaints[0].enterprise_code, 'E1');
  assert.equal(db.complaints[0].edit_version, 7);
  assert.equal(db.complaints[0].source_status, 'synthetic-source-open');
  const detail = JSON.parse(db.audits.at(-1)![9]);
  assert.equal(detail.enterpriseDiffersFromDispatch, true);
  assert.equal(detail.complaintEnterpriseCode, 'E1');
}));
test('repeat create returns the active order without changing its target or shared version', async () => withDb(async db => {
  const { createDispatch } = await import('../src/services/dispatchService');
  await createDispatch(request(), ctx);
  const before = db.businessState();
  const repeated = await createDispatch(request('E1', 'Enterprise One'), ctx);
  assert.equal(repeated.created, false);
  assert.equal(repeated.order.targetEnterpriseCode, 'E2');
  assert.equal(db.orders.length, 1);
  assert.deepEqual(db.businessState(), before);
}));
test('dispatch enterprise autofill protects the pair, increments once and rejects a stale correction window', async () => withDb(async db => {
  const { createDispatch } = await import('../src/services/dispatchService');
  const { confirmCorrection } = await import('../src/services/correctionService');
  Object.assign(db.complaints[0], { enterprise_code: null, enterprise_name: null, supervision_status: 'pending_match' });
  const readVersion = db.complaints[0].edit_version;
  await createDispatch(request(), ctx);
  assert.equal(db.complaints[0].edit_version, 8);
  const states = JSON.parse(db.complaints[0].effective_field_state);
  assert.deepEqual([states.enterprise_code.resolution, states.enterprise_code.value, states.enterprise_code.version], ['confirmed', 'E2', 8]);
  assert.deepEqual([states.enterprise_name.resolution, states.enterprise_name.value, states.enterprise_name.version], ['confirmed', 'Enterprise Two', 8]);
  assert.deepEqual(db.fieldVersions.map(p => [p[2], p[3], p[4], p[5]]),
    [['enterprise_code', null, 'E2', 'manual_edit'], ['enterprise_name', null, 'Enterprise Two', 'manual_edit']]);
  assert.ok(states.enterprise_code.reason.includes('交办首次责任确认'));
  assert.equal(db.assignments.length, 1);
  assert.equal(JSON.parse(db.audits[0][9]).source, 'dispatch');
  const before = db.businessState();
  assert.equal((await createDispatch(request('E1', 'Enterprise One'), ctx)).created, false);
  assert.deepEqual(db.businessState(), before);
  await assert.rejects(confirmCorrection('COR-synthetic', { newValue: 'stale', expectedVersion: readVersion }, ctx), (e: any) => e.status === 409);
  assert.deepEqual(db.businessState(), before);
}));
test('audit failure rolls back dispatch, enterprise autofill and version provenance together', async () => withDb(async db => {
  const { createDispatch } = await import('../src/services/dispatchService');
  Object.assign(db.complaints[0], { enterprise_code: null, enterprise_name: null });
  db.failAudit = true;
  const before = db.businessState();
  await assert.rejects(createDispatch(request(), ctx), /synthetic audit failure/);
  assert.deepEqual(db.businessState(), before);
}));

function order(assignment = 'A1', task: string | null = 'T1', status = 'pushed') {
  return { assignment_id: assignment, complaint_id: 'C1', target_enterprise_code: 'E2', status,
    request_id: 'R1', reporting_task_id: task, reporting_item_id: 'I1', last_event_sequence: 0,
    pushPayload: { sourceAppCode: 'gqxq', sceneCode: 'GQXQ_SENSITIVE_DISPATCH', templateVersion: 1 } };
}
function event(overrides: Record<string, unknown> = {}) {
  return { contractVersion: 2, assignmentId: 'A1', requestId: 'R1', reportingItemId: 'I1', eventSequence: 1,
    eventId: 'synthetic-event', eventType: 'TASK_ACCEPTED', approvalConclusion: 'PENDING',
    sourceAppCode: 'gqxq', sourceBusinessId: 'C1', taskId: 'T1', sceneCode: 'GQXQ_SENSITIVE_DISPATCH',
    enterpriseSubject: { subjectCode: 'E2', subjectName: 'Enterprise Two' }, enterpriseDisposalResult: {},
    attachments: [], templateVersion: 1, occurredAt: '2026-10-09T12:00:00+08:00', ...overrides };
}
async function send(payload: Record<string, unknown>) {
  const { env } = await import('../src/config/env');
  const { handleCallback } = await import('../src/services/callbackService');
  const { signCallback } = await import('../src/clients/callbackSignature');
  Object.assign(env.callback, { keyId: 'synthetic', keyVersion: 'v1', secret: 'synthetic-local-only', ackMode: 'BODY', ackValue: 'ACCEPTED\n' });
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return handleCallback({ rawBody, timestamp, keyId: 'synthetic', keyVersion: 'v1',
    headerEventId: String(payload.eventId), signature: signCallback(env.callback.secret, Number(timestamp), rawBody), remoteIp: null });
}

for (const [label, overrides] of [
  ['business', { sourceBusinessId: 'C2' }], ['enterprise', { enterpriseSubject: { subjectCode: 'E1', subjectName: 'Enterprise One' } }],
  ['task', { taskId: 'T2' }], ['request', { requestId: 'R2' }], ['item', { reportingItemId: 'I2' }],
  ['application', { sourceAppCode: 'foreign-app' }], ['scene', { sceneCode: 'OTHER' }], ['template', { templateVersion: 2 }],
] as const) {
  test('validly signed ' + label + ' mismatch persists stable rejection without wrong-object mutation', async () => withDb(async db => {
    db.orders.push(order());
    const payload = event(overrides);
    const before = db.businessState();
    assert.equal((await send(payload)).status, 400);
    assert.equal(db.events.get('synthetic-event').processedResult, 'rejected');
    assert.equal((await send(payload)).status, 400);
    assert.equal(db.events.size, 1);
    assert.deepEqual(db.businessState(), before);
  }));
}
test('task A, case B and enterprise C mismatch cannot mutate either case or order', async () => withDb(async db => {
  db.orders.push(order());
  db.complaints.push({ ...db.complaints[0], complaint_id: 'C2' });
  const before = db.businessState();
  assert.equal((await send(event({ sourceBusinessId: 'C2', enterpriseSubject: { subjectCode: 'E3', subjectName: 'Foreign' } }))).status, 400);
  assert.deepEqual(db.businessState(), before);
}));
test('legacy task match still cross-checks the case and target enterprise', async () => withDb(async db => {
  db.orders.push(order());
  const before = db.businessState();
  assert.equal((await send(event({ contractVersion: 1, sourceBusinessId: 'C2',
    enterpriseSubject: { subjectCode: 'E3', subjectName: 'Foreign' } }))).status, 400);
  assert.equal(db.events.get('synthetic-event').processedResult, 'rejected');
  assert.deepEqual(db.businessState(), before);
}));
for (const contractVersion of [1, 2]) {
  test('v' + contractVersion + ' historical callback stays on cancelled round while a newer order is active', async () => withDb(async db => {
    db.orders.push(order('A1', 'T1', 'cancelled'), { ...order('A2', 'T2'), request_id: 'R2' });
    db.complaints[0].supervision_status = 'pushed';
    db.complaints[0].reporting_status = 'accepted';
    const before = db.businessState();
    const result = await send(event({ contractVersion, eventType: 'TASK_REJECTED', approvalConclusion: 'DISAGREED', submissionVersion: 1 }));
    assert.equal(result.status, 200);
    assert.equal(result.result?.processedResult, 'ignored');
    assert.equal(db.orders[0].status, 'cancelled');
    assert.equal(db.orders[1].status, 'pushed');
    assert.deepEqual([db.complaints, db.orders, db.fieldVersions, db.assignments], before.slice(0, 4));
    assert.equal(db.traces.length, 1);
    assert.equal(db.traces[0][2], 'A1');
    const lateApproval = await send(event({ contractVersion, eventId: 'old-approved',
      eventType: 'TASK_APPROVED', approvalConclusion: 'AGREED', submissionVersion: 1 }));
    assert.equal(lateApproval.result?.processedResult, 'ignored');
    assert.deepEqual([db.complaints, db.orders, db.fieldVersions, db.assignments], before.slice(0, 4));
    assert.equal(db.complaints[0].reporting_status, 'accepted');
    assert.equal(db.complaints[0].supervision_status, 'pushed');
    assert.equal(db.complaints[0].status, 'open');
    assert.equal(db.traces.length, 2);
    assert.equal(db.traces[1][2], 'A1');
  }));
  test('v' + contractVersion + ' unregistered binding remains pending despite a newer order for the case', async () => withDb(async db => {
    db.orders.push(order('A2', 'T2'));
    const before = db.businessState();
    const result = await send(event({ contractVersion }));
    assert.equal(result.status, 200);
    assert.equal(result.ackBody, 'ACCEPTED\n');
    assert.equal(db.events.get('synthetic-event').processedResult, 'pending');
    assert.deepEqual(db.businessState(), before);
  }));
}
test('v2 first callback recovers an unregistered task only through matching assignment/request/case/enterprise', async () => withDb(async db => {
  db.orders.push(order('A1', null));
  const result = await send(event());
  assert.equal(result.status, 200);
  assert.equal(result.result?.processedResult, 'applied');
  assert.equal(db.orders[0].reporting_task_id, 'T1');
  assert.equal(db.orders[0].status, 'accepted');
  assert.equal(db.complaints[0].source_status, 'synthetic-source-open');
  const before = db.businessState();
  assert.equal((await send(event())).result?.duplicate, true);
  assert.deepEqual(db.businessState(), before);
}));
test('v2 first callback cannot attach a task when the original request identity differs', async () => withDb(async db => {
  db.orders.push(order('A1', null));
  const before = db.businessState();
  const payload = event({ requestId: 'R-other' });
  assert.equal((await send(payload)).status, 400);
  assert.equal((await send(payload)).status, 400);
  assert.equal(db.events.get('synthetic-event').processedResult, 'rejected');
  assert.deepEqual(db.businessState(), before);
}));
test('v2 missing binding fields is rejected even with a valid signature', async () => withDb(async db => {
  db.orders.push(order());
  const payload: any = event();
  delete payload.assignmentId;
  const before = db.businessState();
  assert.equal((await send(payload)).status, 400);
  assert.equal(db.events.get('synthetic-event').processedResult, 'rejected');
  assert.deepEqual(db.businessState(), before);
}));
