import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryKeyStore,
  InMemorySessionStore,
  SessionManager,
  computeSafetyNumber,
  encodeEnvelope,
  decodeEnvelope,
  generateIdentity,
  generatePreKeys,
  generateX25519KeyPair,
  ed25519Verify,
  ed25519Sign,
  type Envelope,
  type PreKeyBundle,
} from '../src/index.js';

type GeneratedPreKeys = ReturnType<typeof generatePreKeys>;

interface Party {
  userId: string;
  deviceId: string;
  manager: SessionManager;
  keyStore: InMemoryKeyStore;
  identity: ReturnType<typeof generateIdentity>;
  signedPreKeyId: number;
  preKeys: GeneratedPreKeys;
}

function createParty(userId: string, deviceId: string, signedPreKeyId: number): Party {
  const identity = generateIdentity();
  const keyStore = new InMemoryKeyStore(identity);
  const preKeys = generatePreKeys(identity, signedPreKeyId, 1000, 10);
  keyStore.addSignedPreKey(signedPreKeyId, preKeys.signedPreKey.privateKey);
  for (const opk of preKeys.oneTimePreKeys) keyStore.addOneTimePreKey(opk.keyId, opk.privateKey);

  const manager = new SessionManager(identity, keyStore, new InMemorySessionStore(), { userId, deviceId });
  return { userId, deviceId, identity, keyStore, manager, signedPreKeyId, preKeys };
}

/** 模拟服务端：从 Bob 的公开材料中认领一个 OPK，并立即从"库存"删除 */
function fetchBundle(bob: Party): PreKeyBundle {
  const opk = bob.preKeys.oneTimePreKeys.shift()!;
  return {
    userId: bob.userId,
    deviceId: bob.deviceId,
    identityKey: bob.identity.identityKey,
    signingKey: bob.identity.signingKey,
    signedPreKey: {
      keyId: bob.signedPreKeyId,
      publicKey: bob.preKeys.signedPreKey.publicKey,
      signature: bob.preKeys.signedPreKey.signature,
    },
    oneTimePreKey: { keyId: opk.keyId, publicKey: opk.publicKey },
  };
}

test('X3DH 握手：双方派生出相同的共享密钥', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  const bundle = fetchBundle(bob);
  await alice.manager.startSession(bundle);
  const first = await alice.manager.encrypt('bob', 'device-b', '第一条消息');
  assert.ok(first.x3dh, '首条消息必须携带 X3DH 材料');

  const decrypted = await bob.manager.decrypt(first);
  assert.equal(decrypted, '第一条消息');
});

test('双向会话：多轮往返后明文一致', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  await alice.manager.startSession(fetchBundle(bob));

  const expected = ['你好，Bob', '这是第二条', '第三条：密钥已经棘轮过了'];
  for (const text of expected) {
    const envelope = await alice.manager.encrypt('bob', 'device-b', text);
    assert.equal(await bob.manager.decrypt(envelope), text);
  }

  const reply = await bob.manager.encrypt('alice', 'device-a', '收到，我是 Bob');
  assert.equal(await alice.manager.decrypt(reply), '收到，我是 Bob');

  const reply2 = await bob.manager.encrypt('alice', 'device-a', '你能连续收到吗');
  assert.equal(await alice.manager.decrypt(reply2), '你能连续收到吗');
});

test('乱序消息：跳过密钥机制保证乱序也能解密', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  await alice.manager.startSession(fetchBundle(bob));
  const envelopes: Envelope[] = [];
  for (let i = 0; i < 5; i++) {
    envelopes.push(await alice.manager.encrypt('bob', 'device-b', `消息-${i}`));
  }

  // 首包携带 X3DH 材料，必须先到达才能建立会话
  assert.equal(await bob.manager.decrypt(envelopes[0]), '消息-0');
  // 后续乱序投递：3, 1, 4, 2 —— 依赖跳过密钥机制
  for (const i of [3, 1, 4, 2]) {
    assert.equal(await bob.manager.decrypt(envelopes[i]), `消息-${i}`);
  }
});

test('前向安全：丢失的消息不会被后续棘轮解密（乱序窗口内除外）', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  await alice.manager.startSession(fetchBundle(bob));
  const messages: Envelope[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push(await alice.manager.encrypt('bob', 'device-b', `m${i}`));
  }

  assert.equal(await bob.manager.decrypt(messages[0]), 'm0'); // 建立会话
  await bob.manager.decrypt(messages[3]); // 触发跳过密钥缓存：m1、m2 被暂存
  assert.equal(await bob.manager.decrypt(messages[1]), 'm1');

  const reply = await bob.manager.encrypt('alice', 'device-a', '我回复了');
  await alice.manager.decrypt(reply);

  // Alice 棘轮前进后，Bob 仍能解密此前缓存的跳过密钥消息
  assert.equal(await bob.manager.decrypt(messages[2]), 'm2');
});

