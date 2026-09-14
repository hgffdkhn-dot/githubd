/**
 * 崩溃记录
 *
 * 白屏最难查的地方在于：release 构建下异常不会弹红屏，直接什么都不画。
 * 与其每次都去 adb 捞日志，不如把最后一次异常存在本地，下次启动时显示在界面上。
 *
 * 只存异常类型与堆栈，绝不存消息内容、密钥或身份信息。
 */

import * as SecureStore from 'expo-secure-store';

const KEY = 'e2ee.lastError';
// Android Keystore 对单条记录有大小限制，超了会静默失败
const MAX = 1200;

export interface CrashRecord {
  tag: string;
  message: string;
  stack: string;
  at: number;
}

let cached: CrashRecord | null = null;

export async function recordError(tag: string, error: unknown): Promise<void> {
  const normalised = error instanceof Error ? error : new Error(String(error));
  const record: CrashRecord = {
    tag,
    message: normalised.message.slice(0, MAX),
    stack: (normalised.stack ?? '').slice(0, MAX),
    at: Date.now(),
  };
  cached = record;
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(record));
  } catch {
    // 存不下也不能影响主流程
  }
  console.error(`[E2EE:${tag}]`, normalised);
}

export async function loadLastError(): Promise<CrashRecord | null> {
  if (cached) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    cached = JSON.parse(raw) as CrashRecord;
    return cached;
  } catch {
    return null;
  }
}

export async function clearLastError(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // 忽略
  }
}

/**
 * 接管未捕获的 JS 异常
 *
 * 这是白屏最常见的来源：release 构建下未捕获异常会让整棵 React 树卸载。
 * 这里先落盘再交给原 handler，保证下次启动能看到原因。
 */
export function installGlobalHandlers(): void {
  try {
    const utils = (
      globalThis as unknown as {
        ErrorUtils?: {
          getGlobalHandler?: () => ((e: unknown, f?: boolean) => void) | undefined;
          setGlobalHandler?: (h: (e: unknown, f?: boolean) => void) => void;
        };
      }
    ).ErrorUtils;

    if (!utils?.setGlobalHandler) return;
    const previous = utils.getGlobalHandler?.();
    utils.setGlobalHandler((error, isFatal) => {
      void recordError(isFatal ? 'fatal' : 'js', error);
      previous?.(error, isFatal);
    });
  } catch (error) {
    console.error('[E2EE] 安装全局异常处理失败:', error);
  }
}
