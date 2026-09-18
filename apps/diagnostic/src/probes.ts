/**
 * 探针定义
 *
 * 设计要点：
 *  1. 每个探针都实际调用一次，而不是只 require —— 模块能 import 不代表原生侧可用
 *  2. 捕获时保留**错误类型名**，这是区分"JS 异常"与"原生问题"的关键线索
 *  3. Keystore 相关模块拆成多档 accessible 档位分别测试，
 *     因为 THIS_DEVICE_ONLY 这类档位在部分设备上要求已设置锁屏凭证
 */

import { markStart, markDone } from './probeStore';

export interface ProbeDef {
  name: string;
  risky?: boolean;
  run: () => Promise<string>;
}

/** 统一格式化：把错误类型名带上，便于判断成因 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `[${error.name}] ${error.message}`;
  }
  return `[${typeof error}] ${String(error)}`;
}

export const PROBES: ProbeDef[] = [
  {
    name: 'react-native-paper',
    run: async () => {
      const m = require('react-native-paper');
      if (!m.Button) throw new Error('Button 不存在');
      return '组件可用（纯 JS，不依赖原生链接）';
    },
  },
  {
    name: 'Buffer / globalThis.crypto',
    run: async () => {
      if (typeof Buffer === 'undefined') throw new Error('Buffer 未定义');
      if (typeof globalThis.crypto?.getRandomValues !== 'function') {
        throw new Error('globalThis.crypto.getRandomValues 不存在');
      }
      globalThis.crypto.getRandomValues(new Uint8Array(8));
      return `Buffer 可用，${Buffer.from('ok').toString('base64')}`;
    },
  },
  {
    name: 'expo-file-system',
    run: async () => {
      const m = require('expo-file-system');
      if (!m.documentDirectory) throw new Error('documentDirectory 为空');
      const p = `${m.documentDirectory}diag.txt`;
      await m.writeAsStringAsync(p, 'ok');
      const back = await m.readAsStringAsync(p);
      await m.deleteAsync(p, { idempotent: true });
      if (back !== 'ok') throw new Error(`回读不一致：${back}`);
      return '文件读写正常';
    },
  },
  {
    name: 'react-native-screens',
    run: async () => {
      const m = require('react-native-screens');
      if (!m.enableScreens) throw new Error('enableScreens 不存在');
      return '原生屏幕可用';
    },
  },
  {
    name: 'react-native-vector-icons',
    run: async () => {
      const m = require('react-native-vector-icons');
      if (!m.MaterialCommunityIcons) throw new Error('MaterialCommunityIcons 不存在');
      return '图标集可用';
    },
  },
  {
    name: 'react-native-safe-area-context',
    run: async () => {
      const m = require('react-native-safe-area-context');
      if (!m.SafeAreaProvider) throw new Error('SafeAreaProvider 不存在');
      return '组件可用';
    },
  },
  {
    name: 'expo-sqlite',
    run: async () => {
      const m = require('expo-sqlite');
      const db = m.openDatabaseSync('diag.db');
      db.execSync('CREATE TABLE IF NOT EXISTS t (a INTEGER)');
      db.runSync('INSERT INTO t (a) VALUES (?)', [1]);
      const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      return `建表写入成功，行数=${row?.c}`;
    },
  },
  {
    name: 'react-native-quick-base64',
    run: async () => {
      const m = require('react-native-quick-base64');
      if (typeof m.fromByteArray !== 'function') throw new Error('fromByteArray 不存在');
      const b64 = m.fromByteArray(new Uint8Array([102, 111, 111]));
      if (b64 !== 'Zm9v') throw new Error(`编码结果异常：${b64}`);
      return '原生 base64 可用（quick-crypto 的必需配套模块）';
    },
  },
  {
    name: 'react-native-quick-crypto',
    run: async () => {
      const m = require('react-native-quick-crypto');
      if (typeof m.createCipheriv !== 'function') throw new Error('createCipheriv 不存在');
      const key = m.randomBytes(32);
      const nonce = m.randomBytes(12);
      const c = m.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      const ct = c.update(Buffer.from('hello'));
      c.final();
      const tag = c.getAuthTag();
      const d = m.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      d.setAuthTag(tag);
      const pt = Buffer.concat([d.update(ct), d.final()]).toString();
      if (pt !== 'hello') throw new Error(`往返失败：${pt}`);
      return 'AES-256-GCM 加解密往返通过';
    },
  },

  // ↓↓↓ 以下两档 expo-secure-store：区分"默认档可用"与"THIS_DEVICE_ONLY 档可用"
  {
    name: 'expo-secure-store（默认档）',
    risky: true,
    run: async () => {
      const m = require('expo-secure-store');
      await m.setItemAsync('diag.a', 'v');
      const back = await m.getItemAsync('diag.a');
      await m.deleteItemAsync('diag.a');
      if (back !== 'v') throw new Error(`回读不一致：${back}`);
      return '读写正常';
    },
  },
  {
    name: 'expo-secure-store（THIS_DEVICE_ONLY 档）',
    risky: true,
    run: async () => {
      const m = require('expo-secure-store');
      // 主工程原先用的就是这个档位；它在部分设备上要求已设置锁屏凭证
      await m.setItemAsync('diag.b', 'v', {
        keychainAccessible: m.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      const back = await m.getItemAsync('diag.b');
      await m.deleteItemAsync('diag.b');
      if (back !== 'v') throw new Error(`回读不一致：${back}`);
      return '读写正常';
    },
  },
  {
    name: 'react-native-keychain',
    risky: true,
    run: async () => {
      const m = require('react-native-keychain');
      const ok = await m.setGenericPassword('u', 'p', { service: 'diag' });
      if (!ok) throw new Error('setGenericPassword 返回 false');
      const back = await m.getGenericPassword({ service: 'diag' });
      if (!back) throw new Error('读回为空');
      await m.resetGenericPassword({ service: 'diag' });
      return '写入并读回成功';
    },
  },
];

/**
 * 执行单个探针（带崩溃标记）
 *
 * 调用前写标记、正常返回后清除。若发生原生硬崩溃，标记会留在磁盘上，
 * 下次启动据此判定"崩在这里"。
 */
export async function runProbe(index: number): Promise<string> {
  await markStart(index, PROBES[index].name);
  try {
    const detail = await PROBES[index].run();
    await markDone();
    return detail;
  } catch (error) {
    await markDone();
    throw error;
  }
}
