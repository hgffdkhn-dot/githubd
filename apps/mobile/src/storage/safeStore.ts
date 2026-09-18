/**
 * 安全存储层（带自愈降级）
 *
 * 背景：某些运行环境（虚拟沙箱/双开容器、ROOT + Hook 环境、定制 ROM）里
 * Android Keystore 不可用或残缺。expo-secure-store 与 react-native-keychain
 * 都基于 Keystore，一旦调用会发生**原生层硬崩溃**——
 * JS 的 try/catch 拦不住，表现就是"点下去直接白屏"。
 *
 * 对策：崩溃自愈（crash-marker 驱动）
 *   1. 首次使用 Keystore 前，先用文件写一个"正在试探"标记
 *   2. 试探成功 → 清除标记，正常用 Keystore
 *   3. 若发生硬崩溃 → 标记留在磁盘上没被清除
 *   4. 下次启动看到标记 → 判定 Keystore 不安全，**永久绕开**，改用文件存储
 *
 * 这样即使无法捕获崩溃，也能在第二次启动后自动恢复可用。
 */

const MARKER_FILE = 'e2ee.keystore-probe';
const STORE_FILE = 'e2ee.kv.json';

interface FileSystemModule {
  documentDirectory: string | null;
  writeAsStringAsync: (uri: string, text: string) => Promise<void>;
  readAsStringAsync: (uri: string) => Promise<string>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

// 动态 require：这是兜底层，自己绝不能在加载期抛错
function fileSystem(): FileSystemModule | null {
  try {
    // SDK 52 仍导出旧版 API；若被移除则尝试 legacy 入口
    let mod: FileSystemModule | null = null;
    try {
      mod = require('expo-file-system') as FileSystemModule;
    } catch {
      mod = require('expo-file-system/legacy') as FileSystemModule;
    }
    if (!mod || typeof mod.writeAsStringAsync !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

/** 文件系统不可用时的最后退路：只活在内存里，重启即丢，但保证 App 不崩 */
const memoryStore = new Map<string, string>();
let memoryMarker: string | null = null;

function docPath(name: string): string | null {
  const fs = fileSystem();
  if (!fs?.documentDirectory) return null;
  return `${fs.documentDirectory}${name}`;
}

async function readFile(name: string): Promise<string | null> {
  const path = docPath(name);
  if (!path) return name === MARKER_FILE ? memoryMarker : (memoryStore.get(name) ?? null);
  try {
    return await fileSystem()!.readAsStringAsync(path);
  } catch {
    return null;
  }
}

async function writeFile(name: string, text: string): Promise<void> {
  const path = docPath(name);
  if (!path) {
    if (name === MARKER_FILE) memoryMarker = text;
    else memoryStore.set(name, text);
    return;
  }
  await fileSystem()!.writeAsStringAsync(path, text);
}

async function deleteFile(name: string): Promise<void> {
  const path = docPath(name);
  if (!path) {
    if (name === MARKER_FILE) memoryMarker = null;
    else memoryStore.delete(name);
    return;
  }
  try {
    await fileSystem()!.deleteAsync(path, { idempotent: true });
  } catch {
    // 忽略
  }
}

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

/** 供设置界面手动禁用（例如用户在已知坏环境里主动降级） */
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

/** 当前实际使用的后端，供界面提示用户安全级别 */
export async function currentBackend(): Promise<'keystore' | 'file' | 'memory'> {
  if (await isKeystoreUsable()) return 'keystore';
  return docPath(STORE_FILE) ? 'file' : 'memory';
}
