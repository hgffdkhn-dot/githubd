import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, Button, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useChat } from '../../src/chat/ChatProvider.js';
import type { DecryptedMessage } from '../../src/chat/ChatEngine.js';

export default function ChatScreen() {
  const { userId, username } = useLocalSearchParams<{ userId: string; username?: string }>();
  const { engine, messages, send } = useChat();
  const [draft, setDraft] = useState('');
  const [peerDeviceId, setPeerDeviceId] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    engine
      .resolvePeerDevice(userId)
      .then(async (peer) => {
        setPeerDeviceId(peer.deviceId);
        setSafetyNumber(engine.safetyNumberWith(peer.identityKey));
      })
      .catch((e) => setFailure((e as Error).message));
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
    <View style={styles.container}>
      <Text style={styles.title}>与 {username ?? userId} 的加密会话</Text>

      {safetyNumber ? (
        <TouchableOpacity>
          <Text style={styles.safety}>安全码：{safetyNumber}</Text>
          <Text style={styles.safetyHint}>当面比对一致后再聊敏感内容</Text>
        </TouchableOpacity>
      ) : null}

      {failure ? <Text style={styles.error}>{failure}</Text> : null}

      <FlatList
        style={styles.list}
        data={visible}
        keyExtractor={(item) => item.envelopeId}
        renderItem={({ item }: { item: DecryptedMessage }) => (
          <View style={[styles.bubble, item.direction === 'out' ? styles.out : styles.in]}>
            <Text style={item.status === 'failed' ? styles.failedText : styles.text}>{item.text}</Text>
            <Text style={styles.meta}>
              {item.direction === 'out' ? '我' : '对方'} · {item.status}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>第一条消息会自动完成密钥协商</Text>}
      />

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="输入消息"
          value={draft}
          onChangeText={setDraft}
        />
        <Button title="发送" onPress={onSend} disabled={!peerDeviceId || !draft.trim()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  safety: { fontSize: 13, color: '#1e6f50' },
  safetyHint: { fontSize: 11, color: '#888' },
  list: { flex: 1 },
  bubble: { padding: 10, borderRadius: 10, marginBottom: 8, maxWidth: '85%' },
  in: { backgroundColor: '#f0f0f0', alignSelf: 'flex-start' },
  out: { backgroundColor: '#d6ecff', alignSelf: 'flex-end' },
  text: { fontSize: 15 },
  failedText: { fontSize: 15, color: '#c0392b' },
  meta: { fontSize: 10, color: '#888', marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
  error: { color: '#c0392b', fontSize: 13 },
  empty: { color: '#999', textAlign: 'center', marginTop: 24 },
});
