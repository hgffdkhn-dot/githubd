import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/index.js';
import { Store } from '../src/store.js';

type Json = Record<string, unknown>;

/**
 * 泛型版 api：让 `body.devices` 这类字段有具体类型，
 * 否则断言处会报 unknown 无法访问属性。
 */
async function api<T = Json>(base: string, path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

const KEY = Buffer.alloc(32, 9).toString('base64');

async function register(base: string, username: string) {
  const result = await api<{ userId: string; deviceId: string; token: string; uid: string }>(base, '/v1/auth/register', {
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

  const listed = await api<{ devices: { id: string; label: string; platform: string; createdAt: number; lastSeen: number; current: boolean }[] }>(base, '/v1/devices/mine', {}, alice.token);
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

test('UID：读取个人资料时会一并返回，供老账号补回 UID', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);
  assert.match(alice.uid, /^\d{6}$/);

  // 读取资料接口必须带上 uid
  const result = await api(base, '/v1/profile', {}, alice.token);
  assert.equal(result.status, 200);
  assert.equal(result.body.uid, alice.uid, 'GET /v1/profile 应返回 uid');

  handle.close();
});

test('UID：老账号（无 uid 字段）载入快照后能自动补号', async () => {
  // 模拟 UID 功能上线前落盘的旧快照
  const store = new Store(null);
  const user = store.createUser('legacy', 'salt', 'hash');
  // 强制抹掉 uid，还原成"旧数据"的样子
  (user as { uid?: string }).uid = '';

  // 通过写入再载入来验证补号逻辑走了 load() 分支
  const snapshot = JSON.parse(
    JSON.stringify({
      users: [{ id: user.id, username: 'legacy', passwordSalt: 's', passwordHash: 'h', createdAt: 1 }],
      devices: [],
      signedPreKeys: [],
      oneTimePreKeys: [],
      envelopes: [],
      tokens: [],
      profiles: [],
      presence: [],
    }),
  );

  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(snapshot));

  const loaded = new Store(file);
  const found = loaded.findUserByUsername('legacy');
  assert.ok(found, '旧快照应能载入');
  assert.match(found!.uid, /^\d{6}$/, '载入时应自动补上 6 位 UID');
  assert.ok(loaded.findUserByUid(found!.uid), '补的 UID 应进入索引，可被搜索到');

  handle_unused: {
    // 仅占位，避免 lint 误判
  }
});

test('设备名：未上报时给出可读兜底，而不是"未命名设备"', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  // 模拟老客户端：注册时不带 deviceLabel
  const username = `legacy-${Date.now()}`;
  const reg = await api<{ token: string }>(base, '/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password: 'p',
      deviceId: 'dev-legacy',
      identityKey: 'a'.repeat(44),
      signingKey: 'b'.repeat(44),
      signedPreKey: { keyId: 1, publicKey: 'c'.repeat(44), signature: 'd'.repeat(64) },
      oneTimePreKeys: [],
    }),
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));

  const listed = await api<{ devices: { id: string; label: string; platform: string; createdAt: number; lastSeen: number; current: boolean }[] }>(base, '/v1/devices/mine', {}, reg.body.token);
  assert.equal(listed.status, 200);
  const device = listed.body.devices.find((d: { id: string }) => d.id === 'dev-legacy');
  assert.ok(device, '应能查到该设备');
  if (!device) throw new Error('设备缺失');
  assert.notEqual(device.label, '未命名设备');
  assert.notEqual(device.label, '未知设备');
  assert.ok(device.label.length > 0, '设备名不应为空');

  handle.close();
});

test('设备名：会话恢复路径也能刷新型号（不只是注册时）', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);

  // 模拟 restoreSession 后单独刷新设备名
  const updated = await api(
    base,
    '/v1/devices/label',
    { method: 'POST', body: JSON.stringify({ deviceId: alice.deviceId, label: 'Pixel 7（Android 14）', platform: 'android' }) },
    alice.token,
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const listed = await api<{ devices: { id: string; label: string; platform: string; createdAt: number; lastSeen: number; current: boolean }[] }>(base, '/v1/devices/mine', {}, alice.token);
  const mine = listed.body.devices.find((d: { id: string }) => d.id === alice.deviceId);
  if (!mine) throw new Error('设备缺失');
  assert.equal(mine.label, 'Pixel 7（Android 14）');

  handle.close();
});

test('设备名：不能改别人的设备', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const r = await api(
    base,
    '/v1/devices/label',
    { method: 'POST', body: JSON.stringify({ deviceId: 'someone-elses-device', label: 'hacked', platform: 'android' }) },
    alice.token,
  );
  assert.equal(r.status, 403, '越权改他人设备名应被拒绝');

  handle.close();
});

