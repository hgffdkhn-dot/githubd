/**
 * WebSocket 长连接
 *
 * 断线重连后必须主动拉取离线信封，否则会漏消息。
 * ack 只在"解密成功后"才发送 —— 解密失败的消息留在服务端，避免静默丢失。
 *
 * 为什么要有心跳与看门狗：
 *  移动网络下 WebSocket 会出现"半开"状态 —— 手机切基站、息屏、进电梯后，
 *  TCP 连接其实已断但双方都收不到 FIN，socket 一直显示 OPEN。
 *  表现就是"服务器正常但突然收不到消息"，且不会触发 onclose，
 *  所以重连逻辑永远不会执行。只能靠心跳探测发现。
 */

import type { EnvelopeDto } from '@e2ee/protocol';

export type StreamStatus = 'connecting' | 'open' | 'closed';

export interface StreamEvents {
  onEnvelope: (envelope: EnvelopeDto) => void | Promise<void>;
  onPreKeyLow: (remaining: number) => void | Promise<void>;
  onStatus?: (status: StreamStatus) => void;
  /** 重连成功后触发：调用方应立刻补拉离线消息 */
  onReconnect?: () => void | Promise<void>;
}

/** 心跳间隔 */
const PING_INTERVAL_MS = 15_000;
/** 发出 ping 后多久没收到 pong 就判定连接已死 */
const PONG_TIMEOUT_MS = 8_000;

export class MessageStream {
  private socket: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  /** 是否曾经成功连上过：用来区分"首次连接"和"断线重连" */
  private everOpened = false;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string,
    private readonly events: StreamEvents,
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.awaitingPong = false;
  }

  /** 判定连接已死：强行关掉旧 socket 触发 onclose 走重连 */
  private forceReconnect(): void {
    this.clearTimers();
    try {
      this.socket?.close();
    } catch {
      // 关不掉就算了，onclose 迟早会来
    }
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

      // 上一个 ping 还没回来 → 连接多半已经半开，直接重连
      if (this.awaitingPong) {
        this.forceReconnect();
        return;
      }

      try {
        this.awaitingPong = true;
        this.socket.send(JSON.stringify({ type: 'ping' }));
        this.pongTimer = setTimeout(() => {
          // 超时未收到 pong：视为连接已死
          if (this.awaitingPong) this.forceReconnect();
        }, PONG_TIMEOUT_MS);
      } catch {
        this.awaitingPong = false;
        this.forceReconnect();
      }
    }, PING_INTERVAL_MS);
  }

  private open(): void {
    const token = this.getToken();
    if (!token) return;
    this.events.onStatus?.('connecting');

    const url = `${this.baseUrl.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      const wasReconnect = this.everOpened;
      this.retry = 0;
      this.everOpened = true;
      this.events.onStatus?.('open');
      this.startHeartbeat();
      // 重连后服务端可能在我们断开期间堆积了信封，必须主动补拉，
      // 否则就会出现"服务器正常但收不到消息"
      if (wasReconnect) void this.events.onReconnect?.();
    };

    this.socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as {
          type: string;
          envelope?: EnvelopeDto;
          remaining?: number;
        };
        if (frame.type === 'pong') {
          this.awaitingPong = false;
          if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
          }
          return;
        }
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
      this.clearTimers();
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
    this.clearTimers();
    this.socket?.close();
  }
}
