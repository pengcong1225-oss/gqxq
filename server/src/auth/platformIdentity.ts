// 平台统一身份令牌校验：住新工作服务平台以 RS256 签发，公钥从其 JWKS 端点获取。
// 本模块处理验签与旧有平台绑定查询。
import jwt from 'jsonwebtoken';
import { createPublicKey, type KeyObject } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../config/env';
import { pool } from '../db/pool';

interface PlatformClaims {
  iss?: string;
  sub?: string;
  username?: string;
  realName?: string;
  roles?: string[];
  permissions?: string[];
  exp?: number;
  jti?: string;
  auth_version?: number;
}

const ISSUER = env.platformIdentityIssuer;
const JWKS_URL = env.platformIdentityJwksUrl;
const TIMEOUT_MS = 3000;

let cachedKeys = new Map<string, KeyObject>();
let cachedAt = 0;

async function fetchKeys(force = false): Promise<Map<string, KeyObject>> {
  const fresh = Date.now() - cachedAt < 10 * 60 * 1000;
  if (!force && fresh && cachedKeys.size > 0) return cachedKeys;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(JWKS_URL, { signal: controller.signal });
    if (!response.ok) throw new Error('平台 JWKS 响应异常');
    const body = (await response.json()) as { keys?: Array<Record<string, unknown>> };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    }
    if (next.size === 0) throw new Error('平台 JWKS 无可用公钥');
    cachedKeys = next;
    cachedAt = Date.now();
    return next;
  } finally {
    clearTimeout(timer);
  }
}

/** 校验平台令牌并返回 claims；非本平台签发一律返回 null，由调用方继续按本地令牌处理。 */
export async function verifyPlatformToken(token: string): Promise<PlatformClaims | null> {
  if (!env.platformIdentityEnabled || !token) return null;
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') return null;
  if ((decoded.header as { alg?: string }).alg !== 'RS256') return null;
  const kid = (decoded.header as { kid?: string }).kid;
  if (!kid) return null;
  try {
    let keys = await fetchKeys();
    let key = keys.get(kid);
    if (!key) {
      keys = await fetchKeys(true);
      key = keys.get(kid);
    }
    if (!key) return null;
    const claims = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: ISSUER || undefined,
      clockTolerance: 30,
    }) as PlatformClaims;
    if (!claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

/** 读取 platform_identity 绑定；未绑定返回 null（绝不按用户名自动匹配）。 */
export async function findBoundUserId(issuer: string, subject: string): Promise<string | null> {
  const [rows] = (await pool.query(
    'select user_id from platform_identity where issuer = ? and subject = ? limit 1',
    [issuer, subject],
  )) as unknown as [Array<{ user_id: string }>, unknown];
  return rows.length > 0 ? rows[0].user_id : null;
}

export function bearerToken(req: Request): string {
  const header = req.header('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  return matched ? matched[1] : '';
}
