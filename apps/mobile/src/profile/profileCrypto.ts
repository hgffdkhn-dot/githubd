/**
 * 个人资料加密
 *
 * friends 模式下服务端只存密文，解密权在两端手里。
 *
 * 密钥设计（关键）：
 *  - 自己的资料：由自己身份私钥派生，服务端无法解密
 *  - 好友的资料：用「自己身份私钥 × 对方身份公钥」做 ECDH 再派生
 *    —— 双方都能算出同一个密钥（各自用自己的私钥），而服务端只有两个公钥，算不出来
 *
 * ⚠️ 这是静态-静态 ECDH，没有前向安全：身份私钥一旦泄露，历史资料密文全部可解。
 * 但身份私钥泄露本身就意味着整个账户失守，此处可接受。
 */

import {
  deriveKey,
  x25519SharedSecret,
  seal,
  open,
  toBase64,
  fromBase64,
} from '@e2ee/protocol';

export interface ProfilePayload {
  /** 昵称 */
  displayName: string;
  /** 个人简介 */
  bio: string;
  /** 头像背景色（本地生成，不上传图片） */
  avatarBg: string;
  /** 头像文字（昵称首字） */
  avatarInitial: string;
}

const SELF_SALT = new Uint8Array([0xe2, 0xee, 0x70, 0x01]);
const PEER_SALT = new Uint8Array([0xe2, 0xee, 0x70, 0x02]);

/** 自己的资料密钥：只要身份私钥还在就能解开 */
export function ownProfileKey(identityPrivate: Uint8Array): Uint8Array {
  return deriveKey(identityPrivate, SELF_SALT, 'e2ee/own-profile', 32);
}

/** 与某个好友之间的资料密钥：双方各自都能算出，服务端不能 */
export function peerProfileKey(
  selfIdentityPrivate: Uint8Array,
  peerIdentityPublic: Uint8Array,
): Uint8Array {
  const shared = x25519SharedSecret(selfIdentityPrivate, peerIdentityPublic);
  return deriveKey(shared, PEER_SALT, 'e2ee/peer-profile', 32);
}

export async function sealProfile(
  key: Uint8Array,
  payload: ProfilePayload,
): Promise<{ nonce: string; ciphertext: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const { ciphertext, nonce } = await seal(key, bytes, new Uint8Array(0));
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

export async function openProfile(
  key: Uint8Array,
  enc: { nonce?: string; ciphertext?: string },
): Promise<ProfilePayload | null> {
  if (!enc?.nonce || !enc?.ciphertext) return null;
  try {
    const bytes = await open(key, fromBase64(enc.nonce), fromBase64(enc.ciphertext), new Uint8Array(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as ProfilePayload;
  } catch {
    // 密钥不匹配（例如对方换了身份）不应崩溃，当作没有资料
    return null;
  }
}

/** 头像文字：中文取首字，英文取首字母大写 */
export function initialOf(displayName: string, fallback = '?'): string {
  const trimmed = displayName.trim();
  if (!trimmed) return fallback;
  const first = trimmed[0];
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
}

/** 由 userId 稳定地挑一个头像底色，保证同一人每次一致 */
const AVATAR_COLORS = [
  '#6750a4',
  '#0b5ca5',
  '#006964',
  '#286a3d',
  '#a3511f',
  '#962d46',
  '#5c4b8a',
  '#1c6b73',
];

export function avatarColorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
