/**
 * HTTP API
 *
 * 所有入参都经过字段白名单校验：
 * 客户端即使被篡改、即使恶意，也无法把明文或私钥"塞进"服务端。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Store } from './store.js';
import type { Gateway } from './gateway.js';
import { hashPassword, verifyPassword } from './auth.js';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PENDING = 500;

/** 信封中允许出现的字段；出现集合外的字段一律拒绝 */
const ENVELOPE_FIELDS = [
  'envelopeId',
  'senderUserId',
  'senderDeviceId',
  'recipientUserId',
  'recipientDeviceId',
  'x3dh',
  'header',
  'nonce',
  'ciphertext',
  'createdAt',
];

const FORBIDDEN_FIELD_PATTERN = /(plaintext|messageText|content|privateKey|sessionKey|rootKey|chainKey|messageKey)/i;

function assertNoForbiddenFields(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenFields(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_FIELD_PATTERN.test(k)) {
        throw new HttpError(400, `字段 ${path}${k} 不允许出现在服务端`);
      }
      assertNoForbiddenFields(v, `${path}${k}.`);
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Ctx {
  store: Store;
  gateway: Gateway;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

function requireString(body: Record<string, unknown>, field: string, max = 512): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HttpError(400, `字段 ${field} 非法`);
  }
  return value;
}

