import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';

test('new dispatches require a note and a deadline, and relay the saved text to the company', async (t) => {
  const { pool } = await import('../src/db/pool');
  const { runAsTrustedSystem } = await import('../src/auth/accessScope');
  const { dispatchRouter } = await import('../src/routes/dispatch');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const { preparePush } = await import('../src/services/dispatchService');
  const { buildTaskPayload } = await import('../src/services/dispatchPushService');
  const complaint = {
    id: 1, complaint_id: 'CPL-TEST', complaint_no: 'CS-TEST', title: '隔离测试诉求',
    enterprise_code: 'E-TEST', enterprise_name: '隔离测试企业', is_sensitive: 1, supervision_status: 'none',
  };
  let order: Record<string, unknown> | null = null;
  let inserts = 0;
  const duplicate = Object.assign(new Error("Duplicate entry for key 'uk_active_dispatch'"), { code: 'ER_DUP_ENTRY' });
  const query = async (sql: string) => {
    if (sql.includes(' from dispatch_order d ')) return [order ? [order] : [], []];
    if (sql.includes(' from complaint ')) return [[complaint], []];
    if (sql.includes(' from enterprise e ')) return [[{ ...complaint, status: 'enabled' }], []];
    if (sql.startsWith('insert into number_sequence ')) return [{ insertId: 1 }, []];
    if (sql.startsWith('select ') && sql.includes(' from pu_enterprise_binding')) return [[], []];
    throw new Error('Unexpected isolated query: ' + sql);
  };
  const execute = async (sql: string, values: unknown[]) => {
    if (sql.startsWith('insert into dispatch_order ')) {
      if (order) throw duplicate;
      inserts++;
      order = {
        id: 1, assignment_id: values[0], order_no: values[1], complaint_id: values[2],
        complaint_title: values[3], target_enterprise_code: values[7], target_enterprise_name: values[8],
        status: values[9], deadline: values[12], request_id: values[13], requirement: values[15],
      };
    } else if (!sql.startsWith('update complaint ') && !sql.startsWith('insert into operation_audit_log ')) {
      throw new Error('Unexpected isolated write: ' + sql);
    }
    return [{ affectedRows: 1 }, []];
  };
  const noop = async () => {};
  t.mock.method(pool, 'query', query);
  t.mock.method(pool, 'getConnection', async () => ({
    query, execute, beginTransaction: noop, commit: noop, rollback: noop, release: noop,
  }));
  const app = express();
  app.use(express.json(), (_req, _res, next) => runAsTrustedSystem(next), dispatchRouter, errorHandler);
  const body = { complaintId: 'CPL-TEST', targetEnterpriseCode: 'E-TEST', targetEnterpriseName: '隔离测试企业',
    deadline: '2027-02-01T10:00:00+08:00' };
  for (const requirement of [undefined, null, '', ' \n　\t ', 123, '字'.repeat(1001)]) {
    const response = await request(app).post('/dispatch/orders').send({ ...body, requirement });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.data.fieldErrors[0].field, 'requirement');
    assert.equal(inserts, 0);
  }
  const note = '核对整改现场\n附复核时间';
  const noDeadline = await request(app).post('/dispatch/orders').send({ ...body, requirement: note, deadline: undefined });
  assert.equal(noDeadline.status, 400, JSON.stringify(noDeadline.body));
  assert.equal(noDeadline.body.data.fieldErrors[0].field, 'deadline');
  assert.equal(inserts, 0);
  const created = await request(app).post('/dispatch/orders').send({ ...body, requirement: '  ' + note + '  ' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.created, true);
  assert.equal(created.body.data.order.requirement, note);
  const assignmentId: string = created.body.data.order.assignmentId;
  const prep = await runAsTrustedSystem(() => preparePush(assignmentId));
  const payload = buildTaskPayload(prep);
  assert.equal(payload.deadline, '2027-02-01T10:00:00+08:00');
  assert.deepEqual(payload.prefilledData, {
    complaintNo: undefined, sourceEventNo: undefined, dispatchRequirement: note,
  });

  const duplicateRequest = await request(app).post('/dispatch/orders').send({ ...body, requirement: '不覆盖原说明' });
  assert.equal(duplicateRequest.status, 200);
  assert.equal(duplicateRequest.body.data.created, false);
  assert.equal(duplicateRequest.body.data.order.requirement, note);
  assert.equal(inserts, 1);

  assert.ok(order);
  Object.assign(order, { requirement: null });
  const replay = await request(app).post('/dispatch/orders').send({ ...body, deadline: undefined });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.created, false);
  assert.equal(replay.body.data.order.assignmentId, assignmentId);
  assert.equal(replay.body.data.order.requirement, null);
  assert.equal(inserts, 1);
  await assert.rejects(runAsTrustedSystem(() => preparePush(assignmentId)),
    { errorCode: 'VALIDATION_FAILED', fieldErrors: [{ field: 'requirement', message: '交办单缺少企业处置说明，请撤销后重新交办' }] });
});

test('preflight of an existing dispatch uses its original snapshot even when the old note was empty', async (t) => {
  const { pool } = await import('../src/db/pool');
  const { env } = await import('../src/config/env');
  const { runAsTrustedSystem } = await import('../src/auth/accessScope');
  const { buildTaskPayload, preflightDispatch } = await import('../src/services/dispatchPushService');
  const { serializeOnce } = await import('../src/clients/publicUtilityClient');
  const order = {
    assignment_id: 'A-OLD', request_id: 'R-OLD', complaint_id: 'C-OLD',
    target_enterprise_code: 'E-OLD', target_enterprise_name: '旧企业', status: 'pushed', requirement: null, deadline: null,
  };
  const payload = buildTaskPayload({
    assignmentId: 'A-OLD', requestId: 'R-OLD', complaintId: 'C-OLD', complaintNo: null, sourceEventNo: null,
    complaintTitle: '历史交办', targetEnterpriseCode: 'E-OLD', targetEnterpriseName: '旧企业',
    requirement: '新单需填写说明', reason: null, deadline: new Date('2027-02-01T02:00:00Z'), dispatchType: 'manual',
    triggerType: 'sensitive_word', status: 'pending', reportingTaskId: null,
  });
  const frozen = serializeOnce({ ...payload, prefilledData: { dispatchRequirement: '' } });
  t.mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes(' from dispatch_order d ')) return [[order], []];
    if (sql.includes(' from dispatch_push_snapshot ')) return [[{ body: frozen.bodyText, sha256: frozen.bodySha256 }], []];
    if (sql.includes(' from dispatch_request_log ')) return [[], []];
    throw new Error('Unexpected isolated query: ' + sql);
  });
  const old = { keyId: env.pu.keyId, secret: env.pu.secret };
  Object.assign(env.pu, { keyId: 'test-key', secret: 'isolated-synthetic-fixture' });
  t.after(() => Object.assign(env.pu, old));
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string, init: { body: Buffer }) => {
    requests.push(JSON.parse(init.body.toString('utf8')));
    return Response.json({ ready: true, issues: [] });
  });
  assert.deepEqual(await runAsTrustedSystem(() => preflightDispatch('A-OLD')), { ready: true, issues: [] });
  assert.equal(requests.length, 1);
  const { requestId, ...sent } = requests[0];
  assert.match(String(requestId), /^preflight:/);
  assert.deepEqual({ ...sent, requestId: 'R-OLD' }, JSON.parse(frozen.bodyText));
});
