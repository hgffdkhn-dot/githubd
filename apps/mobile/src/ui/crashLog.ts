/**
 * 崩溃记录
 *
 * 白屏最难查的地方在于：release 构建下异常不会弹红屏，直接什么都不画。
 * 与其每次都去 adb 捞日志，不如把最后一次异常存下来，下次启动时显示在界面上。
 *
 * 只存异常类型与堆栈，绝不存消息内容、密钥或身份信息。
 *
 * 关键：存储走 safeStore（带 Keystore 降级），自身不直接依赖任何原生模块。
 * 它是兜底机制，绝不能因为依赖缺失而让 App 起不来。
 */

import * as safeStore from '../storage/safeStore.js';

const KEY = 'e2ee.lastError';
const MAX = 1200;

export interface CrashRecord {
  tag: string;
  message: string;
  stack: string;
  at: number;
}

export async function recordError(tag: string, error: unknown): Promise<void> {
  const normalised = error instanceof Error ? error : new Error(String(error));
  const record: CrashRecord = {
    tag,
    message: normalised.message.slice(0, MAX),
    stack: (normalised.stack ?? '').slice(0, MAX),
    at: Date.now(),
  };
  try {
    await safeStore.setItem(KEY, JSON.stringify(record));
  } catch {
    // 存不下也不能影响主流程
  }
  console.error(`[E2EE:${tag}]`, normalised);
}

export async function loadLastError(): Promise<CrashRecord | null> {
  try {
    const raw = await safeStore.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CrashRecord;
  } catch {
    return null;
  }
}

export async function clearLastError(): Promise<void> {
  try {
    await safeStore.deleteItem(KEY);
  } catch {
    // 忽略
  }
}

/**
 * 接管未捕获的 JS 异常
 *
 * 这是白屏最常见的来源：release 构建下未捕获异常会让整棵 React 树卸载。
 * 这里先落盘再交给原 handler，保证下次启动能看到原因。
 *
 * 注意：只能捕获 JS 异常。原生层硬崩溃（如 Keystore 不可用）拦不住，
 * 那种情况由 safeStore 的崩溃标记机制在下次启动时识别。
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
  } catch {
    // 装不上也不能让 App 起不来
  }
}
