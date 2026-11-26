import { readFileSync } from 'node:fs';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { findAuthIdentity } from '../repositories/userRepo';
import { auditSuccessfulLogin, currentUser } from '../services/authService';
import { findManagedBySubject } from './managedIdentity';
import { createOidcRelyingParty } from './oidcRelyingParty';

function configuredOidc() {
  const file = process.env.GQXQ_OIDC_CLIENT_CREDENTIALS_FILE;
  if (!file) return null;
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!values || ['issuer', 'client_id', 'client_secret', 'redirect_uri'].some(
      (key) => typeof values[key] !== 'string' || !values[key].trim(),
    )) throw new Error();
  } catch {
    throw new Error('无法读取诉求 OIDC 私有客户端配置');
  }
  return createOidcRelyingParty({
    issuer: values.issuer as string,
    clientId: values.client_id as string,
    clientSecret: values.client_secret as string,
    redirectUri: values.redirect_uri as string,
    sessionTtlSeconds: env.jwtTtlSeconds,
  }, {
    async findIdentity(subject) {
      // UCenter OIDC and the existing managed assignment protocol share the immutable platform user ID.
      const binding = await findManagedBySubject(env.platformIdentityIssuer, subject);
      if (!binding || binding.issuer !== env.platformIdentityIssuer || binding.subject !== subject) return null;
      return findAuthIdentity(pool, binding.userId);
    },
    userInfo: currentUser,
    auditLogin: (identity, req) => auditSuccessfulLogin(identity, { clientIp: req.remoteIp, requestId: req.requestId }, 'oidc'),
  });
}

export const gqxqOidc = configuredOidc();
