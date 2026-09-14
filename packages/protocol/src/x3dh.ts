/**
 * X3DH (Extended Triple Diffie-Hellman) —— Signal 规范的异步握手
 *
 * 解决的问题：接收方完全离线时，发起方仍能建立"相互认证 + 前向安全"的共享密钥。
 *
 * 与 libsignal 的差异（生产替换时必须对齐）：
 * - libsignal 用 XEdDSA 在一条 Curve25519 密钥上同时完成 DH 与签名；
 *   这里拆成 X25519(DH) + Ed25519(签名) 两条独立密钥，语义更清晰，但 wire format 与 Signal 不兼容。
 * - 生产环境请直接替换为 libsignal / vodozemac 的原生实现。
 */

import {
  deriveKey,
  ed25519Sign,
  ed25519Verify,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  randomBytes,
  wipe,
  x25519SharedSecret,
  type KeyPair,
} from './primitives.js';
import { bytesToHex, concat, concatWithLength } from './encoding.js';
import type {
  LocalIdentity,
  OneTimePreKey,
  PreKeyBundle,
  PreKeyBundleUpload,
  PublicIdentity,
  SignedPreKey,
  X3dhResult,
} from './types.js';

const PROTOCOL_VERSION = 'E2EEChat/X3DH/v1';
const FILL = new Uint8Array(32).fill(0xff);
const ZERO_SALT = new Uint8Array(32);

/** 长期身份：X25519 用于 DH，Ed25519 用于给 SPK 签名 */
export function generateIdentity(): LocalIdentity {
  const dh = generateX25519KeyPair();
  const sign = generateEd25519KeyPair();
  return {
    identityKey: dh.publicKey,
    identityPrivateKey: dh.privateKey,
    signingKey: sign.publicKey,
    signingPrivateKey: sign.privateKey,
  };
}

export function publicPart(identity: LocalIdentity): PublicIdentity {
  return { identityKey: identity.identityKey, signingKey: identity.signingKey };
}

export interface GeneratedPreKeys {
  signedPreKey: SignedPreKey & { privateKey: Uint8Array };
  oneTimePreKeys: (OneTimePreKey & { privateKey: Uint8Array })[];
}

export function generatePreKeys(
  identity: LocalIdentity,
  signedPreKeyId: number,
  startOneTimeId: number,
  count = 50,
): GeneratedPreKeys {
  const spk: KeyPair = generateX25519KeyPair();
  const signature = ed25519Sign(identity.signingPrivateKey, spk.publicKey);

  const oneTimePreKeys: GeneratedPreKeys['oneTimePreKeys'] = [];
  for (let i = 0; i < count; i++) {
    const opk = generateX25519KeyPair();
    oneTimePreKeys.push({ keyId: startOneTimeId + i, publicKey: opk.publicKey, privateKey: opk.privateKey });
  }

  return {
    signedPreKey: { keyId: signedPreKeyId, publicKey: spk.publicKey, signature, privateKey: spk.privateKey },
    oneTimePreKeys,
  };
}

/** 构造上传给服务端的 Bundle（只含公开材料） */
export function buildBundleUpload(
  identity: LocalIdentity,
  deviceId: string,
  keys: GeneratedPreKeys,
): PreKeyBundleUpload {
  return {
    userId: '',
    deviceId,
    identityKey: identity.identityKey,
    signingKey: identity.signingKey,
    signedPreKey: {
      keyId: keys.signedPreKey.keyId,
      publicKey: keys.signedPreKey.publicKey,
      signature: keys.signedPreKey.signature,
    },
    oneTimePreKeys: keys.oneTimePreKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
  };
}

/** 校验 Bundle：签名错误必须直接拒绝，不允许"跳过验证继续握手" */
export function verifyBundle(bundle: PreKeyBundle): void {
  if (!ed25519Verify(bundle.signingKey, bundle.signedPreKey.signature, bundle.signedPreKey.publicKey)) {
    throw new Error('X3DH: 签名预密钥签名校验失败，拒绝握手');
  }
}

function kdfInputs(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array, dh4?: Uint8Array): Uint8Array {
  return dh4 ? concat(FILL, dh1, dh2, dh3, dh4) : concat(FILL, dh1, dh2, dh3);
}

