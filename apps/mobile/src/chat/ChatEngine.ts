/**
 * ChatEngine —— 把协议、存储、网络缝在一起的业务引擎
 *
 * 关键设计：
 * - 发消息时若还没有会话，自动拉取对端 Bundle 建立 X3DH
 * - 收到信封先解密，成功才写库并 ack；失败则标记 failed，绝不重试到明文
 * - 一次性预密钥低于阈值时自动补充
 */

import {
  SessionManager,
  decodeEnvelope,
  encodeEnvelope,
  generateIdentity,
  generatePreKeys,
  fromBase64,
  peerKeyOf,
  computeSafetyNumber,
  type Envelope,
  type EnvelopeDto,
  type LocalIdentity,
  type PreKeyBundle,
  type GeneratedPreKeys,
} from '@e2ee/protocol';

import { ApiClient } from '../network/Api.js';
import { MessageStream } from '../network/MessageStream.js';
import { SecurePreKeyStore, loadIdentity, loadToken, saveIdentity, saveDeviceId, loadDeviceId, saveToken, savePreKeyPrivate, SPK_PREFIX, OPK_PREFIX } from '../crypto/Keystore.js';
import { SqliteSessionStore } from '../storage/SessionRepository.js';
import { saveMessage, updateMessageStatus, listMessages, openDatabase } from '../storage/Database.js';
import { bootstrapCrypto } from '../crypto/QuickCryptoAead.js';
import { ProfileManager, type ResolvedProfile } from '../profile/ProfileManager.js';
import { PresenceManager, type DisplayPresence } from '../presence/PresenceManager.js';
import type { MyDevice } from '../network/Api.js';

type OwnProfileView = ResolvedProfile;
export type { OwnProfileView, DisplayPresence, MyDevice };

const OPK_BATCH_SIZE = 50;
const OPK_REPLENISH_THRESHOLD = 20;
const SPK_ROTATION_MS = 7 * 24 * 3600 * 1000;

export interface DecryptedMessage {
  envelopeId: string;
  peerKey: string;
  direction: 'in' | 'out';
  text: string;
  createdAt: number;
  status: string;
}

export class ChatEngine {
  readonly api: ApiClient;
  private stream: MessageStream | null = null;
  private manager: SessionManager | null = null;
  private identity: LocalIdentity | null = null;
  private deviceId = '';
  private userId = '';
  private token = '';
  private presence: PresenceManager | null = null;
  private profiles: ProfileManager | null = null;
  private nextOpkId = 1;
  private spkId = 1;
  private spkGeneratedAt = 0;
  private listeners = new Set<(message: DecryptedMessage) => void>();

  constructor(baseUrl: string) {
    // 只做不会失败的事：注入 provider 与建 API 客户端。
    // SQLite 打开推迟到 start()，避免构造期异常让整棵树起不来。
    bootstrapCrypto();
    this.api = new ApiClient(baseUrl);
  }

