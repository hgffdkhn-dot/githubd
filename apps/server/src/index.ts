/**
 * 服务端入口
 *
 * 这里是"盲转发"信任模型的落点：
 * 服务端能做的只有鉴权、存公开密钥、排队密文、推送信封。
 * 它拿不到也永远不应该拿到 identity 私钥、SK、根密钥和明文。
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';

import { createApiServer, type Ctx } from './api.js';
import { Gateway } from './gateway.js';
import { Store } from './store.js';

const PORT = Number(process.env.PORT ?? 8787);
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? './data/state.json';
/** 真机必须能连到局域网地址，不能只监听回环 */
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 生产必须走 HTTPS：iOS ATS 与 Android 9+ 默认禁止明文 HTTP。
 * 本地自签证书可用于开发；生产用正规 CA 证书并开启证书固定。
 */
function buildHttpServer(requestHandler: (req: never, res: never) => void): Server {
  // 环境变量缺失时 Node 会给出字符串 "undefined"，必须显式排除
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  const configured =
    !!certPath && !!keyPath && certPath !== 'undefined' && keyPath !== 'undefined';

  if (configured) {
    return createHttpsServer(
      { cert: readFileSync(certPath!), key: readFileSync(keyPath!) },
      requestHandler as never,
    );
  }
  return createHttpServer(requestHandler as never);
}

export function startServer(port = PORT, snapshotPath: string | null = SNAPSHOT_PATH) {
  const store = new Store(snapshotPath);
  const ctx: Ctx = { store, gateway: undefined as unknown as Gateway };

  const httpServer = createApiServer(ctx, (handler) => buildHttpServer(handler));
  ctx.gateway = new Gateway({ server: httpServer, store });

  return new Promise<{ close: () => void; port: number; scheme: string }>((resolve) => {
    httpServer.listen(port, HOST, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const scheme = process.env.TLS_CERT && process.env.TLS_KEY ? 'https' : 'http';
      console.log(`[e2ee-server] 监听 ${scheme}://${HOST}:${actualPort}（只处理公开密钥与密文）`);
      if (scheme === 'http') {
        console.log('[e2ee-server] 警告：明文 HTTP，真机需配置 ATS 例外或改用 HTTPS');
      }
      resolve({
        port: actualPort,
        scheme,
        close: () => {
          ctx.gateway.close();
          httpServer.close();
          store.flush();
        },
      });
    });
  });
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('index.ts');
if (isDirectRun) {
  const handle = await startServer();
  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
