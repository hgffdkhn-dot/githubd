import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import {
  Text,
  Surface,
  List,
  Divider,
  Button,
  Switch,
  useTheme,
  IconButton,
} from 'react-native-paper';
import { useChat, type MyDevice } from '../../src/chat/ChatProvider.js';
import { loadPrivacy, savePrivacy } from '../../src/settings/privacy.js';

export default function PrivacySettingsScreen() {
  const { engine } = useChat();
  const theme = useTheme();

  const [devices, setDevices] = useState<MyDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [shareOnline, setShareOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!engine) return;
    setError(null);
    try {
      setDevices(await engine.listMyDevices());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [engine]);

  useEffect(() => {
    void refresh();
    loadPrivacy().then((p) => setShareOnline(p.shareOnline));
  }, [refresh]);

  async function toggleSharing(value: boolean) {
    setShareOnline(value);
    try {
      await savePrivacy({ shareOnline: value });
      engine?.setPresenceSharing(value);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(deviceId: string) {
    if (!engine) return;
    setBusyId(deviceId);
    try {
      await engine.revokeDevice(deviceId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          在线显示
        </Text>
        <View style={styles.row}>
          <Text variant="bodyMedium" style={styles.rowText}>
            向好友展示我的在线动态
          </Text>
          <Switch value={shareOnline} onValueChange={toggleSharing} />
        </View>
        <Text variant="bodySmall" style={styles.hint}>
          关闭后，好友看到的是"不显示"，服务端也不会保留可见的时间戳。
        </Text>
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <View style={styles.row}>
          <Text variant="titleSmall" style={styles.sectionTitle}>
            设备管理
          </Text>
          <IconButton icon="refresh" size={20} onPress={() => void refresh()} />
        </View>

        {loading ? (
          <ActivityIndicator style={styles.loader} />
        ) : devices.length === 0 ? (
          <Text variant="bodySmall" style={styles.hint}>
            暂无设备记录
          </Text>
        ) : (
          devices.map((d, index) => (
            <View key={d.id}>
              {index > 0 ? <Divider /> : null}
              <List.Item
                title={d.label || d.id}
                description={`${d.platform} · ${
                  d.current ? '当前设备' : `最近登录 ${describeTime(d.lastSeen)}`
                }${d.revokedAt ? ' · 已踢出' : ''}`}
                left={(p) => (
                  <List.Icon {...p} icon={d.current ? 'cellphone' : 'cellphone-off'} />
                )}
                right={() =>
                  d.current || d.revokedAt ? null : (
                    <Button
                      compact
                      mode="text"
                      textColor={theme.colors.error}
                      loading={busyId === d.id}
                      disabled={busyId === d.id}
                      onPress={() => void revoke(d.id)}
                    >
                      踢出
                    </Button>
                  )
                }
              />
            </View>
          ))
        )}
      </Surface>

      <Text variant="bodySmall" style={styles.note}>
        踢出后该设备的令牌立即失效，需要重新登录。当前设备不能被踢出，避免把自己锁在外面。
      </Text>

      {error ? (
        <Text variant="bodySmall" style={[styles.note, { color: theme.colors.error }]}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function describeTime(ts: number): string {
  if (!ts) return '未知';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / (24 * 3600_000))} 天前`;
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 12, borderRadius: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { flex: 1 },
  sectionTitle: { flex: 1 },
  hint: { opacity: 0.7, lineHeight: 18, marginTop: 4 },
  loader: { marginVertical: 16 },
  note: { opacity: 0.6, paddingHorizontal: 8, lineHeight: 18 },
});
