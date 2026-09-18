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
 * ⚠️ Metro 在打包期静态解析 require() 字面量，try/catch 挡不住"模块不存在"。
 * 所以只 require 确定存在的 'expo-file-system'，API 差异运行时特性检测。
 * 绝不能用 expo-secure-store 来记录"secure-store 是否崩溃"。
 */

const MARKER = 'diag.crash-marker.json';

interface FsAdapter {
  read: () => Promise<string | null>;
  write: (text: string) => Promise<void>;
  remove: () => Promise<void>;
}

let adapter: FsAdapter | null | undefined;
// 文件系统不可用时退到内存，至少本次会话内有效
let memory: string | null = null;

function buildAdapter(): FsAdapter | null {
  let mod: Record<string, unknown>;
  try {
    mod = require('expo-file-system') as Record<string, unknown>;
  } catch {
    return null;
  }

  const dir =
    (typeof mod.documentDirectory === 'string' ? mod.documentDirectory : null) ??
    (() => {
      const paths = mod.Paths as { document?: { uri?: string } } | undefined;
      return paths?.document?.uri ?? null;
    })();

  if (!dir) return null;
  const uri = dir.endsWith('/') ? `${dir}${MARKER}` : `${dir}/${MARKER}`;

  const legacy = mod as {
    writeAsStringAsync?: (u: string, t: string) => Promise<void>;
    readAsStringAsync?: (u: string) => Promise<string>;
    deleteAsync?: (u: string, o?: { idempotent?: boolean }) => Promise<void>;
  };
  const FileCtor = mod.File as
    | (new (u: string) => {
        write: (t: string) => Promise<void>;
        text: () => Promise<string>;
        delete: () => Promise<void>;
      })
    | undefined;

  const hasLegacy =
    typeof legacy.writeAsStringAsync === 'function' && typeof legacy.readAsStringAsync === 'function';
  const hasNew = typeof FileCtor === 'function';
  if (!hasLegacy && !hasNew) return null;

  return {
    async read() {
      try {
        if (hasLegacy) return await legacy.readAsStringAsync!(uri);
        return await new FileCtor!(uri).text();
      } catch {
        return null;
      }
    },
    async write(text) {
      if (hasLegacy) {
        await legacy.writeAsStringAsync!(uri, text);
        return;
      }
      await new FileCtor!(uri).write(text);
    },
    async remove() {
      try {
        if (hasLegacy) {
          await legacy.deleteAsync!(uri, { idempotent: true });
          return;
        }
        await new FileCtor!(uri).delete();
      } catch {
        // 忽略
      }
    },
  };
}

function fs(): FsAdapter | null {
  if (adapter === undefined) adapter = buildAdapter();
  return adapter;
}

export interface CrashMarker {
  probeIndex: number;
  probeName: string;
  at: number;
}

export async function markStart(index: number, name: string): Promise<void> {
  const payload = JSON.stringify({ probeIndex: index, probeName: name, at: Date.now() });
  const a = fs();
  if (!a) {
    memory = payload;
    return;
  }
  await a.write(payload);
}

export async function markDone(): Promise<void> {
  const a = fs();
  if (!a) {
    memory = null;
    return;
  }
  await a.remove();
}

export async function readCrash(): Promise<CrashMarker | null> {
  const a = fs();
  const raw = a ? await a.read() : memory;
  if (!raw) return null;
  try {
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
