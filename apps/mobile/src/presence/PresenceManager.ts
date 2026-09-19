/**
 * 在线状态
 *
 * 隐私设计：
 *  - 是否上报由用户决定（设置 → 隐私 → 在线显示）
 *  - 关闭后服务端对查询方返回 hidden，不泄露任何时间戳
 *  - 展示侧做模糊化：不显示精确"最后在线 xx:xx"，而是"刚刚 / 今天 / 3天前"
 *    精确时间戳会暴露作息习惯，属于不该泄露的元数据
 */

import type { ApiClient, PresenceEntry } from '../network/Api.js';

const ONLINE_WINDOW_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface DisplayPresence {
  online: boolean;
  hidden: boolean;
  /** 已模糊化的文案，如"刚刚""今天""3 天前" */
  label: string;
}

export class PresenceManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private shareOnline = true;

  constructor(
    private readonly api: ApiClient,
    private readonly tokenProvider: () => Promise<string>,
  ) {}

  /** 开启心跳上报；shareOnline=false 时也会上报，但服务端标记为隐藏 */
  async start(shareOnline: boolean): Promise<void> {
    this.shareOnline = shareOnline;
    await this.beat();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setShareOnline(value: boolean): void {
    this.shareOnline = value;
  }

  private async beat(): Promise<void> {
    try {
      await this.api.heartbeat(await this.tokenProvider(), this.shareOnline);
    } catch {
      // 心跳失败不影响聊天主流程，静默重试即可
    }
  }

  async fetch(userIds: string[]): Promise<Record<string, DisplayPresence>> {
    if (userIds.length === 0) return {};
    let raw: Record<string, PresenceEntry> = {};
    try {
      raw = await this.api.fetchPresence(await this.tokenProvider(), userIds);
    } catch {
      return {};
    }
    const out: Record<string, DisplayPresence> = {};
    for (const id of userIds) {
      const entry = raw[id];
      if (!entry || entry.hidden) {
        out[id] = { online: false, hidden: true, label: '不显示' };
        continue;
      }
      out[id] = {
        online: entry.online,
        hidden: false,
        label: entry.online ? '在线' : describeLastSeen(entry.lastSeen),
      };
    }
    return out;
  }
}

/** 时间模糊化：只给量级，不给精确时刻 */
export function describeLastSeen(lastSeen: number, now = Date.now()): string {
  if (!lastSeen) return '不显示';
  const diff = now - lastSeen;
  if (diff < 0) return '刚刚';
  if (diff < ONLINE_WINDOW_MS) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return '今天';
  const days = Math.floor(diff / (24 * 3600_000));
  if (days < 7) return `${days} 天前`;
  if (days < 30) return '一周前';
  return '很久以前';
}
