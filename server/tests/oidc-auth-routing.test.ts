import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';

test('configured OIDC disables the legacy exchange while preserving the independent login route', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'gqxq-oidc-config-'));
  const config = join(folder, 'oidc.json');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oldKey = { ...publicKey.export({ format: 'jwk' }), kid: 'legacy', use: 'sig' };
  let legacyRequests = 0;
  const legacyJwks = createServer((_req, res) => {
    legacyRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [oldKey] }));
  });
  await new Promise<void>((resolve) => legacyJwks.listen(0, '127.0.0.1', resolve));
  const address = legacyJwks.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(config, JSON.stringify({
    issuer: 'http://127.0.0.1:1',
    client_id: 'gqxq',
    client_secret: 'test-oidc-rp',
    redirect_uri: 'http://127.0.0.1:8099/api/v1/auth/oidc/callback',
  }));
  process.env.GQXQ_OIDC_CLIENT_CREDENTIALS_FILE = config;
  process.env.GQXQ_PLATFORM_IDENTITY_ENABLED = 'true';
  process.env.GQXQ_PLATFORM_IDENTITY_JWKS_URL = `http://127.0.0.1:${address.port}/jwks`;
  t.after(async () => {
    delete process.env.GQXQ_OIDC_CLIENT_CREDENTIALS_FILE;
    legacyJwks.closeAllConnections();
    await new Promise<void>((resolve) => legacyJwks.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  const { createApp } = await import('../src/app');
  const app = request(createApp());
  const metadata = await app.get('/api/v1/auth/oidc/status').expect(200);
  assert.deepEqual(metadata.body.data, {
    enabled: true,
    startUrl: 'http://127.0.0.1:8099/api/v1/auth/oidc/start',
  });
  await app.post('/api/v1/auth/platform-session').set('Authorization', 'Bearer old-portal-token').expect(403);
  const legacyToken = jwt.sign({ sub: 'legacy-subject' }, privateKey, {
    algorithm: 'RS256', keyid: oldKey.kid, issuer: 'zhuxin-platform', expiresIn: 300,
  });
  await app.get('/api/v1/auth/user-info').set('Authorization', `Bearer ${legacyToken}`).expect(401);
  assert.equal(legacyRequests, 0);
  await app.post('/api/v1/auth/login').send({}).expect(400);
});
