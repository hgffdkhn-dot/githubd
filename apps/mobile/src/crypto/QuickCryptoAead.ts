/**
 * React Native 的 AEAD 实现
 *
 * Hermes 引擎没有 WebCrypto，必须注入 quick-crypto。
 * 这里是整个移动端唯一允许直接调用平台密码学 API 的地方。
 *
 * 关键设计：quick-crypto 用延迟 require。
 * 它是原生模块，autolinking 失败时 import 会直接抛错；
 * 放在顶层会让整个 bundle 加载失败 —— 表现为纯白屏且看不到任何原因。
 */

import type { AeadProvider, RandomProvider } from '@e2ee/protocol';
import { configureCrypto } from '@e2ee/protocol';

const ALGORITHM = 'aes-256-gcm';
const TAG_LENGTH = 16;

interface QuickCrypto {
  createCipheriv: (
    alg: string,
    key: Uint8Array,
    nonce: Uint8Array,
    opts: { authTagLength: number },
  ) => {
    setAAD: (ad: Uint8Array) => void;
    update: (data: Uint8Array) => Uint8Array;
    final: () => void;
    getAuthTag: () => Uint8Array;
  };
  createDecipheriv: (
    alg: string,
    key: Uint8Array,
    nonce: Uint8Array,
    opts: { authTagLength: number },
  ) => {
    setAAD: (ad: Uint8Array) => void;
    setAuthTag: (tag: Uint8Array) => void;
    update: (data: Uint8Array) => Uint8Array;
    final: () => void;
  };
  getRandomValues: (out: Uint8Array) => Uint8Array;
  randomBytes?: (size: number) => Uint8Array;
}

let quickCrypto: QuickCrypto | null | undefined;

function getQuickCrypto(): QuickCrypto {
  if (quickCrypto === undefined) {
    try {
      quickCrypto = require('react-native-quick-crypto') as QuickCrypto;
    } catch (error) {
      quickCrypto = null;
      throw new Error(
        `react-native-quick-crypto 加载失败：${(error as Error).message}。` +
          '该模块是原生模块，需要开发构建（Expo Go 无法运行）。',
      );
    }
  }
  if (!quickCrypto) throw new Error('react-native-quick-crypto 不可用');
  return quickCrypto;
}

export const quickCryptoAead: AeadProvider = {
  async seal(key, nonce, plaintext, ad) {
    const crypto = getQuickCrypto();
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    if (ad && ad.length > 0) cipher.setAAD(ad);
    const ciphertext = cipher.update(plaintext);
    cipher.final();
    // GCM 认证标签必须拼接在密文末尾，缺失或截断都会让解密端无法认证
    const tag = cipher.getAuthTag();
    const out = new Uint8Array(ciphertext.length + tag.length);
    out.set(ciphertext, 0);
    out.set(tag, ciphertext.length);
    return out;
  },

  async open(key, nonce, ciphertext, ad) {
    if (ciphertext.length < TAG_LENGTH) throw new Error('AEAD: 密文长度不足以包含认证标签');
    const crypto = getQuickCrypto();
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    if (ad && ad.length > 0) decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    const plaintext = decipher.update(body);
    decipher.final(); // 认证失败会抛错，绝不返回未认证的数据
    return Uint8Array.from(plaintext);
  },
};

export const quickCryptoRandom: RandomProvider = (length) => {
  const crypto = getQuickCrypto();
  const out = new Uint8Array(length);
  if (typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(out);
  }
  if (typeof crypto.randomBytes === 'function') {
    return crypto.randomBytes(length);
  }
  throw new Error('quick-crypto 未提供可用的随机数接口');
};

/** 必须在任何密钥操作之前调用，且只调用一次 */
export function bootstrapCrypto(): void {
  configureCrypto({ aead: quickCryptoAead, random: quickCryptoRandom });
}
