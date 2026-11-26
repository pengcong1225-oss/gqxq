import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import * as oidc from 'openid-client';
import { AppError } from '../http/errors';
import { ok } from '../http/respond';
import type { AuthIdentity } from '../repositories/userRepo';

const API_CALLBACK = '/api/v1/auth/oidc/callback';
const OIDC_AUTHORIZATION = '/api/integrations/gqxq/authorization';
const SESSION_COOKIE = 'gqxq_oidc_session';
const TRANSACTION_MS = 300_000;
const TIMEOUT_MS = 3_000;
const random = () => randomBytes(32).toString('base64url');
const unavailable = () => new AppError('SOURCE_ADAPTER_UNAVAILABLE', '住新平台授权暂不可用，请稍后重试');
const expired = () => AppError.unauthenticated('住新平台会话或诉求授权已失效，请重新登录');

interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionTtlSeconds: number;
}
interface OidcDependencies {
  findIdentity(subject: string): Promise<AuthIdentity | null>;
  userInfo(userId: string): Promise<unknown>;
  auditLogin(user: AuthIdentity, req: Request): Promise<void>;
}
interface Transaction {
  cookie: string;
  nonce: string;
  verifier: string;
  expires: number;
  screen: boolean;
}
interface Session {
  marker: string;
  subject: string;
  accessToken: string;
  userId: string;
  version: number;
  expires: number;
}

function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('住新 OIDC 仅允许 HTTPS 或本机回环 HTTP');
  }
  return url;
}

