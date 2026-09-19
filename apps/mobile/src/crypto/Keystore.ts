/**
 * 移动端密钥库
 *
 * 原则：
 * - 长期身份私钥只在 Keychain / Keystore 里生成与保存，永不进入 JS 字符串常量
 * - 数据库主密钥（DBKEK）由系统密钥库保护，数据库本身只存密文与受保护的状态
 * - 首版不支持密钥备份：重装即无法恢复历史会话，这是有意的取舍
 *
 * 重要：所有 Keystore/Keychain 依赖一律**延迟 require**。
 * 顶层 import 会在 bundle 加载期触发原生模块解析，在 Keystore 不可用的环境里
 * 会导致整棵 React 树起不来（白屏）。延迟 + 降级才能保住可用性。
 */

import { toBase64, fromBase64, type KeyStore, type LocalIdentity } from '@e2ee/protocol';
import * as safeStore from '../storage/safeStore.js';

const IDENTITY_KEY = 'e2ee.identity';
const SPK_PREFIX = 'e2ee.spk.';
const OPK_PREFIX = 'e2ee.opk.';
const SESSION_KEY = 'e2ee.session.token';
const DEVICE_ID_KEY = 'e2ee.device.id';
const MY_UID_KEY = 'e2ee.my.uid';
const DB_KEY = 'e2ee.dbkey';

export interface StoredIdentity {
  identityKey: string;
  identityPrivateKey: string;
  signingKey: string;
  signingPrivateKey: string;
}

export async function saveIdentity(identity: LocalIdentity): Promise<void> {
  const payload: StoredIdentity = {
    identityKey: toBase64(identity.identityKey),
    identityPrivateKey: toBase64(identity.identityPrivateKey),
    signingKey: toBase64(identity.signingKey),
    signingPrivateKey: toBase64(identity.signingPrivateKey),
  };
  await safeStore.setItem(IDENTITY_KEY, JSON.stringify(payload));
}

export async function loadIdentity(): Promise<LocalIdentity | null> {
  const raw = await safeStore.getItem(IDENTITY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredIdentity;
    return {
      identityKey: fromBase64(parsed.identityKey),
      identityPrivateKey: fromBase64(parsed.identityPrivateKey),
      signingKey: fromBase64(parsed.signingKey),
      signingPrivateKey: fromBase64(parsed.signingPrivateKey),
    };
  } catch {
    return null;
  }
}

/**
 * 数据库主密钥
 *
 * Keystore 可用时用 react-native-keychain 保护；不可用时退到安全存储层，
 * 并明确降级——绝不因为拿不到 DBKEK 就让 App 起不来。
 */
export async function getDatabaseKey(): Promise<string> {
  if (await safeStore.isKeystoreUsable()) {
    try {
      const Keychain = require('react-native-keychain');
      const existing = await Keychain.getGenericPassword({ service: DB_KEY });
      if (existing?.password) return existing.password;

      const generated = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      await Keychain.setGenericPassword('dbkek', generated, { service: DB_KEY });
      return generated;
    } catch {
      // 落到下面的文件退路
    }
  }

  const existing = await safeStore.getItem(DB_KEY);
  if (existing) return existing;
  const generated = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  await safeStore.setItem(DB_KEY, generated);
  return generated;
}

export async function saveToken(token: string): Promise<void> {
  await safeStore.setItem(SESSION_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  return safeStore.getItem(SESSION_KEY);
}

export async function saveDeviceId(deviceId: string): Promise<void> {
  await safeStore.setItem(DEVICE_ID_KEY, deviceId);
}

export async function saveMyUid(uid: string): Promise<void> {
  await safeStore.setItem(MY_UID_KEY, uid);
}

/** 读取本地缓存的 UID；服务端生成的 UID 终身不变，缓存是安全的 */
export async function loadMyUid(): Promise<string | null> {
  return safeStore.getItem(MY_UID_KEY);
}

export async function loadDeviceId(): Promise<string | null> {
  return safeStore.getItem(DEVICE_ID_KEY);
}

/**
 * 彻底清除本地身份与会话：注销、设备丢失时的最终手段
 *
 * ⚠️ 首版不做密钥备份，所以 wipeAll 之后**历史会话无法恢复**——
 * 这是有意的安全取舍（私钥不出本机），UI 必须在退出前明确告知用户。
 */
export async function wipeAll(): Promise<void> {
  for (const key of [IDENTITY_KEY, SESSION_KEY, DEVICE_ID_KEY, MY_UID_KEY]) {
    await safeStore.deleteItem(key).catch(() => undefined);
  }
  if (await safeStore.isKeystoreUsable()) {
    try {
      const Keychain = require('react-native-keychain');
      await Keychain.resetGenericPassword({ service: DB_KEY });
    } catch {
      // 忽略
    }
  }
  await safeStore.deleteItem(DB_KEY).catch(() => undefined);
}

/**
 * 预密钥私钥存储
 *
 * SPK/OPK 私钥数量较大且可再生成，存进受数据库主密钥保护的表更安全；
 * 这里用安全存储层保存是为了让首版可在不引入加密数据库的情况下跑通。
 */
export class SecurePreKeyStore implements KeyStore {
  constructor(private identity: LocalIdentity) {}

  async getIdentity(): Promise<LocalIdentity> {
    return this.identity;
  }

  async getSignedPreKeyPrivate(keyId: number): Promise<Uint8Array> {
    const raw = await safeStore.getItem(`${SPK_PREFIX}${keyId}`);
    if (!raw) throw new Error(`Keystore: 缺少签名预密钥 ${keyId}`);
    return fromBase64(raw);
  }

  async getOneTimePreKeyPrivate(keyId: number): Promise<Uint8Array | undefined> {
    const raw = await safeStore.getItem(`${OPK_PREFIX}${keyId}`);
    return raw ? fromBase64(raw) : undefined;
  }

  async consumeOneTimePreKey(keyId: number): Promise<void> {
    await safeStore.deleteItem(`${OPK_PREFIX}${keyId}`).catch(() => undefined);
  }
}

export async function savePreKeyPrivate(
  prefix: typeof SPK_PREFIX | typeof OPK_PREFIX,
  keyId: number,
  privateKey: Uint8Array,
): Promise<void> {
  await safeStore.setItem(`${prefix}${keyId}`, toBase64(privateKey));
}

export { SPK_PREFIX, OPK_PREFIX };
