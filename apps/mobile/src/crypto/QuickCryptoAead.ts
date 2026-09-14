/**
 * React Native 的 AEAD 实现
 *
 * Hermes 引擎没有 WebCrypto，必须注入 quick-crypto。
 * 这里是整个移动端唯一允许直接调用平台密码学 API 的地方。
 */

import { createCipheriv, createDecipheriv, getRandomValues } from 'react-native-quick-crypto';
import { configureCrypto, type AeadProvider, type RandomProvider } from '@e2ee/protocol';

const ALGORITHM = 'aes-256-gcm';
const TAG_LENGTH = 16;

export const quickCryptoAead: AeadProvider = {
  async seal(key, nonce, plaintext, ad) {
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    if (ad && ad.length > 0) cipher.setAAD(ad);
    const ciphertext = cipher.update(plaintext);
    cipher.final();
    // GCM 认证标签必须拼接在密文末尾，缺失或截断都会让解密端无法认证
    return Uint8Array.from(Buffer.concat([Buffer.from(ciphertext), Buffer.from(cipher.getAuthTag())]));
  },
  async open(key, nonce, ciphertext, ad) {
    if (ciphertext.length < TAG_LENGTH) throw new Error('AEAD: 密文长度不足以包含认证标签');
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    if (ad && ad.length > 0) decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    const plaintext = decipher.update(body);
    decipher.final(); // 认证失败会抛错，绝不返回未认证的数据
    return Uint8Array.from(Buffer.from(plaintext));
  },
};

export const quickCryptoRandom: RandomProvider = (length) => {
  const out = new Uint8Array(length);
  getRandomValues(out);
  return out;
};

/** 必须在任何密钥操作之前调用，且只调用一次 */
export function bootstrapCrypto(): void {
  configureCrypto({ aead: quickCryptoAead, random: quickCryptoRandom });
}
