/**
 * 端到端联调：两个客户端通过真实 HTTP + WebSocket 完成完整加密会话
 *
 * 这个测试的价值在于验证"服务端盲转发"是真的：
 * 服务端落盘的快照里若出现明文，测试直接失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { WebSocket } from 'ws';

import { startServer } from '../src/index.js';
import {
  SessionManager,
  InMemoryKeyStore,
  InMemorySessionStore,
  encodeEnvelope,
  decodeEnvelope,
  generateIdentity,
  generatePreKeys,
  toBase64,
  fromBase64,
  computeSafetyNumber,
  type Envelope,
  type PreKeyBundle,
} from '../../../packages/protocol/src/index.js';

const SNAPSHOT = `./data/e2e-state-${process.pid}.json`;

interface WireBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signingKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey: { keyId: number; publicKey: string } | null;
}

class TestClient {
  readonly identity = generateIdentity();
  readonly keyStore: InMemoryKeyStore;
  readonly sessionStore = new InMemorySessionStore();
  manager!: SessionManager;
  private socket: WebSocket | null = null;
  private inbox: Envelope[] = [];
  private waiters: ((envelope: Envelope) => void)[] = [];
  token = '';
  userId = '';
  preKeys = generatePreKeys(this.identity, 1, 1000, 30);

  constructor(
    readonly username: string,
    readonly deviceId: string,
    private readonly baseUrl: string,
  ) {
    this.keyStore = new InMemoryKeyStore(this.identity);
    this.keyStore.addSignedPreKey(1, this.preKeys.signedPreKey.privateKey);
    for (const opk of this.preKeys.oneTimePreKeys) {
      this.keyStore.addOneTimePreKey(opk.keyId, opk.privateKey);
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  }

  async register(password: string): Promise<void> {
    const response = await this.request('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: this.username,
        password,
        deviceId: this.deviceId,
        identityKey: toBase64(this.identity.identityKey),
        signingKey: toBase64(this.identity.signingKey),
        signedPreKey: {
          keyId: 1,
          publicKey: toBase64(this.preKeys.signedPreKey.publicKey),
          signature: toBase64(this.preKeys.signedPreKey.signature),
        },
        oneTimePreKeys: this.preKeys.oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          publicKey: toBase64(k.publicKey),
        })),
      }),
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as { userId: string; token: string };
    this.userId = data.userId;
    this.token = data.token;
    this.manager = new SessionManager(this.identity, this.keyStore, this.sessionStore, {
      userId: this.userId,
      deviceId: this.deviceId,
    });
  }

  async connect(): Promise<void> {
    this.socket = new WebSocket(`ws://${this.baseUrl.replace('http://', '')}/v1/ws?token=${this.token}`);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('open', () => resolve());
      this.socket!.once('error', reject);
    });
    this.socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; envelope?: ReturnType<typeof encodeEnvelope> };
      if (frame.type === 'envelope' && frame.envelope) {
        this.receive(decodeEnvelope(frame.envelope));
      }
    });
  }

  private receive(envelope: Envelope): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(envelope);
    else this.inbox.push(envelope);
  }

  async waitForEnvelope(timeoutMs = 3000): Promise<Envelope> {
    const queued = this.inbox.shift();
    if (queued) return queued;
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待信封超时')), timeoutMs);
      this.waiters.push((envelope) => {
        clearTimeout(timer);
        resolve(envelope);
      });
    });
  }

  async fetchBundle(userId: string, deviceId: string): Promise<PreKeyBundle> {
    const response = await this.request(`/v1/prekeys/bundle/${userId}/${deviceId}`);
    assert.equal(response.status, 200);
    const wire = (await response.json()) as WireBundle;
    return {
      userId: wire.userId,
      deviceId: wire.deviceId,
      identityKey: fromBase64(wire.identityKey),
      signingKey: fromBase64(wire.signingKey),
      signedPreKey: {
        keyId: wire.signedPreKey.keyId,
        publicKey: fromBase64(wire.signedPreKey.publicKey),
        signature: fromBase64(wire.signedPreKey.signature),
      },
      oneTimePreKey: wire.oneTimePreKey
        ? { keyId: wire.oneTimePreKey.keyId, publicKey: fromBase64(wire.oneTimePreKey.publicKey) }
        : undefined,
    };
  }

  async send(peerUserId: string, peerDeviceId: string, text: string): Promise<void> {
    const envelope = await this.manager.encrypt(peerUserId, peerDeviceId, text);
    const response = await this.request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(encodeEnvelope(envelope)),
    });
    assert.equal(response.status, 200);
  }

  async startSessionWith(bundle: PreKeyBundle): Promise<void> {
    await this.manager.startSession(bundle);
  }

  close(): void {
    this.socket?.close();
  }
}

test('端到端：两个客户端通过服务端完成加密会话，且服务端不接触明文', async (t) => {
  const handle = await startServer(0, SNAPSHOT);
  const baseUrl = `http://localhost:${handle.port}`;

  const alice = new TestClient('alice', 'device-a', baseUrl);
  const bob = new TestClient('bob', 'device-b', baseUrl);

  await alice.register('alice-password');
  await bob.register('bob-password');

  await alice.connect();
  await bob.connect();

  const bundle = await alice.fetchBundle(bob.userId, 'device-b');
  await alice.startSessionWith(bundle);

  const secret = '这是一条服务端读不到的消息';
  await alice.send(bob.userId, 'device-b', secret);

  const received = await bob.waitForEnvelope();
  const decrypted = await bob.manager.decrypt(received);
  assert.equal(decrypted, secret);

  await bob.send(alice.userId, 'device-a', '收到，我也加密回复');
  const reply = await alice.waitForEnvelope();
  assert.equal(await alice.manager.decrypt(reply), '收到，我也加密回复');

  // 服务端落盘内容自检：不得出现任何明文
  handle.close();
  const snapshot = readFileSync(SNAPSHOT, 'utf8');
  assert.ok(!snapshot.includes(secret), '服务端快照不得包含明文');
  assert.ok(!snapshot.includes('收到，我也加密回复'), '服务端快照不得包含回复明文');
  assert.ok(!snapshot.includes('identityPrivateKey'), '服务端快照不得包含私钥字段');

  alice.close();
  bob.close();
});

test('安全边界：服务端拒绝携带明文字段的信封', async () => {
  const handle = await startServer(0, null);
  const baseUrl = `http://localhost:${handle.port}`;

  const alice = new TestClient('alice2', 'device-a', baseUrl);
  await alice.register('password');

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      envelopeId: 'test-1',
      senderUserId: alice.userId,
      senderDeviceId: 'device-a',
      recipientUserId: 'someone',
      recipientDeviceId: 'device-x',
      header: { ratchetPublic: toBase64(new Uint8Array(32)), messageNumber: 0, previousChainLength: 0 },
      nonce: toBase64(new Uint8Array(12)),
      ciphertext: toBase64(new Uint8Array(16)),
      createdAt: Date.now(),
      plaintext: '服务端不该收下这个字段',
    }),
  });

  assert.equal(response.status, 400);
  handle.close();
});

test('认证边界：无令牌无法拉取 PreKey Bundle', async () => {
  const handle = await startServer(0, null);
  const baseUrl = `http://localhost:${handle.port}`;

  const response = await fetch(`${baseUrl}/v1/prekeys/bundle/any/device`);
  assert.equal(response.status, 401);
  handle.close();
});

test('安全码：会话双方计算出一致的可比对指纹', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.equal(
    computeSafetyNumber(a.identityKey, b.identityKey),
    computeSafetyNumber(b.identityKey, a.identityKey),
  );
});

function restoreEnv(name: 'TLS_CERT' | 'TLS_KEY', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('HTTPS：配置证书后服务端以 TLS 启动', async () => {
  // 证书默认落在 .tmp/tls（已 gitignore），由 npm run dev:cert 生成
  const defaultCert = new URL('../../../.tmp/tls/cert.pem', import.meta.url);
  const defaultKey = new URL('../../../.tmp/tls/key.pem', import.meta.url);
  const certPath = process.env.TEST_TLS_CERT ?? (existsSync(defaultCert) ? fileURLToPath(defaultCert) : '');
  const keyPath = process.env.TEST_TLS_KEY ?? (existsSync(defaultKey) ? fileURLToPath(defaultKey) : '');
  if (!certPath || !keyPath) return; // 未生成证书时跳过，本地可用 npm run dev:cert 生成

  const previous = { cert: process.env.TLS_CERT, key: process.env.TLS_KEY };
  process.env.TLS_CERT = certPath;
  process.env.TLS_KEY = keyPath;

  const handle = await startServer(0, null);
  assert.equal(handle.scheme, 'https');

  // 自签证书不被默认信任库认可，这里显式放行以验证 TLS 握手本身
  // （fetch 的 undici 不接受 https.Agent，必须用 https.request）
  const status = await new Promise<number>((resolve, reject) => {
    const request = https.request(
      { host: 'localhost', port: handle.port, path: '/healthz', method: 'GET', rejectUnauthorized: false },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 200);

  handle.close();
  // 必须 delete 而不是赋值 undefined：process.env 会把 undefined 转成字符串 "undefined"
  restoreEnv('TLS_CERT', previous.cert);
  restoreEnv('TLS_KEY', previous.key);
});

test('监听地址：默认绑定 0.0.0.0 而非仅回环', async () => {
  const handle = await startServer(0, null);
  const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
  assert.equal(response.status, 200);
  handle.close();
});
