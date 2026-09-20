/**
 * 安全设置：会话预览开关 + 代理配置
 *
 * 这两项都属于"安全"范畴，所以放在同一处。
 */

import * as safeStore from '../storage/safeStore.js';

const PREVIEW_KEY = 'e2ee.security.messagePreview';
const PROXY_KEY = 'e2ee.security.proxy';

// ---------------------------------------------------------------------
// 会话列表消息预览
// ---------------------------------------------------------------------

/**
 * 是否在主界面会话列表显示最后一条消息的内容
 *
 * 默认开启（微信/Telegram 的常规体验）。
 * 关闭后主界面只显示时间与条数，本地数据库不再写入明文预览。
 *
 * 注意：这只影响**本地**明文。服务端始终只经手密文，
 * 关掉它不会改变端到端加密的强度，只是缩小本机泄露面。
 */
export async function loadPreviewsEnabled(): Promise<boolean> {
  const raw = await safeStore.getItem(PREVIEW_KEY);
  return raw !== '0';
}

export async function setPreviewsEnabled(value: boolean): Promise<void> {
  await safeStore.setItem(PREVIEW_KEY, value ? '1' : '0');
  previewCache = value;
}

/**
 * 同步读取预览开关
 *
 * 消息落库发生在同步代码路径里，来不及 await。
 * 所以启动时预加载一次到内存，之后同步读取。
 */
let previewCache: boolean | null = null;

export function previewsEnabled(): boolean {
  return previewCache !== false;
}

/** 启动时调用：把持久化值载入内存缓存 */
export async function initPreviewsFlag(): Promise<boolean> {
  previewCache = await loadPreviewsEnabled();
  return previewCache;
}

/** 关闭预览时同步把缓存置为 false，立即停止写明文 */
export function setPreviewsEnabledSync(value: boolean): void {
  previewCache = value;
}

// ---------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------

/** 两种最通用的正向代理协议 */
export type ProxyProtocol = 'http' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  /** 可选的用户名 / 口令；为空表示匿名代理 */
  username?: string;
  password?: string;
}

export const EMPTY_PROXY: ProxyConfig = {
  enabled: false,
  protocol: 'http',
  host: '',
  port: 8080,
};

export const PROTOCOL_LABELS: Record<ProxyProtocol, string> = {
  http: 'HTTP / HTTPS 代理',
  socks5: 'SOCKS5 代理',
};

/**
 * 校验并归一化代理配置（纯函数，便于测试）
 *
 * 返回错误信息而不是抛异常，UI 直接展示即可。
 */
export function validateProxy(input: {
  protocol: string;
  host: string;
  port: string | number;
}): { ok: true; config: { protocol: ProxyProtocol; host: string; port: number } } | { ok: false; error: string } {
  const protocol = input.protocol === 'socks5' ? 'socks5' : input.protocol === 'http' ? 'http' : null;
  if (!protocol) return { ok: false, error: '请选择代理协议' };

  const host = (input.host ?? '').trim();
  if (!host) return { ok: false, error: '请填写代理地址' };
  // 不允许带协议前缀或路径：只接受纯主机名或 IP
  if (/[:/\\]/.test(host) && !host.startsWith('[')) {
    return { ok: false, error: '代理地址只填主机名或 IP，不要带 http:// 或端口' };
  }

  const port = typeof input.port === 'number' ? input.port : Number.parseInt(String(input.port), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '端口必须是 1–65535 之间的整数' };
  }

  return { ok: true, config: { protocol, host, port } };
}

/** 拼成展示用的 `host:port`；未配置时返回空串 */
export function formatProxyAddress(config: ProxyConfig): string {
  if (!config.host) return '';
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `${host}:${config.port}`;
}

/** 生成 Java 系统属性形式的代理配置，供原生层使用 */
export function toJavaProxyProperties(config: ProxyConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.protocol === 'http') {
    out['http.proxyHost'] = config.host;
    out['http.proxyPort'] = String(config.port);
    out['https.proxyHost'] = config.host;
    out['https.proxyPort'] = String(config.port);
  } else {
    out['socksProxyHost'] = config.host;
    out['socksProxyPort'] = String(config.port);
  }
  return out;
}

export async function loadProxy(): Promise<ProxyConfig> {
  const raw = await safeStore.getItem(PROXY_KEY);
  if (!raw) return { ...EMPTY_PROXY };
  try {
    const parsed = JSON.parse(raw) as Partial<ProxyConfig>;
    const port = Number(parsed.port);
    return {
      enabled: parsed.enabled === true,
      protocol: parsed.protocol === 'socks5' ? 'socks5' : 'http',
      host: typeof parsed.host === 'string' ? parsed.host : '',
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080,
      username: parsed.username ?? '',
      password: parsed.password ?? '',
    };
  } catch {
    return { ...EMPTY_PROXY };
  }
}

export async function saveProxy(config: ProxyConfig): Promise<void> {
  await safeStore.setItem(PROXY_KEY, JSON.stringify(config));
}

export async function clearProxy(): Promise<void> {
  await safeStore.deleteItem(PROXY_KEY);
}