  onMessage(listener: (message: DecryptedMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(message: DecryptedMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  get self(): { userId: string; deviceId: string; identityKey: Uint8Array } | null {
    if (!this.identity) return null;
    return { userId: this.userId, deviceId: this.deviceId, identityKey: this.identity.identityKey };
  }

  /** 当前会话令牌，供资料/在线状态等模块复用 */
  get authToken(): string {
    return this.token;
  }

  /** 身份私钥：仅用于派生资料密钥，绝不外传 */
  get identityPrivateKey(): Uint8Array | null {
    return this.identity?.identityPrivateKey ?? null;
  }

  /** 在线状态上报开关；关闭后服务端对他人返回"不显示" */
  async startPresence(shareOnline: boolean): Promise<void> {
    if (!this.token) return;
    if (!this.presence) {
      this.presence = new PresenceManager(this.api, async () => this.token);
    }
    await this.presence.start(shareOnline);
  }

  setPresenceSharing(value: boolean): void {
    this.presence?.setShareOnline(value);
  }

  stopPresence(): void {
    this.presence?.stop();
  }

  async fetchPresence(userIds: string[]): Promise<Record<string, DisplayPresence>> {
    if (!this.token) return {};
    if (!this.presence) this.presence = new PresenceManager(this.api, async () => this.token);
    return this.presence.fetch(userIds);
  }

  // ------------------------------------------------------------------
  // 设备管理
  // ------------------------------------------------------------------

  async listMyDevices(): Promise<MyDevice[]> {
    if (!this.token) throw new Error('未登录');
    return this.api.listMyDevices(this.token);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.token) throw new Error('未登录');
    await this.api.revokeDevice(this.token, deviceId);
  }

  // ------------------------------------------------------------------
  // 个人主页
  // ------------------------------------------------------------------

  /** 自己的资料；friends 模式下服务端只存密文，本地解开 */
  async loadMyProfile(): Promise<OwnProfileView> {
    if (!this.token || !this.identity) throw new Error('未登录');
    if (!this.profiles) {
      this.profiles = new ProfileManager(this.api, {
        identityPrivateKey: this.identity.identityPrivateKey,
      });
      this.profiles.setTokenProvider(async () => this.token);
    }
    return this.profiles.loadOwn(this.userId);
  }

  async saveMyProfile(
    input: { displayName: string; bio: string },
    visibility: 'friends' | 'public',
  ): Promise<void> {
    if (!this.token || !this.identity) throw new Error('未登录');
    if (!this.profiles) {
      this.profiles = new ProfileManager(this.api, {
        identityPrivateKey: this.identity.identityPrivateKey,
      });
      this.profiles.setTokenProvider(async () => this.token);
    }
    await this.profiles.saveOwn(this.userId, input, visibility);
  }

  /**
   * 读取对方资料。
   * friends 模式需要对方身份公钥才能解密 —— 握过手就有，没有则显示锁定态。
   */
  async loadPeerProfile(userId: string): Promise<OwnProfileView> {
    if (!this.token || !this.identity) throw new Error('未登录');
    if (!this.profiles) {
      this.profiles = new ProfileManager(this.api, {
        identityPrivateKey: this.identity.identityPrivateKey,
      });
      this.profiles.setTokenProvider(async () => this.token);
    }

    // 对方身份公钥属于公开材料（服务端本就持有），用它配合自己的私钥派生资料密钥。
    // 服务端只有两个公钥，做不出 ECDH，因此解不开密文。
    let peerIdentity: Uint8Array | undefined;
    try {
      const devices = await this.api.listDevices(this.token, userId);
      peerIdentity = devices[0] ? fromBase64(devices[0].identityKey) : undefined;
    } catch {
      peerIdentity = undefined;
    }
    return this.profiles.loadPeer(userId, peerIdentity);
  }

  /** 首次启动：生成身份与预密钥；已注册设备则直接复用 */
  private async ensureIdentity(): Promise<LocalIdentity> {
    const existing = await loadIdentity();
    if (existing) return existing;

    const identity = generateIdentity();
    await saveIdentity(identity);
    return identity;
  }

  private async ensureDeviceId(): Promise<string> {
    const existing = await loadDeviceId();
    if (existing) return existing;
    const deviceId = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await saveDeviceId(deviceId);
    return deviceId;
  }

  /** 铸造一批新预密钥：SPK 自增，OPK 成批续号，私钥只进安全存储 */
  private mintPreKeyBundle(): GeneratedPreKeys {
    const bundle = generatePreKeys(this.identity!, this.spkId, this.nextOpkId, OPK_BATCH_SIZE);
    this.spkId += 1;
    this.nextOpkId += OPK_BATCH_SIZE;
    this.spkGeneratedAt = Date.now();
    return bundle;
  }

  private async persistPreKeyBundle(bundle: GeneratedPreKeys): Promise<void> {
    await savePreKeyPrivate(SPK_PREFIX, bundle.signedPreKey.keyId, bundle.signedPreKey.privateKey);
    for (const opk of bundle.oneTimePreKeys) {
      await savePreKeyPrivate(OPK_PREFIX, opk.keyId, opk.privateKey);
    }
  }

  /** 登录态下按需轮换 SPK：旧 SPK 私钥保留一个宽限期，用于解密迟到消息 */
  async rotateSignedPreKeyIfNeeded(): Promise<void> {
    if (!this.identity || !this.token) return;
    if (Date.now() - this.spkGeneratedAt < SPK_ROTATION_MS) return;

    const bundle = this.mintPreKeyBundle();
    await this.persistPreKeyBundle(bundle);
    await this.api.publishPreKeys(this.token, { signedPreKey: bundle.signedPreKey, oneTimePreKeys: bundle.oneTimePreKeys });
  }

  async register(username: string, password: string): Promise<void> {
    this.identity = await this.ensureIdentity();
    this.deviceId = await this.ensureDeviceId();
    const bundle = this.mintPreKeyBundle();

    const result = await this.api.register({
      username,
      password,
      deviceId: this.deviceId,
      identity: this.identity,
      preKeys: bundle,
    });
    await this.persistPreKeyBundle(bundle);
    await this.completeAuth(result);
  }

  async login(username: string, password: string): Promise<void> {
    this.identity = await this.ensureIdentity();
    this.deviceId = await this.ensureDeviceId();
    const result = await this.api.login({ username, password, deviceId: this.deviceId, identity: this.identity });
    await this.completeAuth(result);
    await this.rotateSignedPreKeyIfNeeded();
  }

  async restoreSession(): Promise<boolean> {
    const token = await loadToken();
    const identity = await loadIdentity();
    const deviceId = await loadDeviceId();
    if (!token || !identity || !deviceId) return false;
    this.token = token;
    this.identity = identity;
    this.deviceId = deviceId;
    return true;
  }

  private async completeAuth(result: { userId: string; deviceId: string; token: string }): Promise<void> {
    this.userId = result.userId;
    this.deviceId = result.deviceId;
    this.token = result.token;
    await saveToken(result.token);

    this.manager = new SessionManager(
      this.identity!,
      new SecurePreKeyStore(this.identity!),
      new SqliteSessionStore(),
      { userId: this.userId, deviceId: this.deviceId },
    );
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('ChatEngine: 未登录');
    openDatabase();
    if (!this.manager) {
      this.manager = new SessionManager(
        this.identity!,
        new SecurePreKeyStore(this.identity!),
        new SqliteSessionStore(),
        { userId: this.userId, deviceId: this.deviceId },
      );
    }

    this.stream = new MessageStream(this.api.baseUrl, () => this.token, {
      onEnvelope: (dto) => {
        void this.handleIncoming(dto);
      },
      onPreKeyLow: (remaining) => {
        if (remaining < OPK_REPLENISH_THRESHOLD) void this.replenishOneTimePreKeys();
      },
    });
    this.stream.connect();

    // 重连/冷启动后补齐离线消息
    await this.drainPending();
  }

  private async replenishOneTimePreKeys(): Promise<void> {
    if (!this.identity) return;
    const bundle = generatePreKeys(this.identity, this.spkId - 1, this.nextOpkId, OPK_BATCH_SIZE);
    this.nextOpkId += OPK_BATCH_SIZE;
    for (const opk of bundle.oneTimePreKeys) {
      await savePreKeyPrivate(OPK_PREFIX, opk.keyId, opk.privateKey);
    }
    await this.api.publishPreKeys(this.token, { oneTimePreKeys: bundle.oneTimePreKeys });
  }

  async drainPending(): Promise<void> {
    const pending = await this.api.fetchPending(this.token);
    const acked: string[] = [];
    for (const dto of pending) {
      const ok = await this.handleIncoming(dto);
      if (ok) acked.push(dto.envelopeId);
    }
    if (acked.length > 0) {
      await this.api.acknowledge(this.token, acked);
      this.stream?.ack(acked);
    }
  }

  /** 返回 true 表示成功解密并入库，可以 ack */
  private async handleIncoming(dto: EnvelopeDto): Promise<boolean> {
    if (!this.manager) return false;
    const envelope = decodeEnvelope(dto);
    const peerKey = peerKeyOf(envelope.senderUserId, envelope.senderDeviceId);

    try {
      const text = await this.manager.decrypt(envelope);
      saveMessage({
        envelopeId: envelope.envelopeId,
        peerKey,
        direction: 'in',
        ciphertext: dto.ciphertext,
        nonce: dto.nonce,
        header: JSON.stringify(dto.header),
        createdAt: envelope.createdAt,
        status: 'delivered',
      });
      this.emit({
        envelopeId: envelope.envelopeId,
        peerKey,
        direction: 'in',
        text,
        createdAt: envelope.createdAt,
        status: 'delivered',
      });
      return true;
    } catch (error) {
      // 解密失败必须可见：静默丢弃会让用户以为只是没消息
      saveMessage({
        envelopeId: envelope.envelopeId,
        peerKey,
        direction: 'in',
        ciphertext: dto.ciphertext,
        nonce: dto.nonce,
        header: JSON.stringify(dto.header),
        createdAt: envelope.createdAt,
        status: 'failed',
      });
      this.emit({
        envelopeId: envelope.envelopeId,
        peerKey,
        direction: 'in',
        text: `[无法解密] ${(error as Error).message}`,
        createdAt: envelope.createdAt,
        status: 'failed',
      });
      return false;
    }
  }

  async sendText(peerUserId: string, peerDeviceId: string, text: string): Promise<void> {
    if (!this.manager) throw new Error('ChatEngine: 未初始化会话管理器');
    const peerKey = peerKeyOf(peerUserId, peerDeviceId);

    if (!(await this.manager.hasSession(peerUserId, peerDeviceId))) {
      const bundle = await this.api.fetchBundle(this.token, peerUserId, peerDeviceId);
      await this.manager.startSession(bundle);
    }

    const envelope = await this.manager.encrypt(peerUserId, peerDeviceId, text);
    const dto = encodeEnvelope(envelope);

    saveMessage({
      envelopeId: envelope.envelopeId,
      peerKey,
      direction: 'out',
      ciphertext: dto.ciphertext,
      nonce: dto.nonce,
      header: JSON.stringify(dto.header),
      createdAt: envelope.createdAt,
      status: 'queued',
    });
    this.emit({
      envelopeId: envelope.envelopeId,
      peerKey,
      direction: 'out',
      text,
      createdAt: envelope.createdAt,
      status: 'queued',
    });

    try {
      await this.api.sendEnvelope(this.token, dto);
      updateMessageStatus(envelope.envelopeId, 'sent');
    } catch {
      updateMessageStatus(envelope.envelopeId, 'failed');
    }
  }

  async listConversation(peerUserId: string, peerDeviceId: string): Promise<{ envelopeId: string; ciphertext: string }[]> {
    return listMessages(peerKeyOf(peerUserId, peerDeviceId)).map((m) => ({
      envelopeId: m.envelopeId,
      ciphertext: m.ciphertext,
    }));
  }

  safetyNumberWith(peerIdentityKey: Uint8Array): string {
    if (!this.identity) throw new Error('ChatEngine: 未初始化身份');
    return computeSafetyNumber(this.identity.identityKey, peerIdentityKey);
  }

  async resolvePeerDevice(userId: string): Promise<{ deviceId: string; identityKey: Uint8Array }> {
    const devices = await this.api.listDevices(this.token, userId);
    const first = devices[0];
    if (!first) throw new Error('对端没有已注册设备');
    return { deviceId: first.deviceId, identityKey: fromBase64(first.identityKey) };
  }

  async searchUsers(query: string): Promise<{ id: string; username: string }[]> {
    return this.api.searchUsers(this.token, query);
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
  }
}

export type { PreKeyBundle, Envelope, LocalIdentity };