function cookie(req: Request, key: string): string | undefined {
  const prefix = key + '=';
  return req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

function equal(a: string, b: string | undefined): boolean {
  return b !== undefined && a.length === b.length &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function prune<T extends { expires: number }>(items: Map<string, T>, limit: number) {
  for (const [key, item] of items) {
    if (item.expires <= Date.now()) items.delete(key);
  }
  if (items.size >= limit) throw unavailable();
}

export function isOidcSessionMarker(token: string): boolean {
  return token.startsWith('oidc-cookie:');
}

export function createOidcRelyingParty(options: OidcOptions, deps: OidcDependencies) {
  const router = Router();
  const issuer = trustedUrl(options.issuer);
  const redirectUri = trustedUrl(options.redirectUri);
  if (!redirectUri.pathname.endsWith(API_CALLBACK) || !options.clientId.trim() ||
      !options.clientSecret.trim() || !Number.isSafeInteger(options.sessionTtlSeconds) || options.sessionTtlSeconds <= 0) {
    throw new Error('诉求 OIDC 客户端配置不完整');
  }
  const basePath = redirectUri.pathname.slice(0, -API_CALLBACK.length);
  const startUrl = new URL(`${basePath}/api/v1/auth/oidc/start`, redirectUri).href;
  const sessionOptions = { httpOnly: true, sameSite: 'lax' as const,
    secure: redirectUri.protocol === 'https:', path: basePath || '/' };
  const transactionOptions = { ...sessionOptions, path: redirectUri.pathname };
  const pending = new Map<string, Transaction>();
  const sessions = new Map<string, Session>();
  const expectedOrigin = (req: Request) => `${req.protocol}://${req.get('host')}` === redirectUri.origin;
  const prepare = (res: Response) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const destination = (result: 'complete' | 'denied' | 'unavailable', screen = false) =>
    `${basePath}/login?oidc=${result}${screen ? '&view=screen' : ''}`;
  const encode = (input: string) => new URLSearchParams({ v: input }).toString().slice(2);
  const credential = Buffer.from(`${encode(options.clientId)}:${encode(options.clientSecret)}`).toString('base64');
  let discovery: Promise<oidc.Configuration> | undefined;

  function provider() {
    if (!discovery) {
      const execute = [oidc.enableNonRepudiationChecks];
      if (issuer.protocol === 'http:') execute.unshift(oidc.allowInsecureRequests);
      discovery = oidc.discovery(
        issuer, options.clientId, { id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(options.clientSecret), { execute, timeout: TIMEOUT_MS / 1000 },
      ).catch(() => {
        discovery = undefined;
        throw unavailable();
      });
    }
    return discovery;
  }

  async function authorizedAccount(subject: string, accessToken: string): Promise<string | null> {
    try {
      const response = await fetch(new URL(OIDC_AUTHORIZATION, issuer), {
        method: 'POST',
        headers: { authorization: `Basic ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject, accessToken }),
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('unexpected authorization response');
      const grant = await response.json() as { active?: boolean; subject?: string; legacyAccountId?: string };
      if (grant?.subject !== subject || typeof grant.active !== 'boolean') throw new Error('unexpected authorization identity');
      if (!grant.active) return null;
      if (typeof grant.legacyAccountId !== 'string' || !grant.legacyAccountId || grant.legacyAccountId.length > 64)
        throw new Error('invalid business account binding');
      return grant.legacyAccountId;
    } catch {
      throw unavailable();
    }
  }

  async function readSession(req: Request, marker?: string) {
    const key = cookie(req, SESSION_COOKIE);
    const session = key && sessions.get(key);
    if (!expectedOrigin(req) || !key || !session || (marker !== undefined && !equal(session.marker, marker))) throw expired();
    if (session.expires <= Date.now()) {
      sessions.delete(key);
      throw expired();
    }
    const grantedId = await authorizedAccount(session.subject, session.accessToken);
    const identity = grantedId === session.userId ? await deps.findIdentity(session.subject) : null;
    if (!identity || identity.userId !== session.userId || identity.status !== 1 ||
      identity.sessionVersion !== session.version || session.expires <= Date.now() || sessions.get(key) !== session) {
      sessions.delete(key);
      throw expired();
    }
    return { session, identity };
  }

  router.get('/auth/oidc/start', async (req, res, next) => {
    try {
      prepare(res);
      const screen = req.query.view === 'screen';
      if (!expectedOrigin(req)) {
        return res.redirect(302, screen ? `${startUrl}?view=screen` : startUrl);
      }
      prune(pending, 1000);
      const config = await provider();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const browser = random();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri.href, scope: 'openid', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      pending.set(state, { cookie: browser, nonce, verifier, expires: Date.now() + TRANSACTION_MS, screen });
      return res.cookie(`gqxq_oidc_tx_${state}`, browser, { ...transactionOptions, maxAge: TRANSACTION_MS }).redirect(302, url.href);
    } catch (error) { next(error); }
  });

  router.get('/auth/oidc/callback', async (req, res, next) => {
    prepare(res);
    const callback = new URL(redirectUri);
    callback.search = new URL(req.originalUrl, redirectUri).search;
    const states = callback.searchParams.getAll('state');
    const state = states[0];
    const transaction = pending.get(state);
    if (!expectedOrigin(req) || states.length !== 1 || !transaction || transaction.expires <= Date.now() ||
        !equal(transaction.cookie, cookie(req, `gqxq_oidc_tx_${state}`))) return next(expired());
    pending.delete(state);
    res.clearCookie(`gqxq_oidc_tx_${state}`, transactionOptions);
    try {
      const config = await provider();
      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(config, callback, {
          pkceCodeVerifier: transaction.verifier, expectedState: state,
          expectedNonce: transaction.nonce, idTokenExpected: true,
        });
      } catch {
        return res.redirect(303, destination('denied', transaction.screen));
      }
      const subject = tokens.claims()?.sub;
      if (typeof subject !== 'string' || !subject || subject !== subject.trim() || subject.length > 191 || !tokens.access_token)
        return res.redirect(303, destination('denied', transaction.screen));
      const grantedId = await authorizedAccount(subject, tokens.access_token);
      const identity = grantedId ? await deps.findIdentity(subject) : null;
      if (!identity || identity.status !== 1 || identity.userId !== grantedId)
        return res.redirect(303, destination('denied', transaction.screen));
      const maxAge = Math.min(options.sessionTtlSeconds, tokens.expires_in ?? options.sessionTtlSeconds) * 1000;
      if (!Number.isFinite(maxAge) || maxAge <= 0) return res.redirect(303, destination('denied', transaction.screen));
      prune(sessions, 5000);
      await deps.auditLogin(identity, req);
      const previous = cookie(req, SESSION_COOKIE);
      if (previous) sessions.delete(previous);
      const key = random();
      sessions.set(key, { marker: `oidc-cookie:${random()}`, subject, accessToken: tokens.access_token,
        userId: identity.userId, version: identity.sessionVersion, expires: Date.now() + maxAge });
      return res.cookie(SESSION_COOKIE, key, { ...sessionOptions, maxAge }).redirect(303, destination('complete', transaction.screen));
    } catch (error) {
      if (error instanceof AppError && error.errorCode === 'SOURCE_ADAPTER_UNAVAILABLE')
        return res.redirect(303, destination('unavailable', transaction.screen));
      return next(error);
    }
  });

  router.get('/auth/oidc/session', async (req, res, next) => {
    try {
      prepare(res);
      const { session, identity } = await readSession(req);
      ok(res, { token: session.marker, userInfo: await deps.userInfo(identity.userId) });
    } catch (error) { next(error); }
  });

  router.post('/auth/oidc/logout', (req, res, next) => {
    prepare(res);
    if (!expectedOrigin(req) || (req.get('origin') && req.get('origin') !== redirectUri.origin))
      return next(AppError.forbidden());
    const key = cookie(req, SESSION_COOKIE);
    if (key) sessions.delete(key);
    res.clearCookie(SESSION_COOKIE, sessionOptions);
    return ok(res, { loggedOut: true });
  });

  return {
    router,
    startUrl,
    async authenticate(req: Request, marker?: string): Promise<AuthIdentity> {
      if (!marker || !isOidcSessionMarker(marker)) throw expired();
      return (await readSession(req, marker)).identity;
    },
  };
}
