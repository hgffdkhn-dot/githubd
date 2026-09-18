/**
 * 服务端地址配置
 *
 * EXPO_PUBLIC_API_URL 在**构建时**被烘焙进 bundle，改一次就要重新打包一次，
 * 对调试极不友好。而且若构建时没配置，默认值是 localhost ——
 * 在手机上 localhost 指手机自己，永远连不上，表现为 "Network request failed"。
 *
 * 所以这里支持运行时覆盖：优先读本地保存的地址，没有才用构建时烘焙的默认值。
 */

import * as safeStore from '../storage/safeStore.js';

const KEY = 'e2ee.serverUrl';

/** 构建时注入的兜底地址 */
export const BUILTIN_SERVER = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

export async function getServerUrl(): Promise<string> {
  const saved = await safeStore.getItem(KEY);
  return saved && saved.trim() ? saved.trim() : BUILTIN_SERVER;
}

export async function setServerUrl(url: string): Promise<void> {
  await safeStore.setItem(KEY, url.trim());
}

export async function resetServerUrl(): Promise<void> {
  await safeStore.deleteItem(KEY);
}

/** 给用户的排查提示：把最常见的坑直接说出来 */
export function describeNetworkFailure(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // 地址格式本身有问题，原样展示
  }
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  const hint = isLoopback
    ? '注意：手机上的 localhost 指手机自己，必须填运行服务端的那台电脑的局域网 IP'
    : '请确认服务端正在运行、手机与电脑在同一 Wi-Fi、防火墙已放行该端口';

  return `无法连接服务器 ${baseUrl}。${hint}。`;
}
