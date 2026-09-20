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
import { MessageStream, type StreamStatus } from '../network/MessageStream.js';
import {
  saveIdentity,
  loadIdentity,
  saveToken,
  loadToken,
  saveDeviceId,
  loadDeviceId,
  saveMyUid,
  loadMyUid,
  savePreKeyPrivate,
  wipeAll,
  SecurePreKeyStore,
  SPK_PREFIX,
  OPK_PREFIX,
} from '../crypto/Keystore.js';
import { SqliteSessionStore } from '../storage/SessionRepository.js';
import {
  saveMessage,
  updateMessageStatus,
  listMessages,
  openDatabase,
  listConversations as listConversationsRaw,
} from '../storage/Database.js';
import { bootstrapCrypto } from '../crypto/QuickCryptoAead.js';
import { ProfileManager, type ResolvedProfile } from '../profile/ProfileManager.js';
import { PresenceManager, type DisplayPresence } from '../presence/PresenceManager.js';
import type { MyDevice } from '../network/Api.js';
import { getDeviceLabel } from '../device/deviceInfo.js';
import { SqliteFriendStore, type Friend, type FriendStore } from '../friends/Friends.js';
import { deleteFriend, deleteAllFriends, clearAllMessages } from '../storage/Database.js';
import { previewsEnabled, initPreviewsFlag, initBurnAfterExit } from '../settings/security.js';

type OwnProfileView = ResolvedProfile;
export type { OwnProfileView, DisplayPresence, MyDevice };

const OPK_BATCH_SIZE = 50;
const OPK_REPLENISH_THRESHOLD = 20;
const SPK_ROTATION_MS = 7 * 24 * 3600 * 1000;

