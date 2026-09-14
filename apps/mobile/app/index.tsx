import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useChat } from '../src/chat/ChatProvider.js';

export default function LoginScreen() {
  const { register, login, status, error } = useChat();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (status === 'ready') router.replace('/contacts');
  }, [status, router]);

  async function run(action: 'login' | 'register') {
    setBusy(true);
    try {
      if (action === 'login') await login(username, password);
      else await register(username, password);
      router.replace('/contacts');
    } catch {
      // 错误已通过 context 暴露在界面上
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>端到端加密聊天</Text>
      <Text style={styles.subtitle}>服务端永远看不到你的消息内容</Text>

      <TextInput
        style={styles.input}
        placeholder="用户名"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="登录口令"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {busy ? <ActivityIndicator /> : null}

      <Button title="登录" onPress={() => run('login')} disabled={busy || !username || !password} />
      <View style={styles.spacer} />
      <Button title="注册新账号" onPress={() => run('register')} disabled={busy || !username || !password} />

      <Text style={styles.note}>
        身份密钥在本机生成并保存在系统密钥库，不会上传。重装应用将无法恢复历史会话。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 14, textAlign: 'center', color: '#666', marginBottom: 16 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  error: { color: '#c0392b', fontSize: 13 },
  spacer: { height: 8 },
  note: { marginTop: 24, fontSize: 12, color: '#888', lineHeight: 18 },
});
