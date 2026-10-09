import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express, Request, Response } from 'express';
import supertest from 'supertest';

// Evidence for existing local boundaries only: no invented signature protocol,
// gateway probe, startup/reconciliation run, or developer/business DB access.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), `gqxq-a4-missing-${randomUUID()}.env`),
  NODE_ENV: 'test', PORT: '0',
  GQXQ_DB_HOST: '127.0.0.1', GQXQ_DB_PORT: '1', GQXQ_DB_CONNECTION_LIMIT: '1',
  GQXQ_DB_USER: 'synthetic', GQXQ_DB_PASSWORD: 'synthetic', GQXQ_DB_NAME: 'synthetic_a4',
  GQXQ_JWT_SECRET: 'synthetic-a4-local-only-32-characters',
  GQXQ_PU_RECONCILIATION_ENABLED: 'false', GQXQ_YJJB_ADAPTER: 'disabled',
  GQXQ_PU_BASE_URL: 'http://127.0.0.1:1', GQXQ_YJJB_BASE_URL: '',
  GQXQ_PU_KEY_ID: '', GQXQ_PU_SECRET: '',
  GQXQ_CALLBACK_KEY_ID: '', GQXQ_CALLBACK_SECRET: '',
});
delete process.env.GQXQ_HOST;
delete process.env.GQXQ_TRUST_PROXY;

type RuntimeEnv = typeof import('../src/config/env').env;
let env: RuntimeEnv;
let createApp: typeof import('../src/app').createApp;
let requestContext: typeof import('../src/middleware/requestContext').requestContext;
let pool: typeof import('../src/db/pool').pool;
const writes: Array<{ sql: string; params: unknown[] }> = [];
let unexpectedDbCalls = 0;
let restorePool: () => void;

before(async () => {
  ({ env } = await import('../src/config/env'));
  assert.deepEqual(env.db, {
    host: '127.0.0.1', port: 1, user: 'synthetic', password: 'synthetic',
    database: 'synthetic_a4', connectionLimit: 1,
  });
  ({ pool } = await import('../src/db/pool'));
  const original = { query: pool.query, execute: pool.execute, getConnection: pool.getConnection };
  const forbidden = async () => {
    unexpectedDbCalls++;
    throw new Error('A4 must not connect to or query a real DB');
  };
  Object.assign(pool, {
    query: forbidden, getConnection: forbidden,
    execute: async (sql: string, params: unknown[]) => {
      // Only the existing rejected-intake recorder is permitted in this SQL double.
      if (!sql.startsWith('insert into complaint_source_log ') &&
          !sql.startsWith('insert into operation_audit_log ')) return forbidden();
      writes.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    },
  });
  restorePool = () => Object.assign(pool, original);
  ({ createApp } = await import('../src/app'));
  ({ requestContext } = await import('../src/middleware/requestContext'));
});

after(async () => {
  restorePool?.();
  await pool?.end();
  assert.equal(unexpectedDbCalls, 0, 'no real SQL/query/transaction paths may be used');
});

async function withHttp(run: (client: ReturnType<typeof supertest>, address: AddressInfo) => Promise<void>) {
  // Same host configuration as index.ts; this does not start production main/DB/reconciliation.
  const server = createApp().listen(0, env.host);
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(supertest(server), address);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const appealPath = '/api/v1/external/yijiejieban/appeal';
const oneMiB = 1024 * 1024;
function paddedJson(bytes: number): string { return '[]' + ' '.repeat(bytes - 2); }

test('default host binds the local HTTP fixture to IPv4 loopback', async () => {
  assert.equal(env.host, '127.0.0.1');
  assert.equal(env.trustProxy, 'loopback');
  await withHttp(async (client, address) => {
    assert.equal(address.address, '127.0.0.1');
    const response = await client.post('/api/v1/complaints').send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.data.errorCode, 'UNAUTHENTICATED');
  });
});

test('exactly 1 MiB parses and reaches domain rejection with synthetic evidence writes', async () => {
  writes.length = 0;
  const body = paddedJson(oneMiB);
  assert.equal(Buffer.byteLength(body), oneMiB);
  await withHttp(async client => {
    const response = await client.post(appealPath).set('Content-Type', 'application/json').send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.data.errorCode, 'VALIDATION_FAILED');
    assert.match(response.body.message, /单个 JSON 对象/);
    assert.equal(writes.length, 2, 'parser accepted; real route/repositories reached only SQL double');
    assert.equal(writes[0].params[6], 'rejected');
    assert.equal(writes[1].params[4], 'INTAKE_REJECTED');
  });
});

