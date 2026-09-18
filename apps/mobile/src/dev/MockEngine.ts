/**
 * 演示模式引擎
 *
 * 用本地假数据模拟 ChatEngine 的行为，让 UI 流程能完整跑通：
 * 登录 → 搜索联系人 → 进入会话 → 收发消息 → 安全码展示。
 *
 * ⚠️ 不做任何加密，不产生任何密钥，不连接网络。仅用于验证界面。
 */

import type { DecryptedMessage } from '../chat/ChatEngine.js';

/** 预置的演示联系人 */
export const DEMO_CONTACTS = [
  { id: 'demo-bob', username: 'bob' },
  { id: 'demo-carol', username: 'carol' },
  { id: 'demo-dave', username: 'dave' },
];

/** 对方收到消息后模拟的回复 */
const AUTO_REPLIES = [
  '收到，这条消息在演示模式下没有加密。',
  '演示模式仅供验证界面，真实会话会经过 X3DH + Double Ratchet。',
  '安全码可在会话顶部比对。',
  '这条是自动回复（假数据）。',
];

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export class MockEngine {
  private listeners = new Set<(message: DecryptedMessage) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private currentUser = '';
  private replyIndex = 0;

  onMessage(listener: (message: DecryptedMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(message: DecryptedMessage): void {
    for (const l of this.listeners) l(message);
  }

  async register(username: string, _password: string): Promise<void> {
    this.currentUser = username || 'demo';
  }

  async login(username: string, _password: string): Promise<void> {
    this.currentUser = username || 'demo';
  }

  /** 演示模式下不持久化会话，每次都停在登录页 */
  async restoreSession(): Promise<boolean> {
    return false;
  }

  async start(): Promise<void> {
    // 无网络、无数据库，什么都不做
  }

  async rotateSignedPreKeyIfNeeded(): Promise<void> {}

  async resolvePeerDevice(userId: string): Promise<{ deviceId: string; identityKey: Uint8Array }> {
    // 安全码由 userId 派生，保证同一会话两侧一致且稳定
    return { deviceId: `${userId}-device`, identityKey: new Uint8Array([userId.length % 251]) };
  }

  safetyNumberWith(peerIdentityKey: Uint8Array): string {
    // 固定长度的演示指纹，界面只用于展示
    const base = peerIdentityKey[0] ?? 1;
    return Array.from({ length: 12 }, (_, i) => ((base * (i + 7)) % 10).toString()).join('');
  }

  async searchUsers(query: string): Promise<{ id: string; username: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q) return DEMO_CONTACTS;
    return DEMO_CONTACTS.filter((c) => c.username.toLowerCase().includes(q));
  }

  async sendText(peerUserId: string, peerDeviceId: string, text: string): Promise<void> {
    // 先回显自己发出的消息，状态 sent
    this.emit({
      envelopeId: nextId('out'),
      peerKey: `${peerUserId}::${peerDeviceId}`,
      direction: 'out',
      text,
      createdAt: Date.now(),
      status: 'sent',
    });

    // 模拟对方延迟回复，让界面看起来像真在聊天
    const timer = setTimeout(() => {
      const reply = AUTO_REPLIES[this.replyIndex % AUTO_REPLIES.length];
      this.replyIndex += 1;
      this.emit({
        envelopeId: nextId('in'),
        peerKey: `${peerUserId}::${peerDeviceId}`,
        direction: 'in',
        text: reply,
        createdAt: Date.now(),
        status: 'decrypted',
      });
    }, 900);
    this.timers.push(timer);
  }

  async drainPending(): Promise<void> {}

  async listConversation(): Promise<{ envelopeId: string; ciphertext: string }[]> {
    return [];
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.listeners.clear();
  }

  whoami(): string {
    return this.currentUser;
  }
}
