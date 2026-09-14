/**
 * 密码学原语层
 *
 * 设计原则：
 * 1. 这一层只暴露"最小可用"的原语，任何业务代码不得直接调用曲线库。
 * 2. 随机数与 AEAD 通过 provider 注入，因为 React Native(Hermes) 没有 WebCrypto，
 *    必须替换为 react-native-quick-crypto；Node 侧默认走 globalThis.crypto。
 * 3. 生产环境应把整个 protocol 包替换为 libsignal(AGPL-3.0) 或 vodozemac(Apache-2.0)
 *    的原生绑定，此文件仅用于让协议流程可运行、可测试、可审计。
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';

export interface AeadProvider {
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Promise<Uint8Array>;
  open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Promise<Uint8Array>;
}

export interface RandomProvider {
  (length: number): Uint8Array;
}

/** Node / 现代浏览器：WebCrypto 的 AES-256-GCM */
export const webCryptoAead: AeadProvider = {
  async seal(key, nonce, plaintext, ad) {
    const ck = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: ad as BufferSource, tagLength: 128 },
      ck,
      plaintext as BufferSource,
    );
    return new Uint8Array(ct);
  },
  async open(key, nonce, ciphertext, ad) {
    const ck = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: ad as BufferSource, tagLength: 128 },
      ck,
      ciphertext as BufferSource,
    );
    return new Uint8Array(pt);
  },
};

const nodeRandom: RandomProvider = (length) => {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  return nobleRandomBytes(length);
};

let aead: AeadProvider = webCryptoAead;
let rng: RandomProvider = nodeRandom;

/** 在 React Native 启动时调用：注入 quick-crypto 实现 */
export function configureCrypto(opts: { aead?: AeadProvider; random?: RandomProvider }): void {
  if (opts.aead) aead = opts.aead;
  if (opts.random) rng = opts.random;
}

export function randomBytes(length: number): Uint8Array {
  return rng(length);
}

export const KEY_SIZE = 32;
export const NONCE_SIZE = 12;

/* ---------------- X25519: 密钥协商 ---------------- */

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateX25519KeyPair(): KeyPair {
  const privateKey = randomBytes(KEY_SIZE);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function x25519KeyPairFromPrivateKey(privateKey: Uint8Array): KeyPair {
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * X25519 协商。必须校验输出不全零，否则小阶/低阶点会产出恒定共享秘密，
 * 使"看似加密"的通道实际密钥固定。
 */
export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_SIZE) throw new Error('X25519: 公钥长度必须为 32 字节');
  const secret = x25519.getSharedSecret(privateKey, publicKey);
  if (secret.length !== KEY_SIZE) throw new Error('X25519: 共享秘密长度异常');
  let allZero = true;
  for (const b of secret) if (b !== 0) { allZero = false; break; }
  if (allZero) throw new Error('X25519: 拒绝全零共享秘密（疑似低阶公钥）');
  return secret;
}

/* ---------------- Ed25519: 签名 ---------------- */

export function generateEd25519KeyPair(): KeyPair {
  const privateKey = randomBytes(KEY_SIZE);
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export function ed25519KeyPairFromPrivateKey(privateKey: Uint8Array): KeyPair {
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export function ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function ed25519Verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  if (publicKey.length !== KEY_SIZE) return false;
  if (signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/* ---------------- HKDF-SHA256 ---------------- */

/**
 * HKDF-SHA256 (RFC 5869)
 * info 必须包含协议版本、角色、用途，否则不同上下文可能派生出同一密钥。
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/** 一次性派生固定长度密钥的最短写法 */
export function deriveKey(ikm: Uint8Array, salt: Uint8Array, info: string, length = KEY_SIZE): Uint8Array {
  return hkdfSha256(ikm, salt, new TextEncoder().encode(info), length);
}

/* ---------------- AEAD: AES-256-GCM ---------------- */

export async function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  if (key.length !== KEY_SIZE) throw new Error('AEAD: 密钥必须是 32 字节');
  const nonce = randomBytes(NONCE_SIZE);
  const ciphertext = await aead.seal(key, nonce, plaintext, ad);
  return { ciphertext, nonce };
}

/** 认证失败必须抛错且由调用方终止流程，绝不返回部分明文 */
export async function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  if (key.length !== KEY_SIZE) throw new Error('AEAD: 密钥必须是 32 字节');
  if (nonce.length !== NONCE_SIZE) throw new Error('AEAD: nonce 必须是 12 字节');
  return aead.open(key, nonce, ciphertext, ad);
}

/* ---------------- HMAC-SHA256: 棘轮链 ---------------- */

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

/** 尽力清零：JS 无法保证不可变字符串被清除，但对仍在作用域内的缓冲有实际作用 */
export function wipe(...buffers: Uint8Array[]): void {
  for (const buf of buffers) if (buf) buf.fill(0);
}
