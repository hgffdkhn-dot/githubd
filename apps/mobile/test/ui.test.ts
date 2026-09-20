/**
 * 时间格式化与代理校验的纯逻辑测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatConversationTime, formatPreview } from '../src/ui/timeFormat.js';
import { validateProxy, formatProxyAddress, toJavaProxyProperties } from '../src/settings/security.js';

/** 构造一个"今天 HH:mm"的时间戳 */
function atToday(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

test('时间：今天显示 HH:mm', () => {
  const now = new Date(2026, 8, 20, 15, 30).getTime(); // 2026/9/20 15:30
  assert.equal(formatConversationTime(atToday(9, 5, now), now), '09:05');
  assert.equal(formatConversationTime(atToday(14, 59, now), now), '14:59');
});

test('时间：昨天显示"昨天"', () => {
  const now = new Date(2026, 8, 20, 15, 30).getTime();
  const yesterday = now - 24 * 60 * 60 * 1000;
  assert.equal(formatConversationTime(yesterday, now), '昨天');
});

test('时间：无效时间戳返回空串而不是抛错', () => {
  assert.equal(formatConversationTime(0), '');
  assert.equal(formatConversationTime(Number.NaN), '');
  assert.equal(formatConversationTime(-1), '');
});

test('时间：跨年显示完整日期', () => {
  const now = new Date(2026, 0, 15).getTime();
  const old = new Date(2025, 11, 25).getTime();
  assert.equal(formatConversationTime(old, now), '2025/12/25');
});

test('时间：今年内显示月日', () => {
  const now = new Date(2026, 8, 20).getTime();
  const older = new Date(2026, 3, 5).getTime();
  assert.equal(formatConversationTime(older, now), '4月5日');
});

test('预览：压缩换行并截断', () => {
  assert.equal(formatPreview('  你好\n世界  '), '你好 世界');
  const long = 'a'.repeat(100);
  const out = formatPreview(long, 40);
  assert.equal(out.length, 41); // 40 字符 + 省略号
  assert.ok(out.endsWith('…'));
});

test('代理校验：正常配置', () => {
  const r = validateProxy({ protocol: 'http', host: '127.0.0.1', port: '8080' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.protocol, 'http');
    assert.equal(r.config.port, 8080);
  }
});

test('代理校验：SOCKS5', () => {
  const r = validateProxy({ protocol: 'socks5', host: 'proxy.example.com', port: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.protocol, 'socks5');
});

test('代理校验：拒绝地址里的协议前缀与端口', () => {
  // 用户很容易把 "http://1.2.3.4:8080" 整串粘进来
  const r = validateProxy({ protocol: 'http', host: 'http://1.2.3.4:8080', port: '8080' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /不要带/);
});

test('代理校验：端口范围', () => {
  assert.equal(validateProxy({ protocol: 'http', host: 'h', port: '0' }).ok, false);
  assert.equal(validateProxy({ protocol: 'http', host: 'h', port: '70000' }).ok, false);
  assert.equal(validateProxy({ protocol: 'http', host: 'h', port: 'abc' }).ok, false);
  assert.equal(validateProxy({ protocol: 'http', host: 'h', port: '65535' }).ok, true);
});

test('代理校验：缺地址或未知协议', () => {
  assert.equal(validateProxy({ protocol: 'http', host: '', port: '8080' }).ok, false);
  assert.equal(validateProxy({ protocol: 'ftp', host: 'h', port: '8080' }).ok, false);
});

test('代理展示：IPv6 地址加方括号', () => {
  const r = formatProxyAddress({
    enabled: true,
    protocol: 'http',
    host: '::1',
    port: 8080,
  });
  assert.equal(r, '[::1]:8080');

  assert.equal(
    formatProxyAddress({ enabled: true, protocol: 'http', host: '1.2.3.4', port: 80 }),
    '1.2.3.4:80',
  );
});

test('代理系统属性：HTTP 与 SOCKS5 键名不同', () => {
  const http = toJavaProxyProperties({ enabled: true, protocol: 'http', host: 'h', port: 8080 });
  assert.equal(http['http.proxyHost'], 'h');
  assert.equal(http['http.proxyPort'], '8080');

  const socks = toJavaProxyProperties({ enabled: true, protocol: 'socks5', host: 'h', port: 1080 });
  assert.equal(socks['socksProxyHost'], 'h');
  assert.equal(socks['socksProxyPort'], '1080');
  // SOCKS5 不应写 http.* 键
  assert.equal(socks['http.proxyHost'], undefined);
});
