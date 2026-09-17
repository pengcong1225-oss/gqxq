// public-utility 回调签名（G4 入站）。
//
// ⚠️ 与宜接就办入站 / G3 出站的算法**完全不同**，切勿复用：
//   入站/出站：v1 \n METHOD \n path \n timestamp \n nonce \n bodySha256
//   本回调  ：epochSeconds \n bodySha256          <- 没有 v1、没有 method/path/nonce
// 多一段或少一段都会验签失败。
//
// 权威来源（对方已通过测试的实现）：
//   public-utility .../callback/CallbackSignatureService.java:14-24
//     digest    = HexFormat.of().formatHex(sha256(exactBody))          // 小写 hex
//     canonical = (epochSeconds + "\n" + digest).getBytes(UTF_8)
//     signature = HexFormat.of().formatHex(HmacSHA256(secret, canonical))
//   .../callback/HttpCallbackTransport.java:106-110 请求头名称
//
// 关键约束：bodySha256 必须对**实际收到的原始字节**求摘要。
// 对 JSON.parse 后再 JSON.stringify 的结果求摘要会因键序/空白/转义差异而验签失败，
// 因此 app.ts 必须用 express.json 的 verify 回调缓存 rawBody，路由再对缓存字节求摘要。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 时间戳允许的偏差（秒）。与 gqxq→public-utility 入站契约的 ±300s 口径保持一致。
 *
 * 注意偏差超限时的返回码选择：调用方（HttpCallbackTransport.classify）把
 * 408/425/429/5xx 视为**可重试**，其余一律**永久失败不再重试**。
 * 因此"签名有效但时间戳过旧"绝不能返回 401 —— 那会让一条合法事件被永久丢弃。
 * 这里返回 503（可重试），让发送方在时钟对齐后重投；重投时 eventId 幂等会兜住重复。
 */
export const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function sha256Hex(exactBody: Buffer): string {
  return createHash('sha256').update(exactBody).digest('hex');
}

/** canonical = epochSeconds + LF + lowercaseHexSha256(exactBody) */
export function callbackCanonical(epochSeconds: number, exactBody: Buffer): string {
  return String(epochSeconds) + '\n' + sha256Hex(exactBody);
}

/**
 * 签名实现。与对方 CallbackSignatureService.sign 逐字节等价。
 * 服务端唯一的签名实现（routes 只调用它）。
 * 注意：scripts/mock-public-utility-callback.mjs **故意独立重实现**同一算法，
 * 两份实现相互独立才有验证价值——共用一份代码会把实现里的错误一起掩盖掉。
 */
export function signCallback(secret: string, epochSeconds: number, exactBody: Buffer): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(callbackCanonical(epochSeconds, exactBody), 'utf8'))
    .digest('hex');
}

export type SignatureFailureReason = 'signature_malformed' | 'signature_mismatch';

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason };

/** 常量时间比较，避免按字节比较泄露签名信息 */
export function verifyCallbackSignature(
  secret: string,
  epochSeconds: number,
  exactBody: Buffer,
  signatureHeader: string
): SignatureCheck {
  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) {
    return { ok: false, reason: 'signature_malformed' };
  }
  const expectedBytes = Buffer.from(signCallback(secret, epochSeconds, exactBody), 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return timingSafeEqual(expectedBytes, providedBytes)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}