function authenticate(req: IncomingMessage, ctx: Ctx): { userId: string; deviceId: string } {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const record = token ? ctx.store.resolveToken(token) : undefined;
  if (!record) throw new HttpError(401, '未认证');
  return { userId: record.userId, deviceId: record.deviceId };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

type Route = (ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; handler: Route }[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/register$/,
    handler: async (ctx, _req, _res, body) => {
      const username = requireString(body, 'username', 64);
      const password = requireString(body, 'password', 256);
      const deviceId = requireString(body, 'deviceId', 128);
      const identityKey = requireString(body, 'identityKey', 128);
      const signingKey = requireString(body, 'signingKey', 128);

      assertNoForbiddenFields(body);

      if (ctx.store.findUserByUsername(username)) throw new HttpError(409, '用户名已存在');

      const { salt, hash } = await hashPassword(password);
      const user = ctx.store.createUser(username, salt, hash);

      ctx.store.upsertDevice({ id: deviceId, userId: user.id, identityKey, signingKey });
      publishKeys(ctx, user.id, deviceId, body);

      const token = ctx.store.issueToken(user.id, deviceId);
      return { userId: user.id, deviceId, token };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/login$/,
    handler: async (ctx, _req, _res, body) => {
      const username = requireString(body, 'username', 64);
      const password = requireString(body, 'password', 256);
      const deviceId = requireString(body, 'deviceId', 128);

      const user = ctx.store.findUserByUsername(username);
      if (!user) throw new HttpError(401, '用户名或口令错误');
      const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
      if (!ok) throw new HttpError(401, '用户名或口令错误');

      ctx.store.upsertDevice({
        id: deviceId,
        userId: user.id,
        identityKey: requireString(body, 'identityKey', 128),
        signingKey: requireString(body, 'signingKey', 128),
      });
      const token = ctx.store.issueToken(user.id, deviceId);
      return { userId: user.id, deviceId, token };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/prekeys\/publish$/,
    handler: async (ctx, req, _res, body) => {
      const { userId, deviceId } = authenticate(req, ctx);
      assertNoForbiddenFields(body);
      publishKeys(ctx, userId, deviceId, body);
      const count = ctx.store.countOneTimePreKeys(userId, deviceId);
      return { oneTimePreKeyCount: count, low: count < ctx.store.isPreKeyLow };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/prekeys\/bundle\/([^/]+)\/([^/]+)$/,
    handler: async (ctx, req, _res, _body) => {
      authenticate(req, ctx);
      const match = /^\/v1\/prekeys\/bundle\/([^/]+)\/([^/]+)$/.exec(req.url ?? '')!;
      const [, userId, deviceId] = match;

      const device = ctx.store.getDevice(userId, deviceId);
      if (!device) throw new HttpError(404, '设备不存在');

      const spk = ctx.store.getLatestSignedPreKey(userId, deviceId);
      if (!spk) throw new HttpError(404, '对端尚未发布签名预密钥');

      const opk = ctx.store.claimOneTimePreKey(userId, deviceId);
      const remaining = ctx.store.countOneTimePreKeys(userId, deviceId);

      // 低库存时提醒对端补充，避免握手退化为"无 OPK"模式
      if (remaining < ctx.store.isPreKeyLow) {
        ctx.gateway.pushToUser(userId, { type: 'prekey.low', remaining });
      }

      return {
        userId,
        deviceId,
        identityKey: device.identityKey,
        signingKey: device.signingKey,
        signedPreKey: { keyId: spk.keyId, publicKey: spk.publicKey, signature: spk.signature },
        oneTimePreKey: opk ? { keyId: opk.keyId, publicKey: opk.publicKey } : null,
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/users\/search$/,
    handler: async (ctx, req, _res, _body) => {
      authenticate(req, ctx);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = url.searchParams.get('q') ?? '';
      if (q.length < 1) return { users: [] };
      return { users: ctx.store.searchUsers(q) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/devices\/([^/]+)$/,
    handler: async (ctx, req, _res, _body) => {
      authenticate(req, ctx);
      const match = /^\/v1\/devices\/([^/]+)$/.exec(req.url ?? '')!;
      const devices = ctx.store.listDevices(match[1]);
      // 只返回公开身份材料，供发起方做身份校验与安全码
      return {
        devices: devices.map((d) => ({
          deviceId: d.id,
          identityKey: d.identityKey,
          signingKey: d.signingKey,
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/messages$/,
    handler: async (ctx, req, _res, body) => {
      const { userId, deviceId } = authenticate(req, ctx);
      assertNoForbiddenFields(body);
      assertEnvelopeShape(body);

      const envelope = body as Record<string, string | number> & {
        envelopeId: string;
        recipientUserId: string;
        recipientDeviceId: string;
      };

      if (envelope.senderUserId !== userId || envelope.senderDeviceId !== deviceId) {
        throw new HttpError(403, '信封身份与令牌不一致');
      }

      const record = {
        envelopeId: envelope.envelopeId,
        senderUserId: String(envelope.senderUserId),
        senderDeviceId: String(envelope.senderDeviceId),
        recipientUserId: envelope.recipientUserId,
        recipientDeviceId: envelope.recipientDeviceId,
        payload: envelope,
        createdAt: Date.now(),
      };
      ctx.store.enqueueEnvelope(record);

      const pushed = ctx.gateway.pushToUser(
        envelope.recipientUserId,
        { type: 'envelope', envelope },
        envelope.senderDeviceId,
      );
      if (pushed) ctx.store.markDelivered([envelope.envelopeId]);

      return { envelopeId: envelope.envelopeId, queued: !pushed };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/messages\/pending$/,
    handler: async (ctx, req, _res, _body) => {
      const { userId, deviceId } = authenticate(req, ctx);
      const pending = ctx.store.pendingFor(userId, deviceId).slice(0, MAX_PENDING);
      ctx.store.markDelivered(pending.map((p) => p.envelopeId));
      return { envelopes: pending.map((p) => p.payload) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/messages\/ack$/,
    handler: async (ctx, req, _res, body) => {
      authenticate(req, ctx);
      const ids = Array.isArray(body.envelopeIds) ? body.envelopeIds.filter((v) => typeof v === 'string') : [];
      ctx.store.acknowledge(ids.slice(0, 500));
      return { acknowledged: ids.length };
    },
  },
];

function assertEnvelopeShape(envelope: Record<string, unknown>): void {
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.includes(key)) throw new HttpError(400, `信封包含未知字段 ${key}`);
  }
  for (const field of ['envelopeId', 'senderUserId', 'senderDeviceId', 'recipientUserId', 'recipientDeviceId', 'nonce', 'ciphertext']) {
    if (typeof envelope[field] !== 'string') throw new HttpError(400, `信封字段 ${field} 非法`);
  }
  const header = envelope.header as Record<string, unknown> | undefined;
  if (!header || typeof header.ratchetPublic !== 'string' || typeof header.messageNumber !== 'number') {
    throw new HttpError(400, '信封消息头非法');
  }
  if (typeof envelope.ciphertext !== 'string' || (envelope.ciphertext as string).length > 128 * 1024) {
    throw new HttpError(413, '密文过长');
  }
}

function publishKeys(ctx: Ctx, userId: string, deviceId: string, body: Record<string, unknown>): void {
  const spk = body.signedPreKey as Record<string, unknown> | undefined;
  if (spk) {
    if (typeof spk.keyId !== 'number' || typeof spk.publicKey !== 'string' || typeof spk.signature !== 'string') {
      throw new HttpError(400, '签名预密钥字段非法');
    }
    ctx.store.publishSignedPreKey({
      userId,
      deviceId,
      keyId: spk.keyId,
      publicKey: spk.publicKey,
      signature: spk.signature,
      createdAt: Date.now(),
    });
  }

  const opks = body.oneTimePreKeys;
  if (Array.isArray(opks)) {
    const parsed = opks
      .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object')
      .map((k) => ({ keyId: Number(k.keyId), publicKey: String(k.publicKey ?? '') }))
      .filter((k) => Number.isInteger(k.keyId) && k.publicKey.length > 0 && k.publicKey.length <= 128)
      .slice(0, 200);
    if (parsed.length > 0) ctx.store.publishOneTimePreKeys(userId, deviceId, parsed);
  }
}

export function createApiServer(
  ctx: Ctx,
  factory: (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server = (handler) =>
    createServer(handler),
) {
  return factory(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0];

      if (method === 'GET' && path === '/healthz') {
        return send(res, 200, { ok: true });
      }

      const route = routes.find((r) => r.method === method && r.pattern.test(path));
      if (!route) {
        return send(res, 404, { error: 'not found' });
      }

      const body = method === 'POST' ? await readJson(req) : {};
      const result = await route.handler(ctx, req, res, body);
      return send(res, 200, result ?? {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : '内部错误';
      // 错误响应绝不回显请求体，避免把密文或密钥材料写进日志
      return send(res, status, { error: message });
    }
  });
}
