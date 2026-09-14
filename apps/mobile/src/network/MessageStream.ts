/**
 * WebSocket 长连接
 *
 * 断线重连后必须主动拉取离线信封，否则会漏消息。
 * ack 只在"解密成功后"才发送 —— 解密失败的消息留在服务端，避免静默丢失。
 */

import type { EnvelopeDto } from '@e2ee/protocol';

export interface StreamEvents {
  onEnvelope: (envelope: EnvelopeDto) => void | Promise<void>;
  onPreKeyLow: (remaining: number) => void | Promise<void>;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
}

export class MessageStream {
  private socket: WebSocket | null = null;
  private closed = false;
  private retry = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string,
    private readonly events: StreamEvents,
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const token = this.getToken();
    if (!token) return;
    this.events.onStatus?.('connecting');

    const url = `${this.baseUrl.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.retry = 0;
      this.events.onStatus?.('open');
    };

    this.socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as { type: string; envelope?: EnvelopeDto; remaining?: number };
        if (frame.type === 'envelope' && frame.envelope) {
          void this.events.onEnvelope(frame.envelope);
        } else if (frame.type === 'prekey.low') {
          void this.events.onPreKeyLow(frame.remaining ?? 0);
        }
      } catch {
        // 丢弃无法解析的帧，绝不让畸形输入影响连接状态机
      }
    };

    this.socket.onclose = () => {
      this.events.onStatus?.('closed');
      if (this.closed) return;
      // 指数退避，最长 30 秒
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };

    this.socket.onerror = () => this.socket?.close();
  }

  ack(envelopeIds: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || envelopeIds.length === 0) return;
    this.socket.send(JSON.stringify({ type: 'ack', envelopeIds }));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}
