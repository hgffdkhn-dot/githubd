/**
 * 服务端地址配置
 *
 * 内置了线上服务器地址，用户无需手动填写 —— 装完即用。
 *
 * ⚠️ 换地址时改 DEFAULT_SERVER 这一处即可（例如日后换成 https 域名）。
 * 保留运行时覆盖能力是为了：万一地址变了又来不及重新打包，
 * 还能通过 setServerUrl 改，不至于整版 App 失联。
 */

import * as safeStore from '../storage/safeStore.js';

const KEY = 'e2ee.serverUrl';

/**
 * 默认服务器地址。
 *
 * 以后要换（比如上了域名、改成 HTTPS），只改这一行：
 *   export const DEFAULT_SERVER = 'https://你的域名';
 */
export const DEFAULT_SERVER = 'http://47.239.14.144:8787';

/** 构建时可用 EXPO_PUBLIC_API_URL 覆盖；不配就用上面的默认值 */
export const BUILTIN_SERVER = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_SERVER;

/**
 * 归一化地址：把"连不上"的几种地址一律换回默认服务器
 *
 * 为什么要这层：
 *  - `?? `只对 null/undefined 兜底，**空字符串不会**。若构建时
 *    EXPO_PUBLIC_API_URL 被设成空串，BUILTIN_SERVER 就成了空串。
 *  - 手机上 localhost/127.0.0.1 指手机自己，永远连不上服务端。
 *    清除应用数据后本地覆盖值没了，一旦兜底链上出现它，就会报
 *    "地址指向了本机" —— 这正是实际出现过的问题。
 *
 * 所以最终取值一律过这个函数，保证出口地址一定可用。
 */
export function normalizeServerUrl(raw: string | null | undefined): string {
  const candidate = (raw ?? '').trim();
  if (!candidate) return DEFAULT_SERVER;
  try {
    const url = new URL(candidate);
    const host = url.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      return DEFAULT_SERVER;
    }
    return candidate;
  } catch {
    // 地址格式坏了（比如只写了 IP 没写协议），直接回退
    return DEFAULT_SERVER;
  }
}

export async function getServerUrl(): Promise<string> {
  const saved = await safeStore.getItem(KEY);
  return normalizeServerUrl(saved && saved.trim() ? saved.trim() : BUILTIN_SERVER);
}

export async function setServerUrl(url: string): Promise<void> {
  // 存之前也归一化，避免把 localhost 这类无效地址写进本地
  await safeStore.setItem(KEY, normalizeServerUrl(url));
}

export async function resetServerUrl(): Promise<void> {
  await safeStore.deleteItem(KEY);
}

/**
 * 给用户的排查提示
 *
 * 用户看不到服务器后台，所以要说的是"他能做什么"，
 * 而不是"服务器怎么了"。
 */
export function describeNetworkFailure(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // 地址格式本身有问题，原样展示
  }

  if (host === 'localhost' || host === '127.0.0.1') {
    return '服务器地址指向了本机，请检查配置。';
  }

  return '暂时连不上服务器，可能是网络波动或服务器维护中，请稍后再试。';
}
