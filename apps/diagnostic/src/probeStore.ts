/**
 * 崩溃标记
 *
 * 原生模块的硬崩溃（SIGSEGV / abort）在 JS 层 catch 不到 —— try/catch 根本不会执行，
 * 进程直接没了，表现为"点下去瞬间白屏"。
 *
 * 对策：在调用每个探针**之前**把它的序号写进文件。
 *  - 探针正常返回 → 清除标记
 *  - 发生硬崩溃   → 标记留在磁盘上
 * 下次启动读到标记，就知道"上次崩在第 N 个探针"，把它标红。
 *
 * 存储用 expo-file-system（纯文件 IO，不依赖 Keystore），
 * 绝不能用 expo-secure-store 来记录"secure-store 是否崩溃"。
 */

const MARKER = 'diag.crash-marker.json';

interface FS {
  documentDirectory: string | null;
  writeAsStringAsync: (uri: string, text: string) => Promise<void>;
  readAsStringAsync: (uri: string) => Promise<string>;
  deleteAsync: (uri: string, opts?: { idempotent?: boolean }) => Promise<void>;
}

let cached: FS | null | undefined;

function fs(): FS | null {
  if (cached !== undefined) return cached;
  try {
    let mod: FS;
    try {
      mod = require('expo-file-system') as FS;
    } catch {
      mod = require('expo-file-system/legacy') as FS;
    }
    cached = typeof mod?.writeAsStringAsync === 'function' ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

// 文件系统也不可用时退化到内存，至少本次会话内有效
let memory: string | null = null;

function path(): string | null {
  const mod = fs();
  if (!mod?.documentDirectory) return null;
  return `${mod.documentDirectory}${MARKER}`;
}

export interface CrashMarker {
  probeIndex: number;
  probeName: string;
  at: number;
}

export async function markStart(index: number, name: string): Promise<void> {
  const payload = JSON.stringify({ probeIndex: index, probeName: name, at: Date.now() });
  const p = path();
  if (!p) {
    memory = payload;
    return;
  }
  await fs()!.writeAsStringAsync(p, payload);
}

export async function markDone(): Promise<void> {
  const p = path();
  if (!p) {
    memory = null;
    return;
  }
  try {
    await fs()!.deleteAsync(p, { idempotent: true });
  } catch {
    // 忽略
  }
}

export async function readCrash(): Promise<CrashMarker | null> {
  const p = path();
  if (!p) return memory ? (JSON.parse(memory) as CrashMarker) : null;
  try {
    const raw = await fs()!.readAsStringAsync(p);
    return JSON.parse(raw) as CrashMarker;
  } catch {
    return null;
  }
}

/** 记录 JS 层能捕获到的异常，与崩溃标记互补 */
export async function logError(tag: string, error: unknown): Promise<void> {
  const normalised = error instanceof Error ? error : new Error(String(error));
  console.error(`[diag:${tag}]`, normalised);
}
