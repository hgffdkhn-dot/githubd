import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Text, TextInput, Button, Surface, IconButton, useTheme } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../src/chat/ChatProvider.js';
import { loadLastError, clearLastError, type CrashRecord } from '../src/ui/crashLog.js';

export default function LoginScreen() {
  const { register, login, status, error } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [secure, setSecure] = useState(true);
  const [crash, setCrash] = useState<CrashRecord | null>(null);
  const [showCrash, setShowCrash] = useState(false);

  // 上次崩溃的原因直接显示在界面上，省去连电脑捞日志
  React.useEffect(() => {
    loadLastError().then(setCrash);
  }, []);

  React.useEffect(() => {
    if (status === 'ready') router.replace('/contacts');
  }, [status, router]);

  async function submit() {
    setBusy(true);
    try {
      if (mode === 'login') await login(username, password);
      else await register(username, password);
      router.replace('/contacts');
    } catch {
      // 错误已通过 context 暴露在界面上
    } finally {
      setBusy(false);
    }
  }

  const broken = status === 'broken';

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Surface style={styles.hero} elevation={1}>
          <Text variant="headlineMedium" style={styles.title}>
            端到端加密聊天
          </Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            服务端只经手密文，永远看不到你的消息内容
          </Text>
        </Surface>

        {broken ? (
          <Surface style={[styles.card, styles.errorCard]} elevation={1}>
            <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
              {error ?? '本地加密环境不可用，无法使用'}
            </Text>
          </Surface>
        ) : null}

        <Surface style={styles.card} elevation={1}>
          <TextInput
            label="用户名"
            mode="outlined"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoComplete="username"
            disabled={busy || broken}
            left={<TextInput.Icon icon="account" />}
            style={styles.input}
          />

          <TextInput
            label="登录口令"
            mode="outlined"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={secure}
            autoComplete={mode === 'register' ? 'new-password' : 'password'}
            disabled={busy || broken}
            left={<TextInput.Icon icon="lock" />}
            right={
              <TextInput.Icon
                icon={secure ? 'eye' : 'eye-off'}
                onPress={() => setSecure((v) => !v)}
              />
            }
            style={styles.input}
          />

          {error && !broken ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error, marginBottom: 8 }}>
              {error}
            </Text>
          ) : null}

          <Button
            mode="contained"
            onPress={submit}
            loading={busy}
            disabled={busy || broken || !username || !password}
            style={styles.button}
          >
            {mode === 'login' ? '登录' : '注册'}
          </Button>

          <Button
            mode="text"
            onPress={() => setMode((m) => (m === 'login' ? 'register' : 'login'))}
            disabled={busy || broken}
          >
            {mode === 'login' ? '还没有账号？注册' : '已有账号？登录'}
          </Button>
        </Surface>

        {crash ? (
          <Surface style={styles.card} elevation={1}>
            <Text variant="titleSmall" style={{ color: theme.colors.error }}>
              上次启动异常（{crash.tag}）
            </Text>
            <Text variant="bodySmall" style={styles.crashMeta}>
              {new Date(crash.at).toLocaleString()}
            </Text>
            {showCrash ? (
              <ScrollView style={styles.crashBox}>
                {/* selectable：长按即可选中复制，免去连电脑捞日志 */}
                <Text variant="bodySmall" style={styles.crashText} selectable>
                  {crash.message}
                  {'\n\n'}
                  {crash.stack}
                </Text>
              </ScrollView>
            ) : null}
            <Button mode="text" compact onPress={() => setShowCrash((v) => !v)}>
              {showCrash ? '收起详情' : '查看详情'}
            </Button>
            <Button
              mode="text"
              compact
              onPress={() => {
                void clearLastError();
                setCrash(null);
              }}
            >
              清除记录
            </Button>
          </Surface>
        ) : null}

        <View style={styles.noteRow}>
          <IconButton icon="shield-key" size={18} iconColor={theme.colors.outline} />
          <Text variant="bodySmall" style={styles.note}>
            身份密钥在本机生成并保存在系统密钥库，不会上传。重装应用将无法恢复历史会话。
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 16, justifyContent: 'center', flexGrow: 1 },
  hero: { padding: 20, borderRadius: 16, alignItems: 'center' },
  title: { fontWeight: '700', textAlign: 'center' },
  subtitle: { textAlign: 'center', marginTop: 8, opacity: 0.75 },
  card: { padding: 16, borderRadius: 16 },
  errorCard: { borderLeftWidth: 4, borderLeftColor: '#b3261e' },
  input: { marginBottom: 12 },
  button: { marginTop: 4, marginBottom: 4 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8 },
  note: { flex: 1, opacity: 0.7, lineHeight: 18, paddingTop: 8 },
  crashMeta: { opacity: 0.6, marginTop: 2 },
  crashBox: { maxHeight: 320, marginTop: 8, backgroundColor: '#f2f2f2', borderRadius: 8, padding: 8 },
  crashText: { fontFamily: 'monospace', fontSize: 11 },
});
