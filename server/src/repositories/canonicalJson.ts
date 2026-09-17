// 规范化 JSON 与摘要。
// 作用：把「同一条业务报文」的不同字段顺序、不同空白统一成同一个字节序列，
// 这样幂等比对不会因为发送方重排 key 而误判成「内容变了」。
// 约定：递归按键名排序（Array 保序），undefined 直接不参与序列化；
// 哈希一律 sha256 的**小写 hex**，与库里的 char(64) 对齐。
import { createHash } from 'node:crypto';

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = normalize(source[key]);
  }
  return out;
}

/** 递归按键名排序后的紧凑 JSON 字符串 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(normalize(value));
  // 顶层是 undefined/function 时 JSON.stringify 返回 undefined，兜底成 'null'
  return text === undefined ? 'null' : text;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** payload 摘要：sha256(canonicalJson(payload))，小写 hex */
export function payloadHashOf(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
