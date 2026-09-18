/**
 * 安全存储层（带自愈降级）
 *
 * 背景：需要一种不依赖 Keystore 的持久化手段，用于记录"Keystore 是否崩溃"，
 * 以及在 Keystore 不可用时接管键值存储。
 *
 * ⚠️ 关键教训：Metro 在**打包期**静态解析 require() 的字符串字面量。
 * try/catch 包住 require 完全没有用 —— 模块不存在会在 bundle 阶段直接失败，
 * 根本走不到运行时。所以这里**只 require 确定存在的 'expo-file-system'**，
 * API 差异一律在运行时用特性检测处理，绝不再 require 可能不存在的子路径。
 */

const MARKER_FILE = 'e2ee.keystore-probe';
const STORE_FILE = 'e2ee.kv.json';

/** 读写能力抽象：屏蔽新旧两代 FileSystem API 的差异 */
interface FsAdapter {
  read: (name: string) => Promise<string | null>;
  write: (name: string, text: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
}

const memory = new Map<string, string>();
let adapter: FsAdapter | null | undefined;

/**
 * 单一 require 入口 + 运行时特性检测
 *
 * 支持两代 API：
 *  - 旧版：writeAsStringAsync / readAsStringAsync / deleteAsync + documentDirectory
 *  - 新版：File 类（.write / .text / .delete）+ Directory.uri
 */
function buildAdapter(): FsAdapter | null {
  let mod: Record<string, unknown>;
  try {
    mod = require('expo-file-system') as Record<string, unknown>;
  } catch {
    return null;
  }

  const dir =
    (typeof mod.documentDirectory === 'string' ? mod.documentDirectory : null) ??
    // 新版用 Paths.document（Directory 对象）
    (() => {
      const paths = mod.Paths as { document?: { uri?: string } } | undefined;
      return paths?.document?.uri ?? null;
    })();

  if (!dir) return null;
  const base = dir.endsWith('/') ? dir : `${dir}/`;

  const legacy = mod as {
    writeAsStringAsync?: (uri: string, text: string) => Promise<void>;
    readAsStringAsync?: (uri: string) => Promise<string>;
    deleteAsync?: (uri: string, opts?: { idempotent?: boolean }) => Promise<void>;
  };
  const FileCtor = mod.File as
    | (new (uri: string) => {
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
    async read(name) {
      const uri = `${base}${name}`;
      try {
        if (hasLegacy) return await legacy.readAsStringAsync!(uri);
        return await new FileCtor!(uri).text();
      } catch {
        return null; // 文件不存在是正常情况
      }
    },
    async write(name, text) {
      const uri = `${base}${name}`;
      if (hasLegacy) {
        await legacy.writeAsStringAsync!(uri, text);
        return;
      }
      await new FileCtor!(uri).write(text);
    },
    async remove(name) {
      const uri = `${base}${name}`;
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

async function readFile(name: string): Promise<string | null> {
  const a = fs();
  if (!a) return memory.get(name) ?? null;
  return a.read(name);
}

async function writeFile(name: string, text: string): Promise<void> {
  const a = fs();
  if (!a) {
    memory.set(name, text);
    return;
  }
  await a.write(name, text);
}

async function deleteFile(name: string): Promise<void> {
  const a = fs();
  if (!a) {
    memory.delete(name);
    return;
  }
  await a.remove(name);
}

// ---------------------------------------------------------------------------
// 崩溃自愈：标记文件驱动
// ---------------------------------------------------------------------------

/** 上次启动是否在试探 Keystore 时崩溃（标记没被清除 = 崩了） */
export async function didKeystoreCrash(): Promise<boolean> {
  return (await readFile(MARKER_FILE)) !== null;
}

/** 调用 Keystore 之前写入；成功后再调用 markKeystoreOk 清除 */
export async function markKeystoreProbeStart(): Promise<void> {
  await writeFile(MARKER_FILE, new Date().toISOString());
}

export async function markKeystoreOk(): Promise<void> {
  await deleteFile(MARKER_FILE);
}

// ---------------------------------------------------------------------------
// 键值存储：Keystore 优先，不可用则退到文件
// ---------------------------------------------------------------------------

let keystoreUsable: boolean | null = null;

export async function isKeystoreUsable(): Promise<boolean> {
  if (keystoreUsable !== null) return keystoreUsable;
  keystoreUsable = !(await didKeystoreCrash());
  return keystoreUsable;
}

/** 供界面手动禁用（例如用户在已知坏环境里主动降级） */
export async function disableKeystore(): Promise<void> {
  keystoreUsable = false;
  await writeFile(MARKER_FILE, 'disabled-manually');
}

async function secureGet(key: string): Promise<string | null> {
  const S = require('expo-secure-store');
  return S.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  const S = require('expo-secure-store');
  await S.setItemAsync(key, value);
}

async function secureDelete(key: string): Promise<void> {
  const S = require('expo-secure-store');
  await S.deleteItemAsync(key);
}

async function fileGet(key: string): Promise<string | null> {
  const raw = await readFile(STORE_FILE);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as Record<string, string>)[key] ?? null;
  } catch {
    return null;
  }
}

async function fileSet(key: string, value: string): Promise<void> {
  const raw = await readFile(STORE_FILE);
  let bag: Record<string, string> = {};
  if (raw) {
    try {
      bag = JSON.parse(raw) as Record<string, string>;
    } catch {
      bag = {};
    }
  }
  bag[key] = value;
  await writeFile(STORE_FILE, JSON.stringify(bag));
}

async function fileDelete(key: string): Promise<void> {
  const raw = await readFile(STORE_FILE);
  if (!raw) return;
  try {
    const bag = JSON.parse(raw) as Record<string, string>;
    delete bag[key];
    await writeFile(STORE_FILE, JSON.stringify(bag));
  } catch {
    // 忽略
  }
}

export async function getItem(key: string): Promise<string | null> {
  if (await isKeystoreUsable()) {
    await markKeystoreProbeStart();
    const value = await secureGet(key);
    await markKeystoreOk(); // 走到这里说明没崩
    return value;
  }
  return fileGet(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (await isKeystoreUsable()) {
    await markKeystoreProbeStart();
    await secureSet(key, value);
    await markKeystoreOk();
    return;
  }
  await fileSet(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  if (await isKeystoreUsable()) {
    await markKeystoreProbeStart();
    await secureDelete(key);
    await markKeystoreOk();
    return;
  }
  await fileDelete(key);
}

/** 当前实际使用的后端，供界面提示安全级别 */
export async function currentBackend(): Promise<'keystore' | 'file' | 'memory'> {
  if (await isKeystoreUsable()) return 'keystore';
  return fs() ? 'file' : 'memory';
}
