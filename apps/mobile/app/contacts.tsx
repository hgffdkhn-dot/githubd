import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import {
  Text,
  TextInput,
  Button,
  Surface,
  List,
  Divider,
  ActivityIndicator,
  useTheme,
  IconButton,
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../src/chat/ChatProvider.js';
import { DemoBanner } from '../src/ui/DemoBanner.js';
import { Avatar } from '../src/ui/Avatar.js';
import type { DisplayPresence } from '../src/presence/PresenceManager.js';
import { avatarColorFor, initialOf } from '../src/profile/profileCrypto.js';

export default function ContactsScreen() {
  const { search, engine, demo, leaveDemo } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; username: string }[]>([]);
  const [presence, setPresence] = useState<Record<string, DisplayPresence>>({});
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  /** 在线状态每 30 秒刷新一次 */
  const refreshPresence = useCallback(
    async (ids: string[]) => {
      if (!engine || ids.length === 0) return;
      try {
        setPresence(await engine.fetchPresence(ids));
      } catch {
        // 在线状态是增强信息，拿不到就留空，不影响聊天
      }
    },
    [engine],
  );

  useEffect(() => {
    if (results.length === 0) return;
    void refreshPresence(results.map((r) => r.id));
    const timer = setInterval(() => void refreshPresence(results.map((r) => r.id)), 30_000);
    return () => clearInterval(timer);
  }, [results, refreshPresence]);

  async function runSearch() {
    if (!query.trim()) return;
    setBusy(true);
    setSearched(true);
    try {
      setResults(await search(query.trim()));
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}

      <Surface style={styles.searchBar} elevation={2}>
        <View style={styles.searchRow}>
          <TextInput
            label="搜索用户名"
            mode="outlined"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={runSearch}
            autoCapitalize="none"
            returnKeyType="search"
            left={<TextInput.Icon icon="magnify" />}
            style={styles.input}
          />
          <IconButton icon="cog" size={22} onPress={() => router.push('/settings')} />
        </View>
        <Button mode="contained" onPress={runSearch} loading={busy} disabled={busy || !query.trim()}>
          搜索
        </Button>
      </Surface>

      {busy ? <ActivityIndicator style={styles.loader} /> : null}

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({ item }) => {
          const p = presence[item.id];
          return (
            <List.Item
              title={item.username}
              description={p && !p.hidden ? p.label : '点击建立加密会话'}
              left={() => (
                <Avatar
                  label={initialOf(item.username, '?')}
                  color={avatarColorFor(item.id)}
                  size={40}
                  online={!!p?.online && !p.hidden}
                />
              )}
              right={(props) => <List.Icon {...props} icon="chevron-right" />}
              onPress={() =>
                router.push({
                  pathname: '/chat/[userId]',
                  params: { userId: item.id, username: item.username },
                })
              }
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <IconButton icon="account-search" size={40} iconColor={theme.colors.outline} />
            <Text variant="bodyMedium" style={{ opacity: 0.6 }}>
              {searched ? '没有找到该用户' : '输入用户名开始搜索'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchBar: { padding: 16, gap: 12 },
  searchRow: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, backgroundColor: 'transparent' },
  loader: { marginTop: 16 },
  empty: { alignItems: 'center', marginTop: 48, gap: 4 },
});
