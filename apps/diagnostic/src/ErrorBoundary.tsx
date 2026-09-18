/**
 * 错误边界
 *
 * 诊断工程自己绝不能白屏 —— 它是用来查白屏的工具。
 * 渲染期异常必须显示出来，否则又回到"什么都没留下"的状态。
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[diag] 渲染异常:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>界面渲染异常</Text>
        <ScrollView style={styles.scroll}>
          <Text style={styles.message}>
            {error.name}: {error.message}
          </Text>
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
  button: { backgroundColor: '#6750a4', borderRadius: 20, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
