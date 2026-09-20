/**
 * 设备型号展示 + 好友名单 的纯逻辑测试
 *
 * 不依赖任何 RN 原生模块，可在 CI 直接跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDeviceLabel } from '../src/device/deviceInfo.js';
import { MemoryFriendStore } from '../src/friends/Friends.js';

test('设备型号：型号与系统都拿到时组合展示', () => {
  const label = formatDeviceLabel({
    model: 'Pixel 7',
    osName: 'Android',
    osVersion: '14',
    platform: 'android',
  });
  assert.equal(label, 'Pixel 7（Android 14）');
});

test('设备型号：只有型号时只显示型号', () => {
  assert.equal(
    formatDeviceLabel({ model: 'SM-S918B', osName: '', osVersion: '', platform: 'android' }),
    'SM-S918B',
  );
});

test('设备型号：什么都拿不到时给出可读兜底，而不是"未命名设备"', () => {
  // 这正是要修的问题：服务端默认显示"未命名设备"
  assert.equal(
    formatDeviceLabel({ model: '', osName: '', osVersion: '', platform: 'android' }),
    'Android 设备',
  );
  assert.equal(
    formatDeviceLabel({ model: '', osName: '', osVersion: '', platform: 'ios' }),
    'iOS 设备',
  );
});

test('设备型号：iOS 版本号前缀正确', () => {
  assert.equal(
    formatDeviceLabel({ model: '', osName: '', osVersion: '17.5', platform: 'ios' }),
    'iOS 17.5',
  );
});

test('设备型号：超长型号会被截断到 64 字符', () => {
  const label = formatDeviceLabel({
    model: 'X'.repeat(200),
    osName: 'Android',
    osVersion: '14',
    platform: 'android',
  });
  assert.ok(label.length <= 64, `长度应 <= 64，实际 ${label.length}`);
});

test('好友名单：可添加、去重、按添加时间倒序', async () => {
  const store = new MemoryFriendStore();

  await store.add({ userId: 'u1', username: 'alice', uid: '123456' });
  await store.add({ userId: 'u2', username: 'bob', uid: '234567' });

  const list = await store.list();
  assert.equal(list.length, 2);
  // 后添加的排在前面
  assert.equal(list[0].userId, 'u2');

  assert.equal(await store.has('u1'), true);
  assert.equal(await store.has('nobody'), false);
});

test('好友名单：重复添加不覆盖原 addedAt', async () => {
  const store = new MemoryFriendStore();
  await store.add({ userId: 'u1', username: 'alice' });
  const first = (await store.list())[0];

  // 稍后再添加一次（比如搜索页重复点"添加"）
  await new Promise((r) => setTimeout(r, 5));
  await store.add({ userId: 'u1', username: 'alice' });

  const after = (await store.list())[0];
  assert.equal(after.addedAt, first.addedAt, '重复添加不应把好友顶到列表最前');
  assert.equal((await store.list()).length, 1, '重复添加不应产生重复条目');
});

test('好友名单：删除后消失', async () => {
  const store = new MemoryFriendStore();
  await store.add({ userId: 'u1', username: 'alice' });
  await store.remove('u1');
  assert.equal((await store.list()).length, 0);
  assert.equal(await store.has('u1'), false);
});

test('好友名单：缺失 uid 时存为空串而不是 undefined', async () => {
  const store = new MemoryFriendStore();
  await store.add({ userId: 'u1', username: 'alice' });
  const list = await store.list();
  assert.equal(list[0].uid, '');
});
