/**
 * 服务器地址兜底测试
 *
 * 针对实际出现过的问题：清除应用数据后重新注册，报"地址指向了本机"。
 *
 * 原因链条：
 *  1. 清数据 → 本地覆盖值没了 → 回退到构建时烘焙的 BUILTIN_SERVER
 *  2. `?? `只对 null/undefined 兜底，空串会原样通过
 *  3. 兜底链上一旦出现 localhost/127.0.0.1，手机上永远连不上
 *     （手机上的 localhost 指手机自己，不是开发机）
 *
 * 所以出口必须过 normalizeServerUrl，保证拿到的地址一定可用。
 *
 * 运行：node --test apps/mobile/test/*.test.ts（用 tsx）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerUrl, DEFAULT_SERVER } from '../src/network/serverConfig.js';

test('空值一律回退到默认服务器', () => {
  assert.equal(normalizeServerUrl(null), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl(undefined), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl(''), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl('   '), DEFAULT_SERVER);
});

test('localhost / 127.0.0.1 必须被换掉（手机上永远连不上）', () => {
  // 这是实际出过问题的场景
  assert.equal(normalizeServerUrl('http://localhost:8787'), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl('http://127.0.0.1:8787'), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl('http://0.0.0.0:8787'), DEFAULT_SERVER);
});

test('格式非法的地址回退，而不是原样使用', () => {
  // 只写 IP 没写协议、或干脆是乱码
  assert.equal(normalizeServerUrl('47.239.14.144:8787'), DEFAULT_SERVER);
  assert.equal(normalizeServerUrl('不是网址'), DEFAULT_SERVER);
});

test('正常地址原样保留', () => {
  assert.equal(normalizeServerUrl('http://47.239.14.144:8787'), 'http://47.239.14.144:8787');
  assert.equal(normalizeServerUrl('https://chat.example.com'), 'https://chat.example.com');
  // 带空格要 trim
  assert.equal(normalizeServerUrl('  https://chat.example.com  '), 'https://chat.example.com');
});

test('默认服务器地址本身必须可用（不是本机地址）', () => {
  // 防止有人改 DEFAULT_SERVER 时改回了 localhost
  const host = new URL(DEFAULT_SERVER).hostname;
  assert.notEqual(host, 'localhost');
  assert.notEqual(host, '127.0.0.1');
  assert.notEqual(host, '0.0.0.0');
});
