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

export default function ChatScreen() {
  const { userId, username } = useLocalSearchParams<{ userId: string; username?: string }>();
  const { engine, messages, send } = useChat();
  const theme = useTheme();

  const [draft, setDraft] = useState('');
  const [peerDeviceId, setPeerDeviceId] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const visible = useMemo(
    () => messages.filter((m) => m.peerKey.startsWith(`${userId}::`)),
    [messages, userId],
  );

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
      <Text variant="bodyMedium" style={{ color: failed ? theme.colors.onErrorContainer : undefined }}>
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
