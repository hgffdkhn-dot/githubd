/**
 * 服务端数据层
 *
 * 铁律：这个模块里永远不允许出现明文字段、身份私钥、会话密钥。
 * 能落库的只有四类东西：账号认证材料、公开密钥材料、密文信封、投递状态。
 */

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface UserRecord {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  identityKey: string;
  signingKey: string;
  lastSeen: number;
  /** 设备管理与"最近登录"展示所需；均为用户自报的展示信息，不含密钥材料 */
  createdAt: number;
  label: string;
  platform: string;
  /** 被踢出后置为时间戳，该设备的 token 立即失效 */
  revokedAt?: number;
}

export interface SignedPreKeyRecord {
  userId: string;
  deviceId: string;
  keyId: number;
  publicKey: string;
  signature: string;
  createdAt: number;
}

export interface OneTimePreKeyRecord {
  userId: string;
  deviceId: string;
  keyId: number;
  publicKey: string;
}

export interface EnvelopeRecord {
  envelopeId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  payload: unknown;
  createdAt: number;
  /** 已推送给在线设备或已被离线拉取，等待客户端 ack 后删除 */
  deliveredAt?: number;
}

export interface TokenRecord {
  token: string;
  userId: string;
  deviceId: string;
  expiresAt: number;
}

/**
 * 个人资料
 *
 * 隐私模型：
 *  - visibility='friends'（默认）：只存密文，服务端不可读。资料密钥由资料所有者
 *    通过端到端加密会话分发给好友，服务端全程只经手密文。
 *  - visibility='public'：用户主动选择公开，服务端保存明文副本，任何人可读取。
 *
 * ⚠️ 这是本项目唯一允许出现用户明文内容的存储位置，且必须由用户显式选择。
 */
export interface ProfileRecord {
  userId: string;
  visibility: 'friends' | 'public';
  /** friends 模式：资料密文（nonce + ciphertext），服务端无法解密 */
  encrypted?: { nonce: string; ciphertext: string };
  /** public 模式：明文副本，服务端可读 —— 用户主动切换可见性时才产生 */
  publicFields?: { displayName: string; bio: string };
  /** 头像：friends 模式存密文，public 模式存明文字节 */
  avatar?: {
    mime: string;
    /** friends 模式为密文 base64；public 模式为明文 base64 */
    data: string;
    nonce?: string;
    encrypted: boolean;
  };
  updatedAt: number;
}

/**
 * 在线状态
 *
 * 只存"最后活跃时间"，不存 IP、不存精确轨迹。
 * visible=false 的用户，即使在线也不对外展示（他人查询时返回隐藏）。
 */
export interface PresenceRecord {
  userId: string;
  lastSeen: number;
  /** 用户是否在隐私设置里允许展示自己的在线动态 */
  visible: boolean;
}

interface Snapshot {
  users: UserRecord[];
  devices: DeviceRecord[];
  signedPreKeys: SignedPreKeyRecord[];
  oneTimePreKeys: OneTimePreKeyRecord[];
  envelopes: EnvelopeRecord[];
  tokens: TokenRecord[];
  profiles: ProfileRecord[];
  presence: PresenceRecord[];
}

const LOW_PREKEY_THRESHOLD = 20;

