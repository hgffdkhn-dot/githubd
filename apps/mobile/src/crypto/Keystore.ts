/**
 * 移动端密钥库
 *
 * 原则：
 * - 长期身份私钥只在 Keychain / Keystore 里生成与保存，永不进入 JS 字符串常量
 * - 数据库主密钥（DBKEK）由系统密钥库保护，数据库本身只存密文与受保护的状态
 * - 首版不支持密钥备份：重装即无法恢复历史会话，这是有意的取舍
 */

import * as SecureStore from 'expo-secure-store';
import * as Keychain from 'react-native-keychain';
import { toBase64, fromBase64, type KeyStore, type LocalIdentity } from '@e2ee/protocol';

const IDENTITY_KEY = 'e2ee.identity';
const SPK_PREFIX = 'e2ee.spk.';
const OPK_PREFIX = 'e2ee.opk.';
const SESSION_KEY = 'e2ee.session.token';
const DEVICE_ID_KEY = 'e2ee.device.id';

async function setSecret(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function getSecret(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

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
  await setSecret(IDENTITY_KEY, JSON.stringify(payload));
}

export async function loadIdentity(): Promise<LocalIdentity | null> {
  const raw = await getSecret(IDENTITY_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredIdentity;
  return {
    identityKey: fromBase64(parsed.identityKey),
    identityPrivateKey: fromBase64(parsed.identityPrivateKey),
    signingKey: fromBase64(parsed.signingKey),
    signingPrivateKey: fromBase64(parsed.signingPrivateKey),
  };
}

/** 数据库主密钥：由系统密钥库生成并保存，JS 层只拿到引用 */
export async function getDatabaseKey(): Promise<string> {
  const existing = await Keychain.getGenericPassword({ service: 'e2ee.dbkey' });
  if (existing) return existing.password;

  const generated = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  await Keychain.setGenericPassword('dbkek', generated, {
    service: 'e2ee.dbkey',
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return generated;
}

export async function saveToken(token: string): Promise<void> {
  await setSecret(SESSION_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  return getSecret(SESSION_KEY);
}

export async function saveDeviceId(deviceId: string): Promise<void> {
  await setSecret(DEVICE_ID_KEY, deviceId);
}

export async function loadDeviceId(): Promise<string | null> {
  return getSecret(DEVICE_ID_KEY);
}

/** 彻底清除本地身份与会话：注销、设备丢失时的最终手段 */
export async function wipeAll(): Promise<void> {
  for (const key of [IDENTITY_KEY, SESSION_KEY, DEVICE_ID_KEY]) {
    await SecureStore.deleteItemAsync(key).catch(() => undefined);
  }
  await Keychain.resetGenericPassword({ service: 'e2ee.dbkey' }).catch(() => undefined);
}

/**
 * 预密钥私钥存储
 *
 * SPK/OPK 私钥数量较大且可再生成，存进受数据库主密钥保护的表更安全；
 * 这里用 SecureStore 保存是为了让首版可在不引入加密数据库的情况下跑通。
 */
export class SecurePreKeyStore implements KeyStore {
  constructor(private identity: LocalIdentity) {}

  async getIdentity(): Promise<LocalIdentity> {
    return this.identity;
  }

  async getSignedPreKeyPrivate(keyId: number): Promise<Uint8Array> {
    const raw = await getSecret(`${SPK_PREFIX}${keyId}`);
    if (!raw) throw new Error(`Keystore: 缺少签名预密钥 ${keyId}`);
    return fromBase64(raw);
  }

  async getOneTimePreKeyPrivate(keyId: number): Promise<Uint8Array | undefined> {
    const raw = await getSecret(`${OPK_PREFIX}${keyId}`);
    return raw ? fromBase64(raw) : undefined;
  }

  async consumeOneTimePreKey(keyId: number): Promise<void> {
    await SecureStore.deleteItemAsync(`${OPK_PREFIX}${keyId}`).catch(() => undefined);
  }
}

export async function savePreKeyPrivate(prefix: typeof SPK_PREFIX | typeof OPK_PREFIX, keyId: number, privateKey: Uint8Array): Promise<void> {
  await setSecret(`${prefix}${keyId}`, toBase64(privateKey));
}

export { SPK_PREFIX, OPK_PREFIX };