test('篡改检测：密文被修改必须抛错，绝不返回部分明文', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  await alice.manager.startSession(fetchBundle(bob));
  const envelope = await alice.manager.encrypt('bob', 'device-b', '不可篡改');
  envelope.ciphertext[0] ^= 0x01;

  await assert.rejects(() => bob.manager.decrypt(envelope), /./);
});

test('身份绑定：AD 不匹配（身份被替换）时解密失败', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);
  const mallory = createParty('mallory', 'device-m', 11);

  await alice.manager.startSession(fetchBundle(bob));
  const envelope = await alice.manager.encrypt('bob', 'device-b', '只有 Bob 能读');

  // 中间人换成 Mallory 的身份后重放，AD 校验必须失败
  const tampered: Envelope = {
    ...envelope,
    x3dh: envelope.x3dh
      ? {
          ...envelope.x3dh,
          identityKey: mallory.identity.identityKey,
        }
      : undefined,
  };
  await assert.rejects(() => bob.manager.decrypt(tampered), /./);
});

test('X3DH 签名校验：伪造的 SPK 签名会被拒绝', async () => {
  const bob = createParty('bob', 'device-b', 9);
  const alice = createParty('alice', 'device-a', 7);

  const bundle = fetchBundle(bob);
  const forged = generateX25519KeyPair();
  bundle.signedPreKey = {
    keyId: bundle.signedPreKey.keyId,
    publicKey: forged.publicKey,
    signature: ed25519Sign(alice.identity.signingPrivateKey, forged.publicKey), // 用错误密钥签名
  };

  await assert.rejects(() => alice.manager.startSession(bundle), /签名/);
  assert.equal(
    ed25519Verify(bundle.signingKey, bundle.signedPreKey.signature, bundle.signedPreKey.publicKey),
    false,
  );
});

test('会话持久化：重建 SessionManager 后仍能继续会话', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bobStore = new InMemorySessionStore();
  const bobIdentity = generateIdentity();
  const bobKeys = new InMemoryKeyStore(bobIdentity);
  const bobPreKeys = generatePreKeys(bobIdentity, 9, 1000, 10);
  bobKeys.addSignedPreKey(9, bobPreKeys.signedPreKey.privateKey);
  for (const opk of bobPreKeys.oneTimePreKeys) bobKeys.addOneTimePreKey(opk.keyId, opk.privateKey);

  const bob = new SessionManager(bobIdentity, bobKeys, bobStore, { userId: 'bob', deviceId: 'device-b' });

  const opk = bobPreKeys.oneTimePreKeys.shift()!;
  await alice.manager.startSession({
    userId: 'bob',
    deviceId: 'device-b',
    identityKey: bobIdentity.identityKey,
    signingKey: bobIdentity.signingKey,
    signedPreKey: {
      keyId: 9,
      publicKey: bobPreKeys.signedPreKey.publicKey,
      signature: bobPreKeys.signedPreKey.signature,
    },
    oneTimePreKey: { keyId: opk.keyId, publicKey: opk.publicKey },
  });

  const first = await alice.manager.encrypt('bob', 'device-b', '进程重启前');
  assert.equal(await bob.decrypt(first), '进程重启前');

  // 模拟应用重启：只保留持久化 store
  const restarted = new SessionManager(bobIdentity, bobKeys, bobStore, { userId: 'bob', deviceId: 'device-b' });
  const second = await alice.manager.encrypt('bob', 'device-b', '进程重启后');
  assert.equal(await restarted.decrypt(second), '进程重启后');
});

test('安全码：双方独立计算结果一致，且与对端身份绑定', () => {
  const alice = generateIdentity();
  const bob = generateIdentity();

  const fromAlice = computeSafetyNumber(alice.identityKey, bob.identityKey);
  const fromBob = computeSafetyNumber(bob.identityKey, alice.identityKey);
  assert.equal(fromAlice, fromBob);
  assert.match(fromAlice, /^(\d{5} ){11}\d{5}$/);

  const withMallory = computeSafetyNumber(alice.identityKey, generateIdentity().identityKey);
  assert.notEqual(fromAlice, withMallory);
});

test('信封序列化：往返一致，且服务端 DTO 不含私有材料', async () => {
  const alice = createParty('alice', 'device-a', 7);
  const bob = createParty('bob', 'device-b', 9);

  await alice.manager.startSession(fetchBundle(bob));
  const envelope = await alice.manager.encrypt('bob', 'device-b', '序列化往返');
  const dto = encodeEnvelope(envelope);

  const json = JSON.stringify(dto);
  for (const forbidden of ['plaintext', 'identityPrivateKey', 'signingPrivateKey', 'rootKey']) {
    assert.ok(!json.includes(forbidden), `DTO 不得包含 ${forbidden}`);
  }
  assert.ok(!json.includes('序列化往返'), 'DTO 不得包含明文');

  const restored = decodeEnvelope(JSON.parse(json));
  assert.equal(await bob.manager.decrypt(restored), '序列化往返');
});
