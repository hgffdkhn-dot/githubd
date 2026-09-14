/**
 * 崩溃记录
 *
 * 白屏最难查的地方在于：release 构建下异常不会弹红屏，直接什么都不画。
 * 与其每次都去 adb 捞日志，不如把最后一次异常存下来，下次启动时显示在界面上。
 *
 * 只存异常类型与堆栈，绝不存消息内容、密钥或身份信息。
 *
 * 关键设计：依赖一律延迟 require。
 * 这个模块是"兜底机制"本身——如果它在 bundle 加载阶段就因为原生模块缺失而抛错，
 * 整个 App 会白屏且什么都看不到，兜底反而成了帮凶。
 */

type SecureStoreModule = typeof import('expo-secure-store');

const KEY = 'e2ee.lastError';
const MAX = 1200;

let secureStore: SecureStoreModule | null | undefined;

/** 延迟获取，失败返回 null 而不是抛错 */
function store(): SecureStoreModule | null {
  if (secureStore !== undefined) return secureStore;
  try {
    secureStore = require('expo-secure-store') as SecureStoreModule;
  } catch {
    secureStore = null;
  }
  return secureStore;
}

export interface CrashRecord {
  tag: string;
  message: string;
  stack: string;
  at: number;
}

// SecureStore 不可用时退化成内存记录：本次会话内仍能看到原因
let memory: CrashRecord | null = null;

export async function recordError(tag: string, error: unknown): Promise<void> {
  const normalised = error instanceof Error ? error : new Error(String(error));
  const record: CrashRecord = {
    tag,
    message: normalised.message.slice(0, MAX),
    stack: (normalised.stack ?? '').slice(0, MAX),
    at: Date.now(),
  };
  memory = record;

  const s = store();
  if (!s) {
    console.error(`[E2EE:${tag}]（仅内存）`, normalised);
    return;
  }
  try {
    await s.setItemAsync(KEY, JSON.stringify(record));
  } catch {
    // 存不下也不能影响主流程
  }
  console.error(`[E2EE:${tag}]`, normalised);
}

export async function loadLastError(): Promise<CrashRecord | null> {
  const s = store();
  if (!s) return memory;
  try {
    const raw = await s.getItemAsync(KEY);
    if (!raw) return memory;
    return JSON.parse(raw) as CrashRecord;
  } catch {
    return memory;
  }
}

export async function clearLastError(): Promise<void> {
  memory = null;
  const s = store();
  if (!s) return;
  try {
    await s.deleteItemAsync(KEY);
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
  } catch {
    // 装不上也不能让 App 起不来
  }
}