function expandSharedSecret(ikm: Uint8Array): { rootKey: Uint8Array; sendingChainKey: Uint8Array } {
  const rootKey = deriveKey(ikm, ZERO_SALT, `${PROTOCOL_VERSION}/root`);
  const sendingChainKey = deriveKey(ikm, ZERO_SALT, `${PROTOCOL_VERSION}/sending-chain`);
  return { rootKey, sendingChainKey };
}

/** 关联数据绑定双方身份公钥，阻止"身份替换"类攻击 */
export function buildAssociatedData(alice: Uint8Array, bob: Uint8Array): Uint8Array {
  return concatWithLength(alice, bob);
}

/**
 * 发起方（Alice）：从服务端拿到 Bundle → 校验签名 → 生成临时密钥 → 得到 SK
 * 返回的 ephemeral 私钥必须交给 Double Ratchet 作为首轮棘轮私钥，用后即弃。
 */
export function x3dhInitiate(
  localIdentity: LocalIdentity,
  bundle: PreKeyBundle,
): X3dhResult & { ephemeralPrivate: Uint8Array } {
  verifyBundle(bundle);

  const ephemeral = generateX25519KeyPair();

  const dh1 = x25519SharedSecret(localIdentity.identityPrivateKey, bundle.signedPreKey.publicKey);
  const dh2 = x25519SharedSecret(ephemeral.privateKey, bundle.identityKey);
  const dh3 = x25519SharedSecret(ephemeral.privateKey, bundle.signedPreKey.publicKey);
  const dh4 = bundle.oneTimePreKey
    ? x25519SharedSecret(ephemeral.privateKey, bundle.oneTimePreKey.publicKey)
    : undefined;

  const ikm = kdfInputs(dh1, dh2, dh3, dh4);
  const { rootKey, sendingChainKey } = expandSharedSecret(ikm);

  wipe(dh1, dh2, dh3);
  if (dh4) wipe(dh4);

  return {
    rootKey,
    sendingChainKey,
    associatedData: buildAssociatedData(localIdentity.identityKey, bundle.identityKey),
    ephemeralPublic: ephemeral.publicKey,
    ephemeralPrivate: ephemeral.privateKey,
    usedOneTimePreKeyId: bundle.oneTimePreKey?.keyId,
  };
}

/**
 * 接收方（Bob）：收到首条信封 → 用自己的 SPK/OPK 私钥复算 SK
 * 结果与 Alice 侧完全一致，因为 X25519 对称。
 */
export function x3dhRespond(params: {
  localIdentity: LocalIdentity;
  signedPreKeyPrivate: Uint8Array;
  oneTimePreKeyPrivate?: Uint8Array;
  remote: { identityKey: Uint8Array; ephemeralPublic: Uint8Array };
}): { rootKey: Uint8Array; receivingChainKey: Uint8Array; associatedData: Uint8Array } {
  const { localIdentity, signedPreKeyPrivate, oneTimePreKeyPrivate, remote } = params;

  const dh1 = x25519SharedSecret(signedPreKeyPrivate, remote.identityKey);
  const dh2 = x25519SharedSecret(localIdentity.identityPrivateKey, remote.ephemeralPublic);
  const dh3 = x25519SharedSecret(signedPreKeyPrivate, remote.ephemeralPublic);
  const dh4 = oneTimePreKeyPrivate
    ? x25519SharedSecret(oneTimePreKeyPrivate, remote.ephemeralPublic)
    : undefined;

  const ikm = kdfInputs(dh1, dh2, dh3, dh4);
  const { rootKey, sendingChainKey } = expandSharedSecret(ikm);

  wipe(dh1, dh2, dh3);
  if (dh4) wipe(dh4);

  return {
    rootKey,
    receivingChainKey: sendingChainKey,
    associatedData: buildAssociatedData(remote.identityKey, localIdentity.identityKey),
  };
}

/** 随机生成设备 ID，不应由服务端指定，避免服务端影响密钥身份 */
export function generateDeviceId(): string {
  return bytesToHex(randomBytes(8));
}
