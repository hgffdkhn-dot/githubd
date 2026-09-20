import React, { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, KeyboardAvoidingView, Platform } from 'react-native';
import {
  Text,
  TextInput,
  IconButton,
  Surface,
  useTheme,
  ActivityIndicator,
  Chip,
} from 'react-native-paper';
import { useLocalSearchParams } from 'expo-router';
import { useChat } from '../../src/chat/ChatProvider.js';
import type { DecryptedMessage } from '../../src/chat/ChatEngine.js';
import { DemoBanner } from '../../src/ui/DemoBanner.js';
import { Avatar } from '../../src/ui/Avatar.js';
import type { DisplayPresence } from '../../src/presence/PresenceManager.js';
import type { ResolvedProfile } from '../../src/profile/ProfileManager.js';
import { avatarColorFor, initialOf } from '../../src/profile/profileCrypto.js';

export default function ChatScreen() {
  const { userId, username } = useLocalSearchParams<{ userId: string; username?: string }>();
  const { engine, messages, send, demo, leaveDemo } = useChat();
  const theme = useTheme();

  const [draft, setDraft] = useState('');
  const [peerDeviceId, setPeerDeviceId] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ResolvedProfile | null>(null);
  const [presence, setPresence] = useState<DisplayPresence | null>(null);
  const [history, setHistory] = useState<DecryptedMessage[]>([]);

  useEffect(() => {
    if (!engine) return;
    engine
      .resolvePeerDevice(userId)
      .then(async (peer) => {
        setPeerDeviceId(peer.deviceId);
        setSafetyNumber(engine.safetyNumberWith(peer.identityKey));
      })
      .catch((e) => setFailure((e as Error).message))
      .finally(() => setLoading(false));
  }, [engine, userId]);

  /**
   * 读历史消息
   *
   * 必须等 peerDeviceId 解析出来才能查库（peerKey 依赖它）。
   * 每次进入会话都会重读，退出应用再进来也能看到聊天记录。
   */
  useEffect(() => {
    if (!engine || !userId || !peerDeviceId) return;
    engine
      .loadHistory(userId, peerDeviceId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [engine, userId, peerDeviceId]);

  // 对方资料与在线状态：失败都不影响聊天，只降级展示
  useEffect(() => {
    if (!engine || !userId) return;
    engine
      .loadPeerProfile(userId)
      .then(setProfile)
      .catch(() => setProfile(null));
    engine
      .fetchPresence([userId])
      .then((map) => setPresence(map[userId] ?? null))
      .catch(() => setPresence(null));
  }, [engine, userId]);

  const visible = useMemo(() => {
    // 历史来自数据库，实时来自内存；同一个 envelopeId 只保留一条，
    // 且以内存为准（内存里的明文一定是刚解密出来的最新内容）
    const byId = new Map<string, DecryptedMessage>();
    for (const h of history) byId.set(h.envelopeId, h);
    for (const m of messages) {
      if (m.peerKey.startsWith(`${userId}::`)) byId.set(m.envelopeId, m);
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, history, userId]);

  async function onSend() {
    if (!peerDeviceId || !draft.trim()) return;
    const text = draft;
    setDraft('');
    try {
      await send(userId, peerDeviceId, text);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}

      <Surface style={styles.peerBar} elevation={1}>
        <Avatar
          label={profile?.avatarInitial || initialOf(username ?? '?', '?')}
          color={profile?.avatarBg || avatarColorFor(userId)}
          size={44}
          online={!!presence?.online && !presence.hidden}
        />
        <View style={styles.peerText}>
          <Text variant="titleSmall">
            {profile?.displayName || username || '对话'}
            {profile?.locked ? '（资料加密，暂不可读）' : ''}
          </Text>
          <Text variant="bodySmall" style={{ opacity: 0.7 }}>
            {presence && !presence.hidden ? presence.label : '在线状态不显示'}
            {profile?.bio ? ` · ${profile.bio}` : ''}
          </Text>
        </View>
      </Surface>

      {safetyNumber ? (
        <Surface style={styles.safetyBar} elevation={1}>
          <Chip icon="shield-check" compact>
            安全码 {safetyNumber.slice(0, 12)}…
          </Chip>
          <Text variant="bodySmall" style={styles.safetyHint}>
            与对方当面比对完整安全码，一致后再聊敏感内容
          </Text>
        </Surface>
      ) : null}

      {failure ? (
        <Text variant="bodySmall" style={[styles.failure, { color: theme.colors.error }]}>
          {failure}
        </Text>
      ) : null}

      {loading ? <ActivityIndicator style={styles.loader} /> : null}

      <FlatList
        style={styles.list}
        data={visible}
        keyExtractor={(item) => item.envelopeId}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }: { item: DecryptedMessage }) => (
          <MessageBubble item={item} />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="bodyMedium" style={{ opacity: 0.6 }}>
              第一条消息会自动完成密钥协商
            </Text>
          </View>
        }
      />

      <Surface style={styles.composer} elevation={2}>
        <TextInput
          placeholder="输入消息"
          mode="outlined"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={onSend}
          disabled={!peerDeviceId}
          style={styles.input}
          dense
        />
        <IconButton
          icon="send"
          mode="contained"
          size={22}
          onPress={onSend}
          disabled={!peerDeviceId || !draft.trim()}
        />
      </Surface>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ item }: { item: DecryptedMessage }) {
  const theme = useTheme();
  const outgoing = item.direction === 'out';
  const failed = item.status === 'failed';

  return (
    <View
      style={[
        styles.bubble,
        outgoing ? styles.out : styles.in,
        {
          backgroundColor: failed
            ? theme.colors.errorContainer
            : outgoing
              ? theme.colors.primaryContainer
              : theme.colors.surfaceVariant,
        },
      ]}
    >
      {/*
        selectable：长按可选中并复制。RN 的 <Text> 默认不可选，
        不加这个属性接收方发来的内容就复制不了。
        selectionColor 让选中区域有高亮，Android 上更符合直觉。
      */}
      <Text
        variant="bodyMedium"
        selectable
        selectionColor={theme.colors.primaryContainer}
        style={{ color: failed ? theme.colors.onErrorContainer : undefined }}
      >
        {item.text}
      </Text>
      <Text variant="bodySmall" style={styles.meta}>
        {outgoing ? '我' : '对方'} · {item.status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  peerBar: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  peerText: { flex: 1 },
  safetyBar: { padding: 12, gap: 4, alignItems: 'flex-start' },
  safetyHint: { opacity: 0.7 },
  failure: { paddingHorizontal: 16, paddingVertical: 4 },
  loader: { marginTop: 24 },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 8, flexGrow: 1 },
  bubble: { padding: 10, borderRadius: 16, maxWidth: '82%' },
  in: { alignSelf: 'flex-start' },
  out: { alignSelf: 'flex-end' },
  meta: { fontSize: 10, opacity: 0.6, marginTop: 4 },
  empty: { alignItems: 'center', marginTop: 32 },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 },
  input: { flex: 1, backgroundColor: 'transparent' },
});
