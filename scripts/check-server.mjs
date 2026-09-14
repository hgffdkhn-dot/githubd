/**
 * 真机前的服务端自检
 *
 * 用法：node scripts/check-server.mjs http://192.168.1.100:8787
 *
 * 目的：在打开 App 之前先确认"网络可达 + 服务正常 + 安全边界生效"，
 * 避免把真机连不上误判成客户端 bug。
 */

const target = process.argv[2] ?? process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';
const base = target.replace(/\/$/, '');

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`自检目标：${base}\n`);

  const url = new URL(base);
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const isHttps = url.protocol === 'https:';

  if (isHttps) {
    check('传输协议', true, 'HTTPS');
  } else if (isLoopback) {
    // 模拟器访问宿主机回环属于本机场景，明文可接受
    console.log('[WARN] 传输协议 — 明文 HTTP（回环地址，仅限本机开发）');
  } else {
    check(
      '传输协议',
      false,
      `明文 HTTP 且目标为 ${url.hostname}，真机会被 iOS ATS / Android 9+ 拦截，必须改用 HTTPS 或配置平台例外`,
    );
  }

  try {
    const response = await fetch(`${base}/healthz`);
    check('服务可达', response.ok, `HTTP ${response.status}`);
  } catch (error) {
    check('服务可达', false, `${(error).message} — 检查服务端是否在跑、IP 是否正确、防火墙是否放行`);
  }

  try {
    const response = await fetch(`${base}/v1/prekeys/bundle/any/device`);
    check('未认证访问被拒', response.status === 401, `HTTP ${response.status}`);
  } catch {
    check('未认证访问被拒', false, '请求失败');
  }

  const stamp = Date.now();
  const username = `probe-${stamp}`;
  const deviceId = `probe-device-${stamp}`;
  const fakeKey = Buffer.alloc(32, 7).toString('base64');

  try {
    const response = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'probe-password',
        deviceId,
        identityKey: fakeKey,
        signingKey: fakeKey,
      }),
    });
    const data = await response.json();
    check('注册接口可用', response.ok, response.ok ? `userId=${data.userId}` : `HTTP ${response.status}`);

    if (data.token) {
      const badEnvelope = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${data.token}` },
        body: JSON.stringify({
          envelopeId: `probe-${stamp}`,
          senderUserId: data.userId,
          senderDeviceId: deviceId,
          recipientUserId: 'nobody',
          recipientDeviceId: 'nowhere',
          header: { ratchetPublic: fakeKey, messageNumber: 0, previousChainLength: 0 },
          nonce: Buffer.alloc(12, 1).toString('base64'),
          ciphertext: Buffer.alloc(16, 2).toString('base64'),
          createdAt: stamp,
          plaintext: '服务端不该收下这个字段',
        }),
      });
      check('明文字段被拒绝', badEnvelope.status === 400, `HTTP ${badEnvelope.status}`);
    }
  } catch (error) {
    check('注册接口可用', false, (error).message);
  }

  console.log(`\n${failures === 0 ? '全部通过，可以开始真机验证' : `${failures} 项未通过，先修服务端再开 App`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