test('用户查询：可用 userId 回填用户名', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const username = `zed-${Date.now()}`;
  const alice = await register(base, username);

  const r = await api<{ user: { id: string; username: string; uid: string } | null }>(base, `/v1/users/${alice.userId}`, {}, alice.token);
  assert.equal(r.status, 200);
  if (!r.body.user) throw new Error('未返回用户');
  assert.equal(r.body.user.username, username);
  assert.equal(r.body.user.uid, alice.uid);

  handle.close();
});

test('网关：ping 帧会得到 pong（用于发现半开连接）', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const wsUrl = base.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsUrl}/v1/ws?token=${encodeURIComponent(alice.token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连接失败'));
  });

  const pong = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 pong 超时')), 3000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(String(e.data));
    };
    ws.send(JSON.stringify({ type: 'ping' }));
  });
  assert.match(pong, /"type":"pong"/);

  ws.close();
  handle.close();
});

test('设备名：未上报时给出可读兜底，而不是"未命名设备"', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  // 模拟老客户端：注册时不带 deviceLabel
  const username = `legacy-${Date.now()}`;
  const reg = await api<{ token: string }>(base, '/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password: 'p',
      deviceId: 'dev-legacy',
      identityKey: 'a'.repeat(44),
      signingKey: 'b'.repeat(44),
      signedPreKey: { keyId: 1, publicKey: 'c'.repeat(44), signature: 'd'.repeat(64) },
      oneTimePreKeys: [],
    }),
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));

  const listed = await api<{ devices: { id: string; label: string; platform: string; createdAt: number; lastSeen: number; current: boolean }[] }>(base, '/v1/devices/mine', {}, reg.body.token);
  assert.equal(listed.status, 200);
  const device = listed.body.devices.find((d: { id: string }) => d.id === 'dev-legacy');
  assert.ok(device, '应能查到该设备');
  if (!device) throw new Error('设备缺失');
  assert.notEqual(device.label, '未命名设备');
  assert.notEqual(device.label, '未知设备');
  assert.ok(device.label.length > 0, '设备名不应为空');

  handle.close();
});

test('设备名：会话恢复路径也能刷新型号（不只是注册时）', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;

  const alice = await register(base, `alice-${Date.now()}`);

  // 模拟 restoreSession 后单独刷新设备名
  const updated = await api(
    base,
    '/v1/devices/label',
    { method: 'POST', body: JSON.stringify({ deviceId: alice.deviceId, label: 'Pixel 7（Android 14）', platform: 'android' }) },
    alice.token,
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const listed = await api<{ devices: { id: string; label: string; platform: string; createdAt: number; lastSeen: number; current: boolean }[] }>(base, '/v1/devices/mine', {}, alice.token);
  const mine = listed.body.devices.find((d: { id: string }) => d.id === alice.deviceId);
  if (!mine) throw new Error('设备缺失');
  assert.equal(mine.label, 'Pixel 7（Android 14）');

  handle.close();
});

test('设备名：不能改别人的设备', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const r = await api(
    base,
    '/v1/devices/label',
    { method: 'POST', body: JSON.stringify({ deviceId: 'someone-elses-device', label: 'hacked', platform: 'android' }) },
    alice.token,
  );
  assert.equal(r.status, 403, '越权改他人设备名应被拒绝');

  handle.close();
});

test('用户查询：可用 userId 回填用户名', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const username = `zed-${Date.now()}`;
  const alice = await register(base, username);

  const r = await api<{ user: { id: string; username: string; uid: string } | null }>(base, `/v1/users/${alice.userId}`, {}, alice.token);
  assert.equal(r.status, 200);
  if (!r.body.user) throw new Error('未返回用户');
  assert.equal(r.body.user.username, username);
  assert.equal(r.body.user.uid, alice.uid);

  handle.close();
});

test('网关：ping 帧会得到 pong（用于发现半开连接）', async () => {
  const handle = await startServer(0, null);
  const base = `http://127.0.0.1:${handle.port}`;
  const alice = await register(base, `alice-${Date.now()}`);

  const wsUrl = base.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsUrl}/v1/ws?token=${encodeURIComponent(alice.token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连接失败'));
  });

  const pong = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 pong 超时')), 3000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(String(e.data));
    };
    ws.send(JSON.stringify({ type: 'ping' }));
  });
  assert.match(pong, /"type":"pong"/);

  ws.close();
  handle.close();
});
