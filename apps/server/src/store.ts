/**
 * 服务端数据层
 *
 * 铁律：这个模块里永远不允许出现明文字段、身份私钥、会话密钥。
 * 能落库的只有四类东西：账号认证材料、公开密钥材料、密文信封、投递状态。
 */

import { randomBytes, randomInt, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface UserRecord {
  id: string;
  username: string;
  /**
   * 6 位数字 UID，注册时由服务端生成，之后**永不变更**。
   *
   * 为什么需要：用户名可能重复相似、含特殊字符、难口述；
   * 6 位数字便于口头交换（"加我，UID 483920"）。
   *
   * ⚠️ 注意：UID 只是**可发现的公开标识**，绝不是身份凭证。
   * 任何接口都不得仅凭 UID 授权，必须走完整的端到端握手。
   */
  uid: string;
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
  private uidIndex = new Map<string, string>();
  private devices = new Map<string, DeviceRecord>();
  private signedPreKeys = new Map<string, SignedPreKeyRecord>();
  private oneTimePreKeys = new Map<string, OneTimePreKeyRecord>();
  private envelopes = new Map<string, EnvelopeRecord>();
  private tokens = new Map<string, TokenRecord>();
  private profiles = new Map<string, ProfileRecord>();
  private presence = new Map<string, PresenceRecord>();
  private flushTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

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
        // 兼容旧快照：早期用户没有 uid，载入时补一个
        if (!u.uid) {
          u.uid = this.allocateUid();
          this.scheduleFlush();
        }
        this.uidIndex.set(u.uid, u.id);
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

  /**
   * 定期清理，防止内存只增不减导致 OOM
   *
   * 曾经的问题：过期令牌只在"被访问时"才删除，客户端一旦不再访问
   * （换设备、卸载），那条记录就永远留在内存里，还会被写进快照。
   * 长期运行后内存持续上涨，最终被系统 OOM 杀掉 ——
   * 表现就是"服务每隔一段时间突然挂掉，且没有任何 JS 错误日志"。
   *
   * 现在改为主动定期清理。
   */
  startMaintenance(intervalMs = 30 * 60_000): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      try {
        this.cleanup();
      } catch {
        // 清理失败绝不能影响主服务
      }
    }, intervalMs);
    // 不阻止进程退出
    this.maintenanceTimer.unref?.();
  }

  /** 回收三类数据：过期令牌、陈旧在线状态、已投递很久的信封 */
  cleanup(): { tokens: number; presence: number; envelopes: number } {
    const now = Date.now();
    let removedTokens = 0;

    // 1) 过期令牌（TTL 30 天）
    for (const [token, record] of this.tokens) {
      if (record.expiresAt <= now) {
        this.tokens.delete(token);
        removedTokens += 1;
      }
    }

    // 2) 超过 90 天没活跃的在线状态记录（易失数据，丢了下次心跳会重建）
    let removedPresence = 0;
    const presenceCutoff = now - 90 * 24 * 3600_000;
    for (const [userId, record] of this.presence) {
      if (record.lastSeen < presenceCutoff) {
        this.presence.delete(userId);
        removedPresence += 1;
      }
    }

    // 3) 已投递且超过 7 天的信封（ack 后本就该删，这里是兜底）
    let removedEnvelopes = 0;
    const envelopeCutoff = now - 7 * 24 * 3600_000;
    for (const [id, env] of this.envelopes) {
      if (env.deliveredAt && env.createdAt < envelopeCutoff) {
        this.envelopes.delete(id);
        removedEnvelopes += 1;
      }
    }

    if (removedTokens || removedPresence || removedEnvelopes) {
      this.scheduleFlush();
      console.log(
        `[store] 清理完成：令牌 ${removedTokens} · 在线状态 ${removedPresence} · 信封 ${removedEnvelopes}`,
      );
    }
    return { tokens: removedTokens, presence: removedPresence, envelopes: removedEnvelopes };
  }

  /**
   * 把某人的在线时间往前推移（仅用于测试清理逻辑）
   *
   * 生产不会调用。放在这里是因为清理规则依赖真实时间流逝，
   * 测试不可能真的等 90 天。
   */
  debugAgePresence(userId: string, ageMs: number): void {
    const record = this.presence.get(userId);
    if (record) record.lastSeen = Date.now() - ageMs;
  }

  /** 内存占用概况，供日志排查 OOM */
  memoryReport(): string {
    return [
      `users=${this.users.size}`,
      `devices=${this.devices.size}`,
      `tokens=${this.tokens.size}`,
      `envelopes=${this.envelopes.size}`,
      `opk=${this.oneTimePreKeys.size}`,
      `heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    ].join(' ');
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
    const record: UserRecord = {
      id,
      username,
      uid: this.allocateUid(),
      passwordSalt,
      passwordHash,
      createdAt: Date.now(),
    };
    this.users.set(id, record);
    this.usernameIndex.set(username, id);
    this.uidIndex.set(record.uid, id);
    this.scheduleFlush();
    return record;
  }

  /**
   * 分配一个未被占用的 6 位 UID
   *
   * ⚠️ 必须查重。**不能用 randomInt 直接生成就完事**：
   * 6 位数字只有 90 万个取值，按生日悖论，纯随机在约 1000 个用户时
   * 碰撞概率就高达 ~39%，一旦撞号，"搜 UID 加好友"会加错人。
   *
   * 查重后是"构造性唯一"，代价只是用户量很大时重试次数变多。
   */
  private allocateUid(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = String(randomInt(100000, 1000000)); // [100000, 999999]
      if (!this.uidIndex.has(candidate)) return candidate;
    }
    // 极端情况：随机碰撞 50 次都没中，退化为顺序扫描找空位
    for (let n = 100000; n < 1000000; n++) {
      const candidate = String(n);
      if (!this.uidIndex.has(candidate)) return candidate;
    }
    throw new Error('UID 空间已耗尽');
  }

  findUserByUsername(username: string): UserRecord | undefined {
    const id = this.usernameIndex.get(username);
    return id ? this.users.get(id) : undefined;
  }

  findUserByUid(uid: string): UserRecord | undefined {
    const id = this.uidIndex.get(uid);
    return id ? this.users.get(id) : undefined;
  }

  findUserById(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  /**
   * 搜索：用户名模糊匹配 + UID 精确匹配
   *
   * UID 走精确匹配而不是模糊，避免搜 "123" 时把一堆人拉出来。
   */
  searchUsers(query: string, limit = 20): { id: string; username: string; uid: string }[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // 纯 6 位数字：先当 UID 精确查，命中就直接返回（最符合"加我 UID"的预期）
    const byUid = this.findUserByUid(q);
    if (byUid) {
      return [{ id: byUid.id, username: byUid.username, uid: byUid.uid }];
    }

    return [...this.users.values()]
      .filter((u) => u.username.toLowerCase().includes(q))
      .slice(0, limit)
      .map((u) => ({ id: u.id, username: u.username, uid: u.uid }));
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
