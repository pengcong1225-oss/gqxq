// G3 出站客户端：向 public-utility 创建填报任务（HMAC-SHA256 签名 + HTTP）。
//
// 签名算法逐字取自对方 HmacRequestAuthenticator.sign(...)（已核对源码）：
//   canonical  = "v1" + LF + METHOD(大写) + LF + path + LF + timestamp + LF + nonce + LF + lowercaseHexSha256(原始 body 字节)
//   signature  = lowercaseHex(HMAC-SHA256(key = secret 的 UTF-8 字节, message = canonical 的 UTF-8 字节))
//   请求头     = X-PU-Key-Id / X-PU-Timestamp(Unix 秒) / X-PU-Nonce(每次唯一) / X-PU-Signature(小写 hex)
//   path       = /api/integrations/<app>/tasks（对方用 request.getRequestURI()，**不带 query**）
//
// ============================ 本文件最关键的实现约束 ============================
// bodySha256 必须对**实际发送的那一份原始字节**求 SHA-256。
// 所以这里刻意把"序列化"与"签名"拆成两步，并用类型把它们绑在一起：
//     serializeOnce(payload) -> SerializedBody（bodyBytes 就是唯一一份字节）
//     buildAttempt(serialized) -> SignedAttempt（签名用的是 serialized.bodySha256，bodyBytes 原样带出）
// 发送时用的是 attempt.bodyBytes，**绝不允许再 JSON.stringify 一次**。
// 两次序列化只要有任何字节差异（key 顺序、空白、转义、undefined 处理），
// 本地完全看不出问题，只有对方 401 才暴露——所以这条约束必须由代码结构保证，而不是靠注释自律。
// ==============================================================================

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../http/errors';

/** 对方 IntegrationSignatureFilter 唯一合法的路径（getRequestURI，不带 query） */
export function integrationTaskPath(appCode: string): string {
  return '/api/integrations/' + appCode + '/tasks';
}

/** 对方 MAX_BODY_BYTES = 1_048_576 */
export const MAX_PAYLOAD_BYTES = 1_048_576;

export const PU_HEADERS = {
  keyId: 'X-PU-Key-Id',
  timestamp: 'X-PU-Timestamp',
  nonce: 'X-PU-Nonce',
  signature: 'X-PU-Signature',
} as const;

export function lowercaseHexSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SignInput {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export function signIntegrationRequest(input: SignInput): string {
  // 顺序固定为 6 段，段间单个 LF；method 必须大写
  const canonical = [
    'v1',
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join('\n');
  return createHmac('sha256', Buffer.from(input.secret, 'utf8'))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex');
}

export interface SerializedBody {
  bodyText: string;
  /** 唯一一份待发送字节；签名与发送必须共用它 */
  bodyBytes: Buffer;
  bodySha256: string;
}

/**
 * **只序列化一次**：返回的 bodyBytes 就是要发出去的字节，其 sha256 已算好。
 * 超过对方 1 MiB 上限时直接拒绝（对方会回 413，本地先拦掉能省一次往返，也让错误更清楚）。
 */
export function serializeOnce(payload: Record<string, unknown>): SerializedBody {
  const bodyText = JSON.stringify(payload);
  const bodyBytes = Buffer.from(bodyText, 'utf8');
  if (bodyBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      '请求体 ' + bodyBytes.byteLength + ' 字节，超过对方 1 MiB（' + MAX_PAYLOAD_BYTES + '）上限'
    );
  }
  return { bodyText, bodyBytes, bodySha256: lowercaseHexSha256(bodyBytes) };
}

export interface SignedAttempt {
  path: string;
  nonce: string;
  timestamp: string;
  signature: string;
  bodySha256: string;
  /** 与 serializeOnce 返回的是同一个 Buffer 引用——发送时直接用它 */
  bodyBytes: Buffer;
}

/**
 * 由同一份 SerializedBody 生成一次尝试的签名材料。
 * 重试时**只换 nonce 与时间戳**，bodyBytes 始终复用，这样对方的 requestId 幂等比对才会命中"完全相同 body"。
 */
export function buildAttempt(
  serialized: SerializedBody,
  options: { nowMs?: number; nonce?: string } = {}
): SignedAttempt {
  const timestamp = String(Math.floor((options.nowMs ?? Date.now()) / 1000));
  const nonce = options.nonce ?? randomUUID();
  const path = integrationTaskPath(env.pu.appCode);
  const signature = signIntegrationRequest({
    secret: env.pu.secret,
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodySha256: serialized.bodySha256,
  });
  return { path, nonce, timestamp, signature, bodySha256: serialized.bodySha256, bodyBytes: serialized.bodyBytes };
}

/**
 * 凭证缺失时**直接失败**，不带着空 secret 去发请求。
 * 原因：config/env.ts 对 GQXQ_PU_KEY_ID / GQXQ_PU_SECRET 用的是"可空读取"，
 * 未配置时是空串，若照发只会得到对方一个语义模糊的 401；这里提前给出可诊断的错误。
 */
export function assertPuCredentials(): void {
  const missingKeys: string[] = [];
  if (env.pu.keyId === '') missingKeys.push('GQXQ_PU_KEY_ID');
  if (env.pu.secret === '') missingKeys.push('GQXQ_PU_SECRET');
  if (env.pu.baseUrl === '') missingKeys.push('GQXQ_PU_BASE_URL');
  if (missingKeys.length > 0) {
    throw AppError.internal(
      '未配置集成凭证 ' + missingKeys.join(' / ') + '，拒绝以空凭证发起调用（对方必然 401）'
    );
  }
}

export type PuTransportOutcome =
  | { kind: 'response'; httpStatus: number; bodyText: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'network_error'; message: string };

export async function postIntegrationTask(attempt: SignedAttempt): Promise<PuTransportOutcome> {
  const url = env.pu.baseUrl.replace(/\/+$/, '') + attempt.path;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.pu.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PU_HEADERS.keyId]: env.pu.keyId,
        [PU_HEADERS.timestamp]: attempt.timestamp,
        [PU_HEADERS.nonce]: attempt.nonce,
        [PU_HEADERS.signature]: attempt.signature,
      },
      // 发送的就是被签名的那一份字节，这里没有任何再序列化
      body: attempt.bodyBytes,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    return { kind: 'response', httpStatus: res.status, bodyText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return timedOut ? { kind: 'timeout', message } : { kind: 'network_error', message };
  } finally {
    clearTimeout(timer);
  }
}