export class Store {
  private users = new Map<string, UserRecord>();
  private usernameIndex = new Map<string, string>();
  private devices = new Map<string, DeviceRecord>();
  private signedPreKeys = new Map<string, SignedPreKeyRecord>();
  private oneTimePreKeys = new Map<string, OneTimePreKeyRecord>();
  private envelopes = new Map<string, EnvelopeRecord>();
  private tokens = new Map<string, TokenRecord>();
  private profiles = new Map<string, ProfileRecord>();
  private presence = new Map<string, PresenceRecord>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly snapshotPath: string | null) {
    this.load();
  }

  private key(userId: string, deviceId: string, keyId: number): string {
    return `${userId}::${deviceId}::${keyId}`;
  }

  private load(): void {
    if (!this.snapshotPath || !existsSync(this.snapshotPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as Partial<Snapshot>;
      for (const u of raw.users ?? []) {
        this.users.set(u.id, u);
        this.usernameIndex.set(u.username, u.id);
      }
      for (const d of raw.devices ?? []) this.devices.set(`${d.userId}::${d.id}`, d);
      for (const s of raw.signedPreKeys ?? []) {
        this.signedPreKeys.set(this.key(s.userId, s.deviceId, s.keyId), s);
      }
      for (const o of raw.oneTimePreKeys ?? []) {
        this.oneTimePreKeys.set(this.key(o.userId, o.deviceId, o.keyId), o);
      }
      for (const e of raw.envelopes ?? []) this.envelopes.set(e.envelopeId, e);
      for (const t of raw.tokens ?? []) {
        if (t.expiresAt > Date.now()) this.tokens.set(t.token, t);
      }
      for (const p of raw.profiles ?? []) this.profiles.set(p.userId, p);
      for (const p of raw.presence ?? []) this.presence.set(p.userId, p);
    } catch {
      // 快照损坏时以空库启动，绝不能因为持久层问题让服务降级为"明文转发"
    }
  }

  private scheduleFlush(): void {
    if (!this.snapshotPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
  }

  flush(): void {
    if (!this.snapshotPath) return;
    const snapshot: Snapshot = {
      users: [...this.users.values()],
      devices: [...this.devices.values()],
      signedPreKeys: [...this.signedPreKeys.values()],
      oneTimePreKeys: [...this.oneTimePreKeys.values()],
      envelopes: [...this.envelopes.values()],
      tokens: [...this.tokens.values()],
      profiles: [...this.profiles.values()],
      presence: [...this.presence.values()],
    };
    mkdirSync(dirname(resolve(this.snapshotPath)), { recursive: true });
    writeFileSync(this.snapshotPath, JSON.stringify(snapshot));
  }

  /* ---------------- 账号 ---------------- */

  createUser(username: string, passwordSalt: string, passwordHash: string): UserRecord {
    const id = randomBytes(16).toString('hex');
    const record: UserRecord = { id, username, passwordSalt, passwordHash, createdAt: Date.now() };
    this.users.set(id, record);
    this.usernameIndex.set(username, id);
    this.scheduleFlush();
    return record;
  }

  findUserByUsername(username: string): UserRecord | undefined {
    const id = this.usernameIndex.get(username);
    return id ? this.users.get(id) : undefined;
  }

  findUserById(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  searchUsers(query: string, limit = 20): { id: string; username: string }[] {
    const q = query.toLowerCase();
    return [...this.users.values()]
      .filter((u) => u.username.toLowerCase().includes(q))
      .slice(0, limit)
      .map((u) => ({ id: u.id, username: u.username }));
  }

  /* ---------------- 令牌 ---------------- */

  issueToken(userId: string, deviceId: string, ttlMs = 30 * 24 * 3600 * 1000): string {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { token, userId, deviceId, expiresAt: Date.now() + ttlMs });
    this.scheduleFlush();
    return token;
  }

  resolveToken(token: string): TokenRecord | undefined {
    const record = this.tokens.get(token);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    return record;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
    this.scheduleFlush();
  }

  /* ---------------- 设备与公开密钥 ---------------- */

  /** 重复登录不重置 createdAt，否则"最近登录"列表的时间会漂移 */
  upsertDevice(device: Omit<DeviceRecord, 'lastSeen' | 'createdAt'> & { createdAt?: number }): void {
    const key = `${device.userId}::${device.id}`;
    const existing = this.devices.get(key);
    this.devices.set(key, {
      ...device,
      createdAt: existing?.createdAt ?? device.createdAt ?? Date.now(),
      lastSeen: Date.now(),
      revokedAt: undefined, // 重新登录视为主动恢复，清除踢出标记
    });
    this.scheduleFlush();
  }

  getDevice(userId: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(`${userId}::${deviceId}`);
  }

  listDevices(userId: string): DeviceRecord[] {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  /** 踢出设备：立即让该设备的所有 token 失效 */
  revokeDevice(userId: string, deviceId: string): boolean {
    const device = this.devices.get(`${userId}::${deviceId}`);
    if (!device) return false;
    device.revokedAt = Date.now();
    for (const [token, record] of this.tokens) {
      if (record.userId === userId && record.deviceId === deviceId) this.tokens.delete(token);
    }
    this.scheduleFlush();
    return true;
  }

  isDeviceRevoked(userId: string, deviceId: string): boolean {
    return this.devices.get(`${userId}::${deviceId}`)?.revokedAt !== undefined;
  }

  touchDevice(userId: string, deviceId: string): void {
    const device = this.devices.get(`${userId}::${deviceId}`);
    if (!device) return;
    device.lastSeen = Date.now();
  }

  /* ---------------- 个人资料 ---------------- */

  getProfile(userId: string): ProfileRecord | undefined {
    return this.profiles.get(userId);
  }

  saveProfile(record: ProfileRecord): void {
    this.profiles.set(record.userId, record);
    this.scheduleFlush();
  }

  /* ---------------- 在线状态 ---------------- */

  heartbeatPresence(userId: string, visible: boolean): void {
    this.presence.set(userId, { userId, lastSeen: Date.now(), visible });
  }

  setPresenceVisibility(userId: string, visible: boolean): void {
    const existing = this.presence.get(userId);
    this.presence.set(userId, {
      userId,
      lastSeen: existing?.lastSeen ?? Date.now(),
      visible,
    });
    this.scheduleFlush();
  }

  getPresence(userId: string): PresenceRecord | undefined {
    return this.presence.get(userId);
  }

  publishSignedPreKey(record: SignedPreKeyRecord): void {
    this.signedPreKeys.set(this.key(record.userId, record.deviceId, record.keyId), record);
    this.scheduleFlush();
  }

  getSignedPreKey(userId: string, deviceId: string, keyId: number): SignedPreKeyRecord | undefined {
    return this.signedPreKeys.get(this.key(userId, deviceId, keyId));
  }

  getLatestSignedPreKey(userId: string, deviceId: string): SignedPreKeyRecord | undefined {
    return [...this.signedPreKeys.values()]
      .filter((s) => s.userId === userId && s.deviceId === deviceId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  publishOneTimePreKeys(userId: string, deviceId: string, keys: { keyId: number; publicKey: string }[]): void {
    for (const k of keys) {
      this.oneTimePreKeys.set(this.key(userId, deviceId, k.keyId), { userId, deviceId, ...k });
    }
    this.scheduleFlush();
  }

  /**
   * 认领一次性预密钥：原子删除。
   * 这是协议要求，不是缓存优化 —— 同一个 OPK 被两次握手复用会削弱新鲜性保证。
   */
  claimOneTimePreKey(userId: string, deviceId: string): OneTimePreKeyRecord | undefined {
    const candidates = [...this.oneTimePreKeys.values()].filter(
      (k) => k.userId === userId && k.deviceId === deviceId,
    );
    if (candidates.length === 0) return undefined;
    const picked = candidates[0];
    this.oneTimePreKeys.delete(this.key(userId, deviceId, picked.keyId));
    this.scheduleFlush();
    return picked;
  }

  countOneTimePreKeys(userId: string, deviceId: string): number {
    return [...this.oneTimePreKeys.values()].filter((k) => k.userId === userId && k.deviceId === deviceId).length;
  }

  get isPreKeyLow(): typeof LOW_PREKEY_THRESHOLD {
    return LOW_PREKEY_THRESHOLD;
  }

  /* ---------------- 信封 ---------------- */

  enqueueEnvelope(record: EnvelopeRecord): void {
    this.envelopes.set(record.envelopeId, record);
    this.scheduleFlush();
  }

  pendingFor(userId: string, deviceId: string): EnvelopeRecord[] {
    return [...this.envelopes.values()].filter(
      (e) => e.recipientUserId === userId && e.recipientDeviceId === deviceId && !e.deliveredAt,
    );
  }

  markDelivered(envelopeIds: string[]): void {
    for (const id of envelopeIds) {
      const record = this.envelopes.get(id);
      if (record) record.deliveredAt = Date.now();
    }
    this.scheduleFlush();
  }

  /** 客户端显式 ack 后删除；ack 是幂等的 */
  acknowledge(envelopeIds: string[]): void {
    for (const id of envelopeIds) this.envelopes.delete(id);
    this.scheduleFlush();
  }
}

export function hashForLogging(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