/** 主界面会话列表的一项 */
export interface ConversationSummary {
  userId: string;
  peerKey: string;
  /** 用户名；本地没有好友记录时由服务端回填，仍拿不到则为 null */
  username?: string | null;
  /** 最后一条消息的明文预览；关闭本地缓存时为空串 */
  preview: string;
  lastAt: number;
  messageCount: number;
}

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
  private myUid: string | null = null;
  private presence: PresenceManager | null = null;
  private profiles: ProfileManager | null = null;
  private friendStore: FriendStore = new SqliteFriendStore();
  private connection: StreamStatus = 'closed';
  private connectionListeners = new Set<(s: StreamStatus) => void>();
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

  /** 自己的 UID，供个人主页展示 */
  get uid(): string | null {
    return this.myUid;
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
    const profile = await this.profiles.loadOwn(this.userId);

    // 补 UID：老账号（UID 功能上线前注册的）本地没缓存，
    // 服务端在返回资料时会一并给出，这里存下来供后续直接使用
    const uid = (profile as { uid?: string | null }).uid;
    if (uid && uid !== this.myUid) {
      this.myUid = uid;
      await saveMyUid(uid);
    }
    return profile;
  }

  /**
   * 确保拿到自己的 UID
   *
   * 三种情况需要它：
   *  1. 老账号：注册时服务端还没有 UID 功能，本地无缓存
   *  2. 重装应用：本地缓存清空，但服务端 UID 还在
   *  3. 会话恢复路径：restoreSession 只恢复 token，不重新登录
   */
  async ensureUid(): Promise<string | null> {
    if (this.myUid) return this.myUid;
    if (!this.token) return null;
    try {
      await this.loadMyProfile();
    } catch {
      // 拿不到 UID 不影响聊天，降级为不显示
    }
    return this.myUid;
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

  /** 设备型号等展示信息；采集失败也有可读兜底，绝不抛错阻断登录 */
  private deviceInfo(): { deviceLabel: string; devicePlatform: string } {
    try {
      return getDeviceLabel();
    } catch {
      return { deviceLabel: 'Android 设备', devicePlatform: 'android' };
    }
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
      ...this.deviceInfo(),
    });
    await this.persistPreKeyBundle(bundle);
    await this.completeAuth(result);
  }

  async login(username: string, password: string): Promise<void> {
    this.identity = await this.ensureIdentity();
    this.deviceId = await this.ensureDeviceId();
    const result = await this.api.login({
      username,
      password,
      deviceId: this.deviceId,
      identity: this.identity,
      ...this.deviceInfo(),
    });
    await this.completeAuth(result);
    // 登录也刷新一次设备名：老账号此前可能存的是占位值
    void this.reportDeviceLabel();
    await this.rotateSignedPreKeyIfNeeded();
  }

  // ------------------------------------------------------------------
  // 好友名单（本地存储，不上传服务端）
  // ------------------------------------------------------------------

  async listFriends(): Promise<Friend[]> {
    return this.friendStore.list();
  }

  async addFriend(input: { userId: string; username: string; uid?: string }): Promise<void> {
    await this.friendStore.add(input);
  }

  async removeFriend(userId: string): Promise<void> {
    await this.friendStore.remove(userId);
    // 好友删掉后会话记录也一并清掉，避免列表里留下无法解释的残留会话
    try {
      deleteFriend(userId);
    } catch {
      // 数据库不可用时不影响好友删除本身
    }
  }

  async isFriend(userId: string): Promise<boolean> {
    return this.friendStore.has(userId);
  }

  /**
   * 退出账号：清除本机身份、会话与 UID，回到未登录状态
   *
   * ⚠️ 首版不做密钥备份，退出后历史会话无法恢复。
   * 服务端上的账号还在，可以用同一用户名重新注册（会生成新身份密钥），
   * 但旧会话因密钥已丢失而永久无法解密 —— UI 必须提前告知。
   */
  async logout(): Promise<void> {
    this.stopPresence();
    this.stream?.close?.();
    this.stream = null;
    this.manager = null;
    this.profiles = null;
    this.presence = null;
    this.listeners.clear();

    await wipeAll();

    // 好友名单与本地消息都跟着本机身份走：身份清了，它们也应清掉。
    // 旧消息的密文在密钥销毁后再也解不开，留着只会造成"消息还在"的错觉。
    try {
      deleteAllFriends();
      clearAllMessages();
    } catch {
      // 数据库不可用不影响退出流程
    }

    this.token = '';
    this.identity = null;
    this.userId = '';
    this.deviceId = '';
    this.myUid = null;
    this.nextOpkId = 1;
    this.spkId = 1;
    this.spkGeneratedAt = 0;
  }

  async restoreSession(): Promise<boolean> {
    const token = await loadToken();
    const identity = await loadIdentity();
    const deviceId = await loadDeviceId();
    if (!token || !identity || !deviceId) return false;
    this.token = token;
    this.identity = identity;
    this.deviceId = deviceId;
    this.myUid = await loadMyUid();
    // 会话恢复不走 register/login，所以设备名必须在这里补上报，
    // 否则老设备永远显示占位文案
    void this.reportDeviceLabel();
    return true;
  }

  /**
   * 上报本设备展示名
   *
   * 失败一律忽略：设备名只是展示信息，不能因为它失败而影响登录。
   */
  private async reportDeviceLabel(): Promise<void> {
    if (!this.token || !this.deviceId) return;
    try {
      const info = this.deviceInfo();
      await this.api.updateDeviceLabel(this.token, this.deviceId, info.deviceLabel, info.devicePlatform);
    } catch {
      // 忽略
    }
  }

  private async completeAuth(
    result: { userId: string; deviceId: string; token: string; uid?: string },
  ): Promise<void> {
    this.userId = result.userId;
    this.deviceId = result.deviceId;
    this.token = result.token;
    await saveToken(result.token);

    // UID 服务端生成后不变，本地缓存一份以便重启后仍可展示
    if (result.uid) {
      this.myUid = result.uid;
      await saveMyUid(result.uid);
    } else {
      this.myUid = await loadMyUid();
    }

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

    // 阅后即焚：开启时每次启动先清空本地消息。
    // 必须在建 manager / 连流之前，否则列表会先读到旧数据再被清掉。
    if (await initBurnAfterExit()) {
      try {
        clearAllMessages();
      } catch {
        // 清不掉就算了，不影响正常使用
      }
    }

    // 预览开关要在任何消息落库之前就绪，否则第一条消息会用错默认值
    await initPreviewsFlag();
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
      onStatus: (status) => this.setConnection(status),
      // 断线重连后必须补拉：断开期间服务端堆积的信封不会自动重推
      onReconnect: () => {
        void this.drainPending();
      },
    });
    this.stream.connect();

    // 刷新本设备展示名：会话恢复路径不走 register/login，
    // 设备型号就永远停留在旧值（表现为设备管理里一直显示占位文案）
    void this.refreshDeviceLabel();

    // 重连/冷启动后补齐离线消息
    await this.drainPending();
  }

  /** 上报本设备型号；失败不影响登录，下次启动会再试 */
  async refreshDeviceLabel(): Promise<void> {
    if (!this.token || !this.deviceId) return;
    try {
      const { deviceLabel, devicePlatform } = this.deviceInfo();
      await this.api.updateDeviceLabel(this.token, this.deviceId, deviceLabel, devicePlatform);
    } catch {
      // 设备名只是展示信息，失败无所谓
    }
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

  /** 当前长连接状态，UI 用它显示"通信中 / 连接中…" */
  get connectionStatus(): StreamStatus {
    return this.connection;
  }

  onConnectionChange(listener: (status: StreamStatus) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private setConnection(status: StreamStatus): void {
    if (this.connection === status) return;
    this.connection = status;
    for (const l of this.connectionListeners) l(status);
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
        preview: previewsEnabled() ? text : undefined,
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
        // 解密失败不落明文：本来也没有明文，且失败原因可能含敏感细节
        preview: undefined,
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
      preview: previewsEnabled() ? text : undefined,
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

  /**
   * 读取某会话的历史消息
   *
   * ⚠️ 这里**不做重新解密**，而是读取落库时缓存的明文。
   * 原因：Double Ratchet 的消息密钥是一次性的，解密后即丢弃，
   * 事后再拿密文也解不出来（这是前向安全的代价）。
   * 所以历史可读性完全依赖"落库时是否缓存了明文"。
   *
   * 若用户关闭了本地消息缓存，历史消息只能显示占位文案 ——
   * 这是有意取舍，UI 必须说清楚而不是假装消息丢了。
   */
  async loadHistory(peerUserId: string, peerDeviceId: string): Promise<DecryptedMessage[]> {
    const rows = listMessages(peerKeyOf(peerUserId, peerDeviceId));
    return rows.map((r) => ({
      envelopeId: r.envelopeId,
      peerKey: r.peerKey,
      direction: r.direction,
      text: r.preview ?? (r.direction === 'out' ? '（本地未缓存此消息）' : '（消息内容未缓存）'),
      createdAt: r.createdAt,
      status: r.status,
    }));
  }

  /**
   * 按 userId 查用户名
   *
   * 会话列表里可能出现"本地没有好友记录"的用户（例如对方删了我、
   * 或我在另一台设备上聊过），这时只能向服务端问一次名字。
   * 结果不落库：用户名可变，缓存了反而会显示错的名字。
   */
  async resolveUser(userId: string): Promise<{ id: string; username: string; uid: string } | null> {
    if (!this.token) return null;
    try {
      return await this.api.getUserById(this.token, userId);
    } catch {
      return null;
    }
  }

  /** 主界面会话列表：有聊天记录的会话，按最近时间倒序 */
  async listConversations(): Promise<ConversationSummary[]> {
    const rows = listConversationsRaw(previewsEnabled());
    const out = rows.map((r) => ({
      userId: r.userId,
      peerKey: r.peerKey,
      preview: r.preview,
      lastAt: r.lastAt,
      messageCount: r.messageCount,
      username: null as string | null,
    }));

    // 回填用户名：会话存在但本地没有好友记录时（好友被删、换设备、
    // 或在搜索页刚添加还没入库），会显示"未知用户"。
    // 这里向服务端查一次并顺带补进好友名单，之后再进就不必再查。
    const known = new Set((await this.friendStore.list().catch(() => [])).map((f) => f.userId));
    const missing = out.filter((c) => !known.has(c.userId)).map((c) => c.userId);

    for (const userId of missing.slice(0, 20)) {
      const info = await this.resolveUser(userId);
      if (!info?.username) continue;
      for (const c of out) if (c.userId === userId) c.username = info.username;
      // 补进好友名单，避免每次进主界面都查一次
      await this.friendStore.add({ userId, username: info.username, uid: info.uid }).catch(() => undefined);
    }
    return out;
  }

  private userCache = new Map<string, { id: string; username: string; uid: string } | null>();

  /** 查用户信息；查不到返回 null（不抛，UI 自行降级展示） */
  async resolveUser(userId: string): Promise<{ id: string; username: string; uid: string } | null> {
    if (this.userCache.has(userId)) return this.userCache.get(userId) ?? null;
    if (!this.token) return null;
    let info: { id: string; username: string; uid: string } | null = null;
    try {
      info = await this.api.getUserById(this.token, userId);
    } catch {
      info = null;
    }
    this.userCache.set(userId, info);
    return info;
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
