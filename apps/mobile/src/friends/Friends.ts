/**
 * 好友名单
 *
 * 存储位置：本地 SQLite，不上传服务端。
 *
 * 为什么不存服务端：
 *  1. 本项目服务端是"盲转发"，好友关系属于社交图谱元数据，
 *     放服务端等于让它知道"谁和谁是朋友"——即便消息是密文。
 *  2. 身份私钥本就只在本地且不备份（首版取舍），
 *     好友名单跟着本地走是自洽的；换设备本来就无法恢复会话。
 *
 * 代价：重装应用好友名单会丢失。这是有意取舍，UI 不做"云端同步"的暗示。
 */

export interface Friend {
  userId: string;
  username: string;
  uid: string;
  addedAt: number;
}

export interface FriendStore {
  list(): Promise<Friend[]>;
  add(input: { userId: string; username: string; uid?: string }): Promise<void>;
  remove(userId: string): Promise<void>;
  has(userId: string): Promise<boolean>;
}

/** SQLite 实现：真实引擎使用 */
export class SqliteFriendStore implements FriendStore {
  list(): Promise<Friend[]> {
    // 延迟 require：expo-sqlite 是原生模块，顶层 import 有白屏风险
    const db = require('../storage/Database.js') as typeof import('../storage/Database.js');
    return Promise.resolve(db.listFriends());
  }

  async add(input: { userId: string; username: string; uid?: string }): Promise<void> {
    const db = require('../storage/Database.js') as typeof import('../storage/Database.js');
    const rows = db.listFriends();
    const existing = rows.find((f) => f.userId === input.userId);

    // 已是好友：只更新展示信息，保留原 addedAt
    // （否则重复点"添加"会把好友不断顶到列表最前）
    if (existing) {
      db.saveFriend({
        userId: input.userId,
        username: input.username,
        uid: input.uid ?? existing.uid,
        addedAt: existing.addedAt,
      });
      return;
    }

    // 新好友：保证 addedAt 严格大于已有最大值。
    // Date.now() 只有毫秒精度，连续添加两个好友会得到相同时间戳，
    // 排序就退化成插入顺序 —— 用 max+1 保证顺序确定。
    const maxAt = rows.reduce((m, f) => Math.max(m, f.addedAt), 0);
    const addedAt = Math.max(Date.now(), maxAt + 1);

    db.saveFriend({
      userId: input.userId,
      username: input.username,
      uid: input.uid ?? '',
      addedAt,
    });
  }

  async remove(userId: string): Promise<void> {
    const db = require('../storage/Database.js') as typeof import('../storage/Database.js');
    db.deleteFriend(userId);
  }

  async has(userId: string): Promise<boolean> {
    const db = require('../storage/Database.js') as typeof import('../storage/Database.js');
    return db.isFriend(userId);
  }
}

/** 内存实现：演示模式与单元测试使用（不碰 SQLite） */
export class MemoryFriendStore implements FriendStore {
  private items = new Map<string, Friend>();

  async list(): Promise<Friend[]> {
    return [...this.items.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  async add(input: { userId: string; username: string; uid?: string }): Promise<void> {
    const existing = this.items.get(input.userId);
    if (existing) {
      this.items.set(input.userId, {
        ...existing,
        username: input.username,
        uid: input.uid ?? existing.uid,
      });
      return;
    }
    // 同 SqliteFriendStore：保证严格递增，避免毫秒级时间戳撞车导致排序失效
    let maxAt = 0;
    for (const f of this.items.values()) maxAt = Math.max(maxAt, f.addedAt);
    const addedAt = Math.max(Date.now(), maxAt + 1);

    this.items.set(input.userId, {
      userId: input.userId,
      username: input.username,
      uid: input.uid ?? '',
      addedAt,
    });
  }

  async remove(userId: string): Promise<void> {
    this.items.delete(userId);
  }

  async has(userId: string): Promise<boolean> {
    return this.items.has(userId);
  }
}
