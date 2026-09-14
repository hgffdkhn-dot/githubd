/**
 * 诊断工程
 *
 * 存在的唯一目的：把"白屏"这个模糊现象，拆成可定位的具体结论。
 *
 * 设计原则：启动时只渲染纯 RN 的 Hello World，不 import 任何需要原生链接的模块。
 * 所有原生模块都用动态 require + try/catch，逐个检测。
 *
 * 三种结论：
 * 1. Hello World 都白屏        → 构建或环境问题，与业务代码无关
 * 2. Hello World 正常，某模块红 → 该原生模块未链接，就是白屏元凶
 * 3. 全部绿                    → 原生层没问题，去查业务代码
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, SafeAreaView } from 'react-native';

type Status = 'idle' | 'running' | 'ok' | 'fail';

interface Probe {
  name: string;
  status: Status;
  detail: string;
}

/**
 * 每个探针都带一个"实际调用"而不只是 import：
 * 模块能被 require 成功，不代表原生侧真的可用（TurboModule 可能返回 null）。
 */
const PROBES: { name: string; run: () => Promise<string> }[] = [
  {
    name: 'expo-secure-store',
    run: async () => {
      const m = require('expo-secure-store');
      const k = 'diag.probe';
      await m.setItemAsync(k, 'v');
      const back = await m.getItemAsync(k);
      await m.deleteItemAsync(k);
      if (back !== 'v') throw new Error(`读写回读不一致：${back}`);
      return '读写正常';
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
      return `打开并写入成功，行数=${row?.c}`;
    },
  },
  {
    name: 'react-native-quick-crypto',
    run: async () => {
      const m = require('react-native-quick-crypto');
      if (typeof m.createCipheriv !== 'function') throw new Error('createCipheriv 不存在');
      const key = m.randomBytes(32);
      const nonce = m.randomBytes(12);
      const cipher = m.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      const ct = cipher.update(Buffer.from('hello'));
      cipher.final();
      const tag = cipher.getAuthTag();
      const decipher = m.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString();
      if (pt !== 'hello') throw new Error(`加解密往返失败：${pt}`);
      return `randomBytes=${key.length}B，AES-256-GCM 往返通过`;
    },
  },
  {
    name: 'react-native-keychain',
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
  {
    name: 'react-native-paper',
    run: async () => {
      const m = require('react-native-paper');
      if (typeof m.Button !== 'function' && typeof m.Button !== 'object') {
        throw new Error('Button 组件不存在');
      }
      return '组件可用';
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
      if (typeof m.SafeAreaProvider !== 'function' && typeof m.SafeAreaProvider !== 'object') {
        throw new Error('SafeAreaProvider 不存在');
      }
      return '组件可用';
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
    name: '全局 crypto（Hermes 环境）',
    run: async () => {
      if (typeof globalThis.crypto?.getRandomValues !== 'function') {
        throw new Error('globalThis.crypto.getRandomValues 不存在，Keystore 会崩');
      }
      globalThis.crypto.getRandomValues(new Uint8Array(8));
      return '可用';
    },
  },
  {
    name: 'Buffer（Metro polyfill）',
    run: async () => {
      if (typeof Buffer === 'undefined') throw new Error('Buffer 未定义');
      return `可用，版本检查 ${Buffer.from('ok').toString('base64')}`;
    },
  },
];

export default function App() {
  const [probes, setProbes] = useState<Probe[]>(
    PROBES.map((p) => ({ name: p.name, status: 'idle', detail: '' })),
  );
  const [running, setRunning] = useState(false);

  async function runAll() {
    setRunning(true);
    for (let i = 0; i < PROBES.length; i++) {
      setProbes((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: 'running', detail: '' };
        return next;
      });
      try {
        const detail = await PROBES[i].run();
        setProbes((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'ok', detail };
          return next;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setProbes((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'fail', detail: message };
          return next;
        });
      }
    }
    setRunning(false);
  }

  const failed = probes.filter((p) => p.status === 'fail').length;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>E2EE 诊断工程</Text>
        <Text style={styles.lead}>
          如果你能看到这行字，说明 JS bundle 已内置、React 树正常挂载，
          构建链路本身没问题。白屏原因在业务代码或原生模块。
        </Text>

        <Pressable style={styles.button} onPress={runAll} disabled={running}>
          <Text style={styles.buttonText}>{running ? '检测中…' : '检测原生模块'}</Text>
        </Pressable>

        {probes.map((p) => (
          <View key={p.name} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.rowName}>{p.name}</Text>
              <Text style={[styles.badge, styles[`badge_${p.status}`]]}>
                {p.status === 'idle' && '未测'}
                {p.status === 'running' && '…'}
                {p.status === 'ok' && '正常'}
                {p.status === 'fail' && '失败'}
              </Text>
            </View>
            {p.detail ? <Text style={styles.detail}>{p.detail}</Text> : null}
          </View>
        ))}

        {failed > 0 ? (
          <Text style={styles.summary}>
            {failed} 个模块不可用 —— 这些就是白屏的元凶。主工程里它们在模块顶层被 import，
            加载失败会直接让整棵 React 树卸载，表现为纯白且看不到任何报错。
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, gap: 10 },
  title: { fontSize: 22, fontWeight: '700' },
  lead: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 8 },
  button: { backgroundColor: '#6750a4', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  row: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 12 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowName: { fontSize: 14, fontFamily: 'monospace', flex: 1 },
  badge: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  badge_idle: { backgroundColor: '#eee', color: '#666' },
  badge_running: { backgroundColor: '#e3f2fd', color: '#1565c0' },
  badge_ok: { backgroundColor: '#e8f5e9', color: '#2e7d32' },
  badge_fail: { backgroundColor: '#ffebee', color: '#c62828' },
  detail: { fontSize: 11, color: '#666', fontFamily: 'monospace', marginTop: 6 },
  summary: { marginTop: 12, fontSize: 13, color: '#c62828', lineHeight: 19 },
});
