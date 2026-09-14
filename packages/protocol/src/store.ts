/** 内存版 KeyStore / SessionStore：测试与联调用，移动端请替换为 Keystore + SQLCipher 实现 */

import type { KeyStore, SessionRecord, SessionStore } from './session.js';
import type { LocalIdentity } from './types.js';
import { wipe } from './primitives.js';

export class InMemoryKeyStore implements KeyStore {
  private signedPreKeys = new Map<number, Uint8Array>();
  private oneTimePreKeys = new Map<number, Uint8Array>();

  constructor(private identity: LocalIdentity) {}

  async getIdentity(): Promise<LocalIdentity> {
    return this.identity;
  }

  addSignedPreKey(keyId: number, privateKey: Uint8Array): void {
    this.signedPreKeys.set(keyId, privateKey);
  }

  addOneTimePreKey(keyId: number, privateKey: Uint8Array): void {
    this.oneTimePreKeys.set(keyId, privateKey);
  }

  get remainingOneTimePreKeys(): number {
    return this.oneTimePreKeys.size;
  }

  async getSignedPreKeyPrivate(keyId: number): Promise<Uint8Array> {
    const key = this.signedPreKeys.get(keyId);
    if (!key) throw new Error(`KeyStore: 缺少签名预密钥 ${keyId}`);
    return key;
  }

  async getOneTimePreKeyPrivate(keyId: number): Promise<Uint8Array | undefined> {
    return this.oneTimePreKeys.get(keyId);
  }

  async consumeOneTimePreKey(keyId: number): Promise<void> {
    const key = this.oneTimePreKeys.get(keyId);
    this.oneTimePreKeys.delete(keyId);
    if (key) wipe(key);
  }
}

export class InMemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();

  async load(peerKey: string): Promise<SessionRecord | undefined> {
    return this.records.get(peerKey);
  }

  async save(peerKey: string, record: SessionRecord): Promise<void> {
    this.records.set(peerKey, record);
  }

  async remove(peerKey: string): Promise<void> {
    this.records.delete(peerKey);
  }
}
