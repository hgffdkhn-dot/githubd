/**
 * 字节编码工具
 *
 * 所有密钥、密文在网络与数据库中一律以 base64 传输，避免 JSON 承载二进制时
 * 出现"隐式 UTF-8 解码"导致的密钥损坏。
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS[i]] = i;

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean[i]];
    const c1 = B64_LOOKUP[clean[i + 1]];
    const c2 = B64_LOOKUP[clean[i + 2]];
    const c3 = B64_LOOKUP[clean[i + 3]];
    if (c0 === undefined || c1 === undefined) throw new Error('base64: 非法字符');
    out[p++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) out[p++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 !== undefined) out[p++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, p);
}

export function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 定长拼接，用于构造 HKDF info / AD，防止字段边界歧义 */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 带长度前缀的拼接：所有变长字段都必须走这里，避免"可移动字段边界"攻击 */
export function concatWithLength(...parts: Uint8Array[]): Uint8Array {
  const prefix = new Uint8Array(parts.length * 4);
  const view = new DataView(prefix.buffer);
  parts.forEach((p, i) => view.setUint32(i * 4, p.length, false));
  return concat(prefix, ...parts);
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
