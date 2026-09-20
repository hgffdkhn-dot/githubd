import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import {
  Text,
  TextInput,
  Button,
  Surface,
  SegmentedButtons,
  useTheme,
  Divider,
} from 'react-native-paper';
import { useChat } from '../../../src/chat/ChatProvider.js';
import { Avatar } from '../../../src/ui/Avatar.js';

type Visibility = 'friends' | 'public';

export default function ProfileSettingsScreen() {
  const { engine, demo, leaveDemo } = useChat();
  const theme = useTheme();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('friends');
  const [avatarBg, setAvatarBg] = useState('#6750a4');
  const [message, setMessage] = useState<string | null>(null);
  const [myUid, setMyUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engine) return;
    // 先取本地缓存，让界面立刻有内容（哪怕是"—"）
    setMyUid(engine.uid);
    engine
      .loadMyProfile()
      .then((p) => {
        setDisplayName(p.displayName);
        setBio(p.bio);
        setVisibility(p.visibility);
        setAvatarBg(p.avatarBg);
        // 老账号的 UID 只有在读取资料时才从服务端补回来
        setMyUid((p as { uid?: string | null }).uid ?? engine.uid ?? null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [engine]);

  async function save() {
    if (!engine) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await engine.saveMyProfile({ displayName, bio }, visibility);
      setMessage('已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {demo ? <Text style={styles.demoHint}>演示模式：资料只存在本地，不上传</Text> : null}

      <Surface style={styles.hero} elevation={1}>
        <Avatar label={displayName.trim() ? displayName.trim()[0] : '?'} color={avatarBg} size={72} />
        <Text variant="titleMedium" style={styles.heroName}>
          {displayName || '未设置昵称'}
        </Text>

        {/* UID 是加好友最可靠的方式：昵称会改，UID 终身不变 */}
        <View style={styles.uidRow}>
          <Text variant="bodySmall" style={styles.uidLabel}>
            我的 UID
          </Text>
          <Text variant="titleMedium" style={styles.uidValue} selectable>
            {myUid ?? '—'}
          </Text>
        </View>
        <Text variant="bodySmall" style={styles.heroSub}>
          把这串数字发给好友，对方搜索即可找到你。昵称可改，UID 终身不变。
        </Text>
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <TextInput
          label="昵称"
          mode="outlined"
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={64}
          style={styles.input}
        />
        <TextInput
          label="个人简介"
          mode="outlined"
          value={bio}
          onChangeText={setBio}
          multiline
          numberOfLines={3}
          maxLength={300}
          style={styles.input}
        />

        <Divider style={styles.divider} />

        <Text variant="titleSmall" style={styles.sectionTitle}>
          谁可以看到我的资料
        </Text>
        <SegmentedButtons
          value={visibility}
          onValueChange={(v) => setVisibility(v as Visibility)}
          buttons={[
            { value: 'friends', label: '仅好友' },
            { value: 'public', label: '公开' },
          ]}
        />
        <Text variant="bodySmall" style={styles.hint}>
          {visibility === 'friends'
            ? '昵称与简介以密文上传，服务端无法读取；陌生人搜索到你时看不到资料。'
            : '昵称与简介以明文上传，任何人搜索到你都能看到 —— 服务端可读，请谨慎。'}
        </Text>

        {error ? (
          <Text variant="bodySmall" style={[styles.error, { color: theme.colors.error }]}>
            {error}
          </Text>
        ) : null}
        {message ? (
          <Text variant="bodySmall" style={styles.ok}>
            {message}
          </Text>
        ) : null}

        <Button mode="contained" onPress={save} loading={saving} disabled={saving}>
          保存
        </Button>
      </Surface>

      {demo ? (
        <Button mode="text" onPress={() => void leaveDemo()}>
          退出演示模式
        </Button>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { padding: 20, borderRadius: 16, alignItems: 'center', gap: 8 },
  heroName: { fontWeight: '700' },
  heroSub: { opacity: 0.65, textAlign: 'center', lineHeight: 18, marginTop: 4 },
  uidRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  uidLabel: { opacity: 0.6 },
  uidValue: { fontWeight: '700', letterSpacing: 2, fontFamily: 'monospace' },
  card: { padding: 16, borderRadius: 16 },
  input: { marginBottom: 12 },
  divider: { marginVertical: 12 },
  sectionTitle: { marginBottom: 8 },
  hint: { opacity: 0.7, marginTop: 8, marginBottom: 12, lineHeight: 18 },
  error: { marginBottom: 8 },
  ok: { color: '#2e7d32', marginBottom: 8 },
  demoHint: { color: '#b3261e', fontSize: 12 },
});
