import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/index.js';
import { Store } from '../src/store.js';

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
  return result.body as unknown as { userId: string; deviceId: string; token: string; uid: string };
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

test('UID：注册即分配 6 位数字，且可用 UID 精确搜到', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);
  assert.match(alice.uid, /^\d{6}$/, 'UID 应为 6 位数字');

  const bob = await register(base, `bob-${Date.now()}`);
  assert.match(bob.uid, /^\d{6}$/);

  // UID 必须唯一，否则"搜 UID 加好友"会加错人
  assert.notEqual(alice.uid, bob.uid);

  // 用 UID 精确搜索
  const found = await api(base, `/v1/users/search?q=${alice.uid}`, {}, bob.token);
  const users = found.body.users as { id: string; username: string; uid: string }[];
  assert.equal(found.status, 200);
  assert.equal(users.length, 1, '按 UID 应精确命中 1 人');
  assert.equal(users[0].id, alice.userId);
  assert.equal(users[0].uid, alice.uid);

  handle.close();
});

test('UID：批量注册不产生重复（碰撞防护）', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const uids = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const u = await register(base, `bulk-${Date.now()}-${i}`);
    assert.match(u.uid, /^\d{6}$/);
    uids.add(u.uid);
  }
  // 纯随机 6 位数在 60 个用户时碰撞概率约 0.2%，但实现必须做到 0
  assert.equal(uids.size, 60, '60 个用户的 UID 必须两两不同');

  handle.close();
});

test('UID：用户名搜索照常可用，并一并返回 UID', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `zzq-${Date.now()}`);
  const bob = await register(base, `bob-${Date.now()}`);

  const found = await api(base, `/v1/users/search?q=zzq`, {}, bob.token);
  const users = found.body.users as { id: string; uid: string }[];
  assert.equal(users.length, 1);
  assert.equal(users[0].uid, alice.uid, '搜索结果应带上 UID');

  handle.close();
});

test('UID：搜索限流，防止遍历 UID 扒取用户名单', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  let limited = false;
  for (let i = 0; i < 25; i++) {
    const r = await api(base, '/v1/users/search?q=999999', {}, alice.token);
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, '超出配额后应返回 429');

  handle.close();
});

test('内存维护：清理不会误删有效数据', async () => {
  const store = new Store(null);
  store.createUser('alice', 'salt', 'hash');
  store.heartbeatPresence('alice', true);

  const result = store.cleanup();
  // 刚建的数据都没过期，一条都不该被清掉
  assert.equal(result.tokens, 0, '未过期令牌不应被清理');
  assert.equal(result.presence, 0, '刚上报的在线状态不应被清理');
  assert.ok(store.memoryReport().includes('users=1'));
});

test('内存维护：过期令牌会被真正回收', async () => {
  const store = new Store(null);
  store.createUser('bob', 'salt', 'hash');

  // 模拟"客户端卸载后不再访问"：令牌已过期，且从未被 resolve 过。
  // 注意不能先调 resolveToken —— 它在遇到过期时会顺手删掉，
  // 那样就测不出"主动回收"这条路径了。
  store.issueToken(
    (store.findUserByUsername('bob') as { id: string }).id,
    'device-1',
    -1000, // 负 TTL = 立即过期
  );

  // 关键：即使没人访问它，清理也要把它回收掉
  const result = store.cleanup();
  assert.equal(result.tokens, 1, '过期令牌必须被主动回收，而不是等被访问');
});

test('内存维护：陈旧在线状态会被回收', async () => {
  const store = new Store(null);
  store.heartbeatPresence('alice', true);

  // 把最后活跃时间改到 100 天前
  store.debugAgePresence('alice', 100 * 24 * 3600_000);

  const result = store.cleanup();
  assert.equal(result.presence, 1, '超过 90 天未活跃的在线记录应被回收');
});
