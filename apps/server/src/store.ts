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

interface Snapshot {
  users: UserRecord[];
  devices: DeviceRecord[];
  signedPreKeys: SignedPreKeyRecord[];
  oneTimePreKeys: OneTimePreKeyRecord[];
  envelopes: EnvelopeRecord[];
  tokens: TokenRecord[];
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

  upsertDevice(device: Omit<DeviceRecord, 'lastSeen'>): void {
    this.devices.set(`${device.userId}::${device.id}`, { ...device, lastSeen: Date.now() });
    this.scheduleFlush();
  }

  getDevice(userId: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(`${userId}::${deviceId}`);
  }

  listDevices(userId: string): DeviceRecord[] {
    return [...this.devices.values()].filter((d) => d.userId === userId);
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
