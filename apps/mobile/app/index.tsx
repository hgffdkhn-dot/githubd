import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TextInput as RNTextInput,
} from 'react-native';
import { Text, TextInput, Button, Surface, IconButton, useTheme } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../src/chat/ChatProvider.js';
import { loadLastError, clearLastError, type CrashRecord } from '../src/ui/crashLog.js';
import { tryUnlock } from '../src/dev/devMode.js';
import { DemoBanner } from '../src/ui/DemoBanner.js';

export default function LoginScreen() {
  const { register, login, status, error, demo, enterDemo, leaveDemo } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [secure, setSecure] = useState(true);

  const [crash, setCrash] = useState<CrashRecord | null>(null);
  const [showCrash, setShowCrash] = useState(false);

  // 演示模式：需要口令，默认折叠，避免普通用户误入
  const [showDev, setShowDev] = useState(false);
  const [devPass, setDevPass] = useState('');
  const [devError, setDevError] = useState<string | null>(null);

  const scrollRef = React.useRef<ScrollView>(null);
  const passwordRef = React.useRef<React.ComponentRef<typeof RNTextInput> | null>(null);
  const devCardRef = React.useRef<View>(null);

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
      if (demo) {
        // 演示模式不校验账号，随便填即可进入
        await (mode === 'login' ? login(username, password) : register(username, password));
      } else if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password);
      }
      router.replace('/contacts');
    } catch {
      // 错误已通过 context 暴露在界面上
    } finally {
      setBusy(false);
    }
  }

  async function unlockDev() {
    setDevError(null);
    if (!tryUnlock(devPass)) {
      setDevError('口令不正确');
      return;
    }
    setDevPass('');
    await enterDemo();
  }

  /** 展开后滚到演示卡片：它在页面底部，不滚的话确认键在视口外 */
  function toggleDev() {
    const next = !showDev;
    setShowDev(next);
    if (!next) return;
    setTimeout(() => {
      try {
        devCardRef.current?.measure?.(
          (_x: number, _y: number, _w: number, _h: number, _px: number, py: number) => {
            scrollRef.current?.scrollTo({ y: Math.max(0, py - 140), animated: true });
          },
        );
      } catch {
        // 测量失败不影响使用
      }
    }, 150);
  }

  const broken = status === 'broken';

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Surface style={styles.hero} elevation={1}>
          <Text variant="headlineMedium" style={styles.title}>
            端到端加密聊天
          </Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            {demo
              ? '演示模式：不加密、不联网，输入任意账号即可浏览界面'
              : '服务端只经手密文，永远看不到你的消息内容'}
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
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            blurOnSubmit={false}
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
            ref={passwordRef}
            returnKeyType={mode === 'login' ? 'go' : 'join'}
            onSubmitEditing={submit}
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

        {/* 演示入口：折叠在底部，避免普通用户误入 */}
        {!demo ? (
          <View style={styles.devRow}>
            <Button compact mode="text" onPress={toggleDev}>
              {showDev ? '隐藏演示模式' : '演示模式（无需服务器）'}
            </Button>

            {showDev ? (
              <View ref={devCardRef} collapsable={false}>
                <Surface style={styles.devCard} elevation={1}>
                  <Text variant="bodySmall" style={styles.hint}>
                    需要演示口令。进入后不加密、不联网，仅供验证界面。
                  </Text>
                  {/* 输入框与按钮同行：按钮始终在视口内，不用滚动去找 */}
                  <View style={styles.devForm}>
                    <TextInput
                      label="演示口令"
                      mode="outlined"
                      value={devPass}
                      onChangeText={setDevPass}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      dense
                      numberOfLines={1}
                      multiline={false}
                      returnKeyType="go"
                      onSubmitEditing={unlockDev}
                      blurOnSubmit
                      style={styles.devInput}
                    />
                    <Button
                      mode="contained"
                      compact
                      onPress={unlockDev}
                      style={styles.devBtn}
                      labelStyle={styles.devBtnLabel}
                    >
                      进入
                    </Button>
                  </View>
                  {devError ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                      {devError}
                    </Text>
                  ) : null}
                </Surface>
              </View>
            ) : null}
          </View>
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
  hint: { opacity: 0.65, marginBottom: 8, lineHeight: 17 },
  input: { marginBottom: 12 },
  button: { marginTop: 4, marginBottom: 4 },
  devRow: { alignItems: 'center', gap: 8, marginTop: 4, width: '100%' },
  devCard: { padding: 12, borderRadius: 12, width: '100%' },
  // 高度写死，避免 Paper 的 outlined 输入框在不同主题下撑得过高
  devInput: { flex: 1, height: 46, marginBottom: 0 },
  devForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  devBtn: { justifyContent: 'center', marginTop: 4 },
  devBtnLabel: { fontSize: 13, marginVertical: 0 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8 },
  note: { flex: 1, opacity: 0.7, lineHeight: 18, paddingTop: 8 },
  crashMeta: { opacity: 0.6, marginTop: 2 },
  crashBox: { maxHeight: 320, marginTop: 8, backgroundColor: '#f2f2f2', borderRadius: 8, padding: 8 },
  crashText: { fontFamily: 'monospace', fontSize: 11 },
});
