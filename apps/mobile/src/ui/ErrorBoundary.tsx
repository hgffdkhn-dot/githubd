/**
 * 错误边界
 *
 * 没有它，初始化阶段的任何异常（例如 quick-crypto 注入失败、SQLite 打不开）
 * 都会让整棵组件树卸载，表现为"打开后一片纯白"，看不出任何原因。
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { recordError } from './crashLog.js';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 落盘，保证下次启动能看到；生产环境可换成脱敏后的上报通道
    void recordError('render', error);
    console.error('[E2EE] 界面崩溃:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>应用启动失败</Text>
        <ScrollView style={styles.scroll}>
          <Text style={styles.message}>{error.message}</Text>
          <Text style={styles.stack}>{error.stack ?? ''}</Text>
        </ScrollView>
        <Pressable style={styles.button} onPress={this.reset}>
          <Text style={styles.buttonText}>重试</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '700', color: '#b3261e' },
  scroll: { flex: 1, backgroundColor: '#f7f2f4', borderRadius: 8, padding: 12 },
  message: { fontSize: 14, color: '#410002', marginBottom: 8 },
  stack: { fontSize: 11, color: '#666', fontFamily: 'monospace' },
  button: {
    backgroundColor: '#6750a4',
    borderRadius: 20,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
