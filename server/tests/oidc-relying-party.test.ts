import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { createOidcRelyingParty } from '../src/auth/oidcRelyingParty';
import { AppError } from '../src/http/errors';

const clientId = 'gqxq';
const clientSecret = 'oidc-test-client';
const subject = 'portal-subject';
const userId = 'legacy-business-account';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'test' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function listen(t: import('node:test').TestContext, app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}

test('OIDC keeps the existing business account, verifies every request, and rejects a reopened grant’s old session', async (t) => {
  const idp = express();
  const app = express();
  const [issuer, base] = await Promise.all([listen(t, idp), listen(t, app)]);
  const callback = `${base}/api/v1/auth/oidc/callback`;
  const authorizations = new Map<string, { codeChallenge: string; nonce: string; subject: string }>();
  const tokens = new Map<string, { subject: string; revision: number }>();
  let revision = 1;
  let selectedAccount = userId;
  let active = true;
  let outage = false;
  idp.get('/.well-known/openid-configuration', (_req, res) => res.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  }));
  idp.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  idp.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const entry = authorizations.get(req.body.code);
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const [client, secret] = Buffer.from(encoded ?? '', 'base64').toString().split(':').map(decodeURIComponent);
    if (!entry || scheme !== 'Basic' || client !== clientId || secret !== clientSecret || req.body.redirect_uri !== callback ||
      createHash('sha256').update(req.body.code_verifier).digest('base64url') !== entry.codeChallenge)
      return res.status(400).json({ error: 'invalid_grant' });
    authorizations.delete(req.body.code);
    const now = Math.floor(Date.now() / 1000);
    const message = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
      iss: issuer, sub: entry.subject, aud: clientId, nonce: entry.nonce, iat: now, exp: now + 300, roles: ['admin'],
    })}`;
    tokens.set(req.body.code, { subject: entry.subject, revision });
    return res.json({ access_token: req.body.code, token_type: 'Bearer', expires_in: 300,
      id_token: `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}` });
  });
  idp.post('/api/integrations/gqxq/authorization', express.json(), (req, res) => {
    assert.equal(req.headers.authorization, basic);
    const token = tokens.get(req.body.accessToken);
    if (outage) return res.sendStatus(502);
    if (!active || token?.subject !== req.body.subject || token?.revision !== revision)
      return res.json({ active: false, subject: req.body.subject });
    return res.json({ active: true, subject: req.body.subject, legacyAccountId: selectedAccount });
  });
  const identity = { userId, username: 'operator', status: 1, sessionVersion: 2,
    accountType: 'business' as const, roles: ['operator'], mustChangePassword: false };
  const rp = createOidcRelyingParty({ issuer, clientId, clientSecret, redirectUri: callback, sessionTtlSeconds: 300 }, {
    findIdentity: async (value) => value === subject ? identity : null,
    userInfo: async () => ({ userId, roles: ['operator'] }),
    auditLogin: async () => undefined,
  });
  app.use('/api/v1', rp.router);
  app.get('/protected', async (req, res, next) => {
    try { res.json(await rp.authenticate(req, req.header('authorization')?.slice(7))); }
    catch (error) { next(error); }
  });
  const sendTestError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof AppError) res.status(error.status).json({ message: error.message });
    else next(error);
  };
  app.use(sendTestError);
  const call = (route: string, options = {}) => fetch(`${base}${route}`, { redirect: 'manual', ...options });
  async function login(subjectToUse = subject, view = '') {
    const start = await call(`/api/v1/auth/oidc/start${view}`);
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('location')!);
    const state = url.searchParams.get('state')!;
    const code = `code-${state}`;
    authorizations.set(code, { subject: subjectToUse, nonce: url.searchParams.get('nonce')!, codeChallenge: url.searchParams.get('code_challenge')! });
    const path = `/api/v1/auth/oidc/callback?${new URLSearchParams({ state, code })}`;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call(path)).status, 401);
    const complete = await call(path, { headers: { cookie } });
    assert.equal((await call(path, { headers: { cookie } })).status, 401);
    return complete;
  }
  const response = await login(subject, '?view=screen');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/login?oidc=complete&view=screen');
  const cookie = response.headers.getSetCookie().find((v) => v.startsWith('gqxq_oidc_session='))!;
  assert.match(cookie, /HttpOnly/i);
  const headers = { cookie: cookie.split(';')[0] };
  const session = await call('/api/v1/auth/oidc/session', { headers }).then((r) => r.json());
  assert.deepEqual(session.data.userInfo, { userId, roles: ['operator'] });
  assert.match(session.data.token, /^oidc-cookie:/);
  const auth = { ...headers, authorization: `Bearer ${session.data.token}` };
  assert.equal((await call('/protected', { headers })).status, 401);
  assert.equal((await call('/protected', { headers: { authorization: auth.authorization } })).status, 401);
  assert.equal((await call('/protected', { headers: auth })).status, 200);
  outage = true;
  assert.equal((await call('/protected', { headers: auth })).status, 502);
  outage = false;
  active = false;
  revision += 1;
  active = true;
  assert.equal((await call('/protected', { headers: auth })).status, 401);
  assert.equal((await login()).headers.get('location'), '/login?oidc=complete');
  assert.equal((await login('unbound-subject')).headers.get('location'), '/login?oidc=denied');
  selectedAccount = 'another-business-account';
  assert.equal((await login()).headers.get('location'), '/login?oidc=denied');
  selectedAccount = userId;
  identity.status = 0;
  assert.equal((await login()).headers.get('location'), '/login?oidc=denied');
});