test('1 MiB plus one byte returns 413 before any intake evidence or business DB access', async () => {
  writes.length = 0;
  const body = paddedJson(oneMiB + 1);
  assert.equal(Buffer.byteLength(body), oneMiB + 1);
  await withHttp(async client => {
    const response = await client.post(appealPath).set('Content-Type', 'application/json').send(body);
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 413);
    assert.equal(response.body.data.errorCode, 'PAYLOAD_TOO_LARGE');
    assert.equal(writes.length, 0);
  });
});

test('malformed JSON returns 400 before the rejected-intake recorder', async () => {
  writes.length = 0;
  await withHttp(async client => {
    const response = await client.post(appealPath).set('Content-Type', 'application/json').send('{');
    assert.equal(response.status, 400);
    assert.equal(response.body.data.errorCode, 'VALIDATION_FAILED');
    assert.match(response.body.message, /不是合法 JSON/);
    assert.equal(writes.length, 0);
  });
});

test('known gap: credential-free domain-invalid source request reaches the recorder, not an identity gate', async () => {
  writes.length = 0;
  await withHttp(async client => {
    const response = await client.post(appealPath)
      .set('X-Forwarded-For', '203.0.113.77').set('X-Request-Id', 'synthetic-a4-request')
      .send({ sourceId: 'synthetic-a4-source', title: '' });
    assert.equal(response.status, 400, 'domain rejection is not 401/403 source authentication');
    assert.equal(response.body.data.errorCode, 'VALIDATION_FAILED');
    assert.ok(response.body.data.fieldErrors.some((field: { field: string }) => field.field === 'title'));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].params[2], 'synthetic-a4-source');
    assert.equal(writes[0].params[8], '203.0.113.77', 'loopback caller can supply its claimed XFF');
    assert.equal(writes[1].params[1], null, 'source requests do not acquire a platform user');
  });
});

function appWithProxy(value: string): Express {
  const original = env.trustProxy;
  try {
    Object.assign(env, { trustProxy: value });
    return createApp();
  } finally { Object.assign(env, { trustProxy: original }); }
}

function observedIp(app: Express, peer: string, forwarded: string) {
  // Real Express req.ip/req.ips getters and production requestContext, with a synthetic socket.
  // No assumption that an XFF value corresponds to an authenticated source.
  const req = Object.create(app.request) as Request;
  Object.assign(req, { app, socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } });
  let nextCalls = 0;
  requestContext(req, { setHeader() {} } as unknown as Response, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
  assert.equal(req.remoteIp, req.ip);
  return { ip: req.ip, ips: req.ips };
}

test('loopback trust ignores forged XFF from a non-loopback socket', () => {
  const result = observedIp(createApp(), '198.51.100.20', '203.0.113.77');
  assert.deepEqual(result, { ip: '198.51.100.20', ips: [] });
});

test('loopback trust accepts a forwarded claim from a loopback socket', () => {
  assert.deepEqual(observedIp(createApp(), '127.0.0.1', '203.0.113.77'),
    { ip: '203.0.113.77', ips: ['203.0.113.77'] });
});

test('loopback trust stops at nearest untrusted hop instead of attacker-prepended XFF', () => {
  assert.deepEqual(observedIp(createApp(), '127.0.0.1', '203.0.113.77, 198.51.100.20'),
    { ip: '198.51.100.20', ips: ['198.51.100.20'] });
});

test('proxy off ignores even loopback XFF', () => {
  assert.deepEqual(observedIp(appWithProxy('off'), '127.0.0.1', '203.0.113.77'),
    { ip: '127.0.0.1', ips: [] });
});

test('explicit proxy CIDR trusts only the configured socket range', () => {
  const app = appWithProxy('192.0.2.0/24');
  assert.equal(observedIp(app, '192.0.2.10', '203.0.113.77').ip, '203.0.113.77');
  assert.equal(observedIp(app, '198.51.100.20', '203.0.113.77').ip, '198.51.100.20');
});

test('private alias compiles as uniquelocal and accepts private proxy claims only', () => {
  const app = appWithProxy('private');
  assert.equal(app.get('trust proxy'), 'uniquelocal');
  assert.equal(observedIp(app, '172.18.0.1', '203.0.113.77').ip, '203.0.113.77');
  assert.equal(observedIp(app, '198.51.100.20', '203.0.113.77').ip, '198.51.100.20');
});

test('invalid trust proxy fails instead of silently falling back', () => {
  assert.throws(() => appWithProxy('synthetic-not-an-ip'), /GQXQ_TRUST_PROXY 取值无效/);
});

test('trust all warns and permits forged XFF: configuration is not source identity verification', () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const app = appWithProxy('true');
    assert.equal(observedIp(app, '198.51.100.20', '203.0.113.77').ip, '203.0.113.77');
    assert.ok(warnings.some(args => args.join(' ').includes('trust proxy=true')));
  } finally { console.warn = original; }
});
