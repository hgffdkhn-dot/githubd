/**
 * 代理原生模块的 JS 入口
 *
 * 设计原则：**原生模块不可用时不许崩**。
 * 所以用 try/catch 包住 require，并对每个调用做降级。
 * 一旦原生侧没链接上（比如构建时移除了模块），
 * UI 会走到"当前环境不支持代理"的提示，而不是白屏。
 */

type ProxyModuleType = {
  applyProxy(protocol: string, host: string, port: number): boolean;
  clearProxy(): boolean;
  currentProxy(): { type: string; host: string; port: number } | null;
};

let nativeModule: ProxyModuleType | null = null;
let loadAttempted = false;

function getModule(): ProxyModuleType | null {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeModule } = require('expo') as {
      requireNativeModule?: (name: string) => ProxyModuleType;
    };
    if (typeof requireNativeModule !== 'function') return null;
    nativeModule = requireNativeModule('E2eeProxy');
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

/** 原生代理模块是否可用（不可用时 UI 要明确告知，不要假装能用） */
export function isProxySupported(): boolean {
  return getModule() !== null;
}

export interface ApplyResult {
  applied: boolean;
  /** 失败或降级的原因，供 UI 直接展示 */
  reason?: string;
}

export function applyProxy(protocol: string, host: string, port: number): ApplyResult {
  const mod = getModule();
  if (!mod) {
    return { applied: false, reason: '当前构建未包含代理原生模块' };
  }
  try {
    const ok = mod.applyProxy(protocol, host, port);
    return ok
      ? { applied: true }
      : { applied: false, reason: '代理参数被原生层拒绝，请检查地址与端口' };
  } catch (e) {
    return { applied: false, reason: (e as Error).message || '应用代理失败' };
  }
}

export function clearProxy(): ApplyResult {
  const mod = getModule();
  if (!mod) return { applied: false, reason: '当前构建未包含代理原生模块' };
  try {
    mod.clearProxy();
    return { applied: true };
  } catch (e) {
    return { applied: false, reason: (e as Error).message || '清除代理失败' };
  }
}

export function currentProxy(): { type: string; host: string; port: number } | null {
  const mod = getModule();
  if (!mod) return null;
  try {
    return mod.currentProxy();
  } catch {
    return null;
  }
}
