import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/index.js';

type Json = Record<string, unknown>;

async function api(base: string, path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json()) as Json;
  return { status: response.status, body };
}

const KEY = Buffer.alloc(32, 9).toString('base64');

async function register(base: string, username: string) {
  const result = await api(base, '/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password: 'pw',
      deviceId: `${username}-device`,
      identityKey: KEY,
      signingKey: KEY,
    }),
  });
  assert.equal(result.status, 200);
  return result.body as unknown as { userId: string; deviceId: string; token: string };
}

test('设备管理：可查看设备列表，且不能踢出当前设备', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);

  const listed = await api(base, '/v1/devices/mine', {}, alice.token);
  const devices = listed.body.devices as { id: string; current: boolean }[];
  assert.equal(devices.length, 1);
  assert.equal(devices[0].current, true);

  // 踢出自己会让当前会话立刻失效，属于误操作，必须拒绝
  const selfRevoke = await api(
    base,
    '/v1/devices/revoke',
    { method: 'POST', body: JSON.stringify({ deviceId: alice.deviceId }) },
    alice.token,
  );
  assert.equal(selfRevoke.status, 400);

  handle.close();
});

test('个人主页：friends 模式只存密文，服务端读不到明文', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);
  const ciphertext = Buffer.alloc(32, 3).toString('base64');

  const saved = await api(
    base,
    '/v1/profile',
    {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'friends',
        encrypted: { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext },
      }),
    },
    alice.token,
  );
  assert.equal(saved.status, 200);

  // 别人查询时只拿到密文，拿不到明文昵称
  const bob = await register(base, `bob-${Date.now()}`);
  const seen = await api(base, `/v1/profile/user/${alice.userId}`, {}, bob.token);
  const profile = seen.body.profile as { visibility: string; displayName?: string };
  assert.equal(profile.visibility, 'friends');
  assert.equal(profile.displayName, undefined);

  handle.close();
});

test('个人主页：public 模式必须带昵称，否则拒绝', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const bad = await api(
    base,
    '/v1/profile',
    { method: 'PUT', body: JSON.stringify({ visibility: 'public', publicFields: { displayName: '', bio: '' } }) },
    alice.token,
  );
  assert.equal(bad.status, 400);

  const good = await api(
    base,
    '/v1/profile',
    { method: 'PUT', body: JSON.stringify({ visibility: 'public', publicFields: { displayName: '小明', bio: 'hi' } }) },
    alice.token,
  );
  assert.equal(good.status, 200);

  handle.close();
});

test('在线状态：关闭展示后不泄露任何时间戳', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);
  const bob = await register(base, `bob-${Date.now()}`);

  // 上报一次，但声明不展示
  await api(
    base,
    '/v1/presence/heartbeat',
    { method: 'POST', body: JSON.stringify({ visible: false }) },
    alice.token,
  );

  const result = await api(base, `/v1/presence?ids=${alice.userId}`, {}, bob.token);
  const entry = (result.body.presence as Record<string, { hidden: boolean; lastSeen: number }>)[
    alice.userId
  ];
  assert.equal(entry.hidden, true);
  assert.equal(entry.lastSeen, 0); // 关键：不给任何时间信息

  // 开启展示后可见
  await api(
    base,
    '/v1/presence/heartbeat',
    { method: 'POST', body: JSON.stringify({ visible: true }) },
    alice.token,
  );
  const after = await api(base, `/v1/presence?ids=${alice.userId}`, {}, bob.token);
  const entry2 = (after.body.presence as Record<string, { hidden: boolean; online: boolean }>)[
    alice.userId
  ];
  assert.equal(entry2.hidden, false);
  assert.equal(entry2.online, true);

  handle.close();
});

test('在线状态：无令牌不能查询他人状态', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const anon = await api(base, `/v1/presence?ids=${alice.userId}`);
  assert.equal(anon.status, 401);

  handle.close();
});
