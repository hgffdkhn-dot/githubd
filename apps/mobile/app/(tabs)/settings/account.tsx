import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import {
  Text,
  Surface,
  List,
  Divider,
  Button,
  Dialog,
  Portal,
  useTheme,
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../../../src/chat/ChatProvider.js';

export default function AccountSettingsScreen() {
  const { engine, logout, demo, leaveDemo } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [uid, setUid] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engine) return;
    setUid(engine.uid);
    // 老账号/重装的 UID 可能只在读取资料时才拿到
    engine
      .ensureUid()
      .then(setUid)
      .catch(() => undefined);
  }, [engine]);

  async function doLogout() {
    setBusy(true);
    setError(null);
    try {
      await logout();
      setConfirming(false);
      // 退回登录页；用 replace 避免返回键又回到设置页
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Surface style={styles.card} elevation={1}>
        <List.Item
          title="我的 UID"
          description={uid ?? '读取中…'}
          left={(p) => <List.Icon {...p} icon="identifier" />}
          right={() =>
            uid ? (
              <Text variant="titleMedium" style={styles.uidValue} selectable>
                {uid}
              </Text>
            ) : null
          }
        />
        <Divider />
        <List.Item
          title="当前设备"
          description={demo ? '演示模式（无真实账号）' : '已登录'}
          left={(p) => <List.Icon {...p} icon="cellphone" />}
        />
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          退出账号
        </Text>
        <Text variant="bodySmall" style={styles.warnText}>
          退出会清除本机上的身份密钥与全部会话记录。
          {'\n'}
          由于私钥从不上传，<Text style={styles.bold}>退出后历史会话无法恢复</Text>
          ；服务端账号仍然存在，可用同一用户名重新注册。
        </Text>
        <Button
          mode="contained"
          buttonColor={theme.colors.error}
          textColor="#fff"
          onPress={() => setConfirming(true)}
          icon="logout"
        >
          退出账号
        </Button>
      </Surface>

      {error ? (
        <Text variant="bodySmall" style={[styles.note, { color: theme.colors.error }]}>
          {error}
        </Text>
      ) : null}

      {demo ? (
        <Button mode="text" onPress={() => void leaveDemo()}>
          退出演示模式
        </Button>
      ) : null}

      <Portal>
        <Dialog visible={confirming} onDismiss={() => setConfirming(false)}>
          <Dialog.Title>确认退出账号？</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              本机身份密钥与所有会话记录会被永久清除，无法恢复。
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)} disabled={busy}>
              取消
            </Button>
            <Button
              onPress={doLogout}
              loading={busy}
              disabled={busy}
              textColor={theme.colors.error}
            >
              确认退出
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 12, borderRadius: 16 },
  sectionTitle: { marginBottom: 8 },
  warnText: { opacity: 0.75, lineHeight: 20, marginBottom: 12 },
  bold: { fontWeight: '700' },
  uidValue: { fontWeight: '700', letterSpacing: 2, alignSelf: 'center', marginRight: 8 },
  note: { paddingHorizontal: 8, lineHeight: 18 },
});
