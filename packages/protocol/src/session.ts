/**
 * SessionManager —— X3DH + Double Ratchet 的编排层
 *
 * 职责边界：
 * - 只处理"会话状态 + 字节"，不认识 WebSocket、不认识 UI、不碰数据库 SQL
 * - 私钥访问一律走 KeyStore 接口，便于在移动端替换为 Keychain / Keystore
 * - 解密失败一律抛错，调用方负责标记消息失败，不允许回退到未加密路径
 */

import { RatchetSession, deserializeHeader, serializeHeader } from './ratchet.js';
import { wipe, x25519KeyPairFromPrivateKey } from './primitives.js';
import { buildAssociatedData, x3dhInitiate, x3dhRespond } from './x3dh.js';
import type {
  Envelope,
  LocalIdentity,
  PreKeyBundle,
  PublicIdentity,
  RatchetState,
  SkippedKeyEntry,
} from './types.js';
import { randomBytes } from './primitives.js';
import { bytesToHex } from './encoding.js';

export interface KeyStore {
  getIdentity(): Promise<LocalIdentity>;
  getSignedPreKeyPrivate(keyId: number): Promise<Uint8Array>;
  getOneTimePreKeyPrivate(keyId: number): Promise<Uint8Array | undefined>;
  /** 认领后必须本地删除，防止同一 OPK 被二次握手复用 */
  consumeOneTimePreKey(keyId: number): Promise<void>;
}

export interface SessionRecord {
  state: RatchetState;
  skippedKeys: SkippedKeyEntry[];
  /** 首条消息必须携带 X3DH 材料；进程重启后仍需补发，因此随会话一起持久化 */
  pendingX3dh?: NonNullable<Envelope['x3dh']>;
}

export interface SessionStore {
  load(peerKey: string): Promise<SessionRecord | undefined>;
  save(peerKey: string, record: SessionRecord): Promise<void>;
  remove(peerKey: string): Promise<void>;
}

export function peerKeyOf(userId: string, deviceId: string): string {
  return `${userId}::${deviceId}`;
}

export class SessionManager {
  private sessions = new Map<string, RatchetSession>();

  constructor(
    private readonly identity: LocalIdentity,
    private readonly keyStore: KeyStore,
    private readonly sessionStore: SessionStore,
    private readonly self: { userId: string; deviceId: string },
  ) {}

  get publicIdentity(): PublicIdentity {
    return { identityKey: this.identity.identityKey, signingKey: this.identity.signingKey };
  }

  private async getSession(peerKey: string): Promise<RatchetSession | undefined> {
    const cached = this.sessions.get(peerKey);
    if (cached) return cached;

    const record = await this.sessionStore.load(peerKey);
    if (!record) return undefined;

    const session = new RatchetSession(record.state);
    session.restoreSkippedKeys(record.skippedKeys);
    if (record.pendingX3dh) this.pendingX3dh.set(peerKey, record.pendingX3dh);
    this.sessions.set(peerKey, session);
    return session;
  }

  private async persist(peerKey: string, session: RatchetSession): Promise<void> {
    await this.sessionStore.save(peerKey, {
      state: session.state,
      skippedKeys: session.exportSkippedKeys(),
      pendingX3dh: this.pendingX3dh.get(peerKey),
    });
  }

  /** 发起方：拿到对端 Bundle 后建立会话。Bundle 签名校验失败会直接抛错 */
  async startSession(bundle: PreKeyBundle): Promise<void> {
    const peerKey = peerKeyOf(bundle.userId, bundle.deviceId);
    const result = x3dhInitiate(this.identity, bundle);

    const state: RatchetState = {
      rootKey: result.rootKey,
      dhSelfPrivate: result.ephemeralPrivate,
      dhSelfPublic: result.ephemeralPublic,
      dhRemotePublic: bundle.signedPreKey.publicKey,
      sendingChainKey: result.sendingChainKey,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      previousChainLength: 0,
      remoteIdentity: { identityKey: bundle.identityKey, signingKey: bundle.signingKey },
      associatedData: result.associatedData,
    };

    const session = new RatchetSession(state);
    this.sessions.set(peerKey, session);
    this.pendingX3dh.set(peerKey, {
      identityKey: this.identity.identityKey,
      signingKey: this.identity.signingKey,
      ephemeralPublic: result.ephemeralPublic,
      usedOneTimePreKeyId: result.usedOneTimePreKeyId,
      usedSignedPreKeyId: bundle.signedPreKey.keyId,
    });
    // 注意：ephemeralPrivate 已转交给棘轮作为首轮本地私钥，此处绝不能清零，
    // 否则后续 DH 棘轮会用到全零私钥。它会在棘轮推进时被新密钥对替换。
    await this.persist(peerKey, session);
  }

