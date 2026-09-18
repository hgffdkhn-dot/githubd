/**
 * 诊断工程（第三版）
 *
 * v1 教训：点"全部检测"到第一个探针就白屏，界面上什么都没留下 ——
 *         原生硬崩溃 JS catch 不到，进程直接没了。
 * v2 改进：崩溃标记（调用前写文件、回来清除），下次启动指出崩在哪个探针。
 * v3 改进：secure-store 按 accessible 档位**拆开测**，并保留错误类型名。
 *         因为 THIS_DEVICE_ONLY 这类档位在部分设备上要求已设置锁屏凭证，
 *         它与"Keystore 硬件不可用"是两回事，必须分开判断。
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { readCrash, type CrashMarker } from './src/probeStore';
import { PROBES, runProbe, describeError } from './src/probes';
import { ErrorBoundary } from './src/ErrorBoundary';

type Status = 'idle' | 'running' | 'ok' | 'fail' | 'crashed';

interface ProbeState {
  name: string;
  status: Status;
  detail: string;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Diagnostics />
    </ErrorBoundary>
  );
}

function Diagnostics() {
  const [probes, setProbes] = useState<ProbeState[]>(
    PROBES.map((p) => ({ name: p.name, status: 'idle', detail: '' })),
  );
  const [crash, setCrash] = useState<CrashMarker | null>(null);
  const [running, setRunning] = useState(-1);

  useEffect(() => {
    readCrash().then((marker) => {
      if (!marker) return;
      setCrash(marker);
      setProbes((prev) => {
        const next = [...prev];
        if (next[marker.probeIndex]) {
          next[marker.probeIndex] = {
            ...next[marker.probeIndex],
            status: 'crashed',
            detail: '上次启动调用它时进程消失（原生层硬崩溃，JS 无法捕获）',
          };
        }
        return next;
      });
    });
  }, []);

  async function runOne(index: number) {
    setRunning(index);
    setProbes((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'running', detail: '' };
      return next;
    });

    try {
      const detail = await runProbe(index);
      setProbes((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'ok', detail };
        return next;
      });
    } catch (error) {
      setProbes((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'fail', detail: describeError(error) };
        return next;
      });
    } finally {
      setRunning(-1);
    }
  }

  async function runAll() {
    for (let i = 0; i < PROBES.length; i++) await runOne(i);
  }

  const crashed = probes.filter((p) => p.status === 'crashed').length;
  const failed = probes.filter((p) => p.status === 'fail');

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>E2EE 诊断工程</Text>
        <Text style={styles.lead}>
          能看到这行字，说明 JS bundle 已内置、React 树正常挂载，构建链路没问题。
        </Text>

        {crash ? (
          <View style={styles.crashBanner}>
            <Text style={styles.crashTitle}>上次崩溃于：{crash.probeName}</Text>
            <Text style={styles.crashText}>
              进程直接消失，属于原生层硬崩溃，JS 的 try/catch 拦不住。
            </Text>
          </View>
        ) : null}

        {failed.length > 0 ? (
          <View style={styles.failBanner}>
            <Text style={styles.failTitle}>
              {failed.length} 项报错（JS 层捕获到的异常，非崩溃）
            </Text>
            {failed.map((f) => (
              <Text key={f.name} style={styles.failLine}>
                • {f.name}：{f.detail}
              </Text>
            ))}
          </View>
        ) : null}

        <Pressable style={styles.button} onPress={runAll} disabled={running >= 0}>
          <Text style={styles.buttonText}>{running >= 0 ? '检测中…' : '全部检测'}</Text>
        </Pressable>

        {probes.map((p, i) => (
          <View key={p.name} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.rowName}>
                {p.name}
                {PROBES[i].risky ? ' ⚠' : ''}
              </Text>
              <Pressable style={styles.runBtn} onPress={() => runOne(i)} disabled={running >= 0}>
                <Text style={styles.runBtnText}>{running === i ? '…' : '单独运行'}</Text>
              </Pressable>
              <Text style={[styles.badge, styles[`badge_${p.status}`]]}>
                {p.status === 'idle' && '未测'}
                {p.status === 'running' && '…'}
                {p.status === 'ok' && '正常'}
                {p.status === 'fail' && '报错'}
                {p.status === 'crashed' && '崩溃'}
              </Text>
            </View>
            {p.detail ? <Text style={styles.detail}>{p.detail}</Text> : null}
          </View>
        ))}

        <Text style={styles.footnote}>
          ⚠ 标记的两个模块基于 Android Keystore。建议**逐个单独运行**：
          若显示"报错"，说明是 JS 可捕获的异常，信息在上面；
          若进程直接消失，重启后这里会显示"崩溃"。
          两者成因完全不同，请务必区分。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, gap: 10 },
  title: { fontSize: 22, fontWeight: '700' },
  lead: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 4 },
  crashBanner: {
    backgroundColor: '#ffebee',
    borderLeftWidth: 4,
    borderLeftColor: '#c62828',
    padding: 12,
    borderRadius: 8,
  },
  crashTitle: { fontSize: 15, fontWeight: '700', color: '#c62828' },
  crashText: { fontSize: 12, color: '#5f2120', lineHeight: 18, marginTop: 4 },
  failBanner: { backgroundColor: '#fff3e0', padding: 12, borderRadius: 8 },
  failTitle: { fontSize: 14, fontWeight: '700', color: '#e65100' },
  failLine: { fontSize: 11, color: '#5d4037', fontFamily: 'monospace', marginTop: 4, lineHeight: 16 },
  button: { backgroundColor: '#6750a4', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  row: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 12 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { fontSize: 12, fontFamily: 'monospace', flex: 1 },
  runBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#eee' },
  runBtnText: { fontSize: 11, color: '#333' },
  badge: { fontSize: 11, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  badge_idle: { backgroundColor: '#eee', color: '#666' },
  badge_running: { backgroundColor: '#e3f2fd', color: '#1565c0' },
  badge_ok: { backgroundColor: '#e8f5e9', color: '#2e7d32' },
  badge_fail: { backgroundColor: '#fff3e0', color: '#e65100' },
  badge_crashed: { backgroundColor: '#ffebee', color: '#c62828' },
  detail: { fontSize: 11, color: '#666', fontFamily: 'monospace', marginTop: 6, lineHeight: 16 },
  footnote: { fontSize: 11, color: '#888', lineHeight: 17, marginTop: 8 },
});
