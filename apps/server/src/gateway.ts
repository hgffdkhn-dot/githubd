/**
 * WebSocket 网关：只负责连接管理、鉴权与转发
 *
 * 网关看不到明文，也不解析信封结构 —— 它对 payload 做的是"透传"。
 * 所有 message 事件都必须携带 token，连接建立后不再接受匿名帧。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { Store } from './store.js';

export interface GatewayOptions {
  server: Server;
  store: Store;
  path?: string;
}

interface Connection {
  socket: WebSocket;
  userId: string;
  deviceId: string;
}

export class Gateway {
  private wss: WebSocketServer;
  private connections = new Map<WebSocket, Connection>();
  private heartbeat: NodeJS.Timeout;

  constructor(private readonly opts: GatewayOptions) {
    this.wss = new WebSocketServer({ server: opts.server, path: opts.path ?? '/v1/ws' });

    this.wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');
      const record = token ? this.opts.store.resolveToken(token) : undefined;

      if (!record) {
        socket.close(4401, 'unauthorized');
        return;
      }

      this.connections.set(socket, { socket, userId: record.userId, deviceId: record.deviceId });
      socket.send(JSON.stringify({ type: 'ready', deviceId: record.deviceId }));

      socket.on('message', (raw) => this.handleFrame(socket, raw));
      socket.on('close', () => this.connections.delete(socket));
      socket.on('error', () => this.connections.delete(socket));
      socket.on('pong', () => {
        (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
      });
    });

    this.heartbeat = setInterval(() => {
      for (const socket of this.wss.clients) {
        const anySocket = socket as WebSocket & { isAlive?: boolean };
        if (anySocket.isAlive === false) {
          this.connections.delete(socket);
          socket.terminate();
          continue;
        }
        anySocket.isAlive = false;
        socket.ping();
      }
    }, 30000);
    this.heartbeat.unref?.();
  }

  private handleFrame(socket: WebSocket, raw: unknown): void {
    const conn = this.connections.get(socket);
    if (!conn) return;
    let frame: { type?: string; envelopeIds?: string[] };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    // 客户端心跳：用于发现"半开"连接（移动网络下 TCP 已断但无 FIN）
    if (frame.type === 'ping') {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }
    // 客户端收到并成功解密后才 ack；ack 前服务端保留信封
    if (frame.type === 'ack' && Array.isArray(frame.envelopeIds)) {
      this.opts.store.acknowledge(frame.envelopeIds.slice(0, 500));
    }
  }

  /** 推送给指定用户的所有在线设备（多设备场景） */
  pushToUser(userId: string, payload: unknown, excludeDeviceId?: string): boolean {
    let delivered = false;
    for (const conn of this.connections.values()) {
      if (conn.userId !== userId) continue;
      if (excludeDeviceId && conn.deviceId === excludeDeviceId) continue;
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      conn.socket.send(JSON.stringify(payload));
      delivered = true;
    }
    return delivered;
  }

  isOnline(userId: string): boolean {
    for (const conn of this.connections.values()) if (conn.userId === userId) return true;
    return false;
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