  private pendingX3dh = new Map<string, NonNullable<Envelope['x3dh']>>();

  async hasSession(userId: string, deviceId: string): Promise<boolean> {
    return (await this.getSession(peerKeyOf(userId, deviceId))) !== undefined;
  }

  /** 加密：会话不存在时抛错，由调用方先 fetch Bundle 再 startSession */
  async encrypt(peerUserId: string, peerDeviceId: string, plaintext: string): Promise<Envelope> {
    const peerKey = peerKeyOf(peerUserId, peerDeviceId);
    const session = await this.getSession(peerKey);
    if (!session) throw new Error(`SessionManager: 与 ${peerKey} 尚无会话，请先建立 X3DH`);

    const { header, nonce, ciphertext } = await session.encrypt(new TextEncoder().encode(plaintext));
    await this.persist(peerKey, session);

    const x3dh = this.pendingX3dh.get(peerKey);
    if (x3dh) this.pendingX3dh.delete(peerKey);

    return {
      envelopeId: bytesToHex(randomBytes(16)),
      senderUserId: this.self.userId,
      senderDeviceId: this.self.deviceId,
      recipientUserId: peerUserId,
      recipientDeviceId: peerDeviceId,
      x3dh,
      header,
      nonce,
      ciphertext,
      createdAt: Date.now(),
    };
  }

  /** 解密：首包自动完成 X3DH 响应方计算，后续走棘轮 */
  async decrypt(envelope: Envelope): Promise<string> {
    const peerKey = peerKeyOf(envelope.senderUserId, envelope.senderDeviceId);
    let session = await this.getSession(peerKey);

    if (envelope.x3dh) {
      if (session) throw new Error('SessionManager: 已存在会话却收到 X3DH 首包，疑似重放');

      const signedPreKeyPrivate = await this.keyStore.getSignedPreKeyPrivate(
        envelope.x3dh.usedSignedPreKeyId,
      );
      const oneTimePreKeyPrivate = envelope.x3dh.usedOneTimePreKeyId
        ? await this.keyStore.getOneTimePreKeyPrivate(envelope.x3dh.usedOneTimePreKeyId)
        : undefined;

      const result = x3dhRespond({
        localIdentity: this.identity,
        signedPreKeyPrivate,
        oneTimePreKeyPrivate,
        remote: {
          identityKey: envelope.x3dh.identityKey,
          ephemeralPublic: envelope.x3dh.ephemeralPublic,
        },
      });

      const spk = x25519KeyPairFromPrivateKey(signedPreKeyPrivate);
      const state: RatchetState = {
        rootKey: result.rootKey,
        dhSelfPrivate: spk.privateKey,
        dhSelfPublic: spk.publicKey,
        dhRemotePublic: envelope.x3dh.ephemeralPublic,
        receivingChainKey: result.receivingChainKey,
        sendMessageNumber: 0,
        receiveMessageNumber: 0,
        previousChainLength: 0,
        remoteIdentity: {
          identityKey: envelope.x3dh.identityKey,
          signingKey: envelope.x3dh.signingKey ?? new Uint8Array(32),
        },
        associatedData: buildAssociatedData(envelope.x3dh.identityKey, this.identity.identityKey),
      };

      session = new RatchetSession(state);
      this.sessions.set(peerKey, session);

      if (envelope.x3dh.usedOneTimePreKeyId) {
        await this.keyStore.consumeOneTimePreKey(envelope.x3dh.usedOneTimePreKeyId);
      }
    }

    if (!session) throw new Error(`SessionManager: 无法解密 ${peerKey} 的消息，缺少会话`);

    const plaintext = await session.decrypt(envelope.header, envelope.nonce, envelope.ciphertext);
    await this.persist(peerKey, session);
    return new TextDecoder().decode(plaintext);
  }

  async resetSession(peerUserId: string, peerDeviceId: string): Promise<void> {
    const peerKey = peerKeyOf(peerUserId, peerDeviceId);
    this.sessions.delete(peerKey);
    this.pendingX3dh.delete(peerKey);
    await this.sessionStore.remove(peerKey);
  }
}

export { serializeHeader, deserializeHeader };
