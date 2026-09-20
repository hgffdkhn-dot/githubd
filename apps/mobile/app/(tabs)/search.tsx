/**
 * 搜索 / 添加好友
 *
 * 可按用户名模糊搜，也可按 6 位 UID 精确搜。
 * 搜索结果里直接添加好友，好友名单存在本地。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import {
  Text,
  TextInput,
  Button,
  Surface,
  List,
  Divider,
  ActivityIndicator,
  useTheme,
  Appbar,
  Snackbar,
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../../src/chat/ChatProvider.js';
import { DemoBanner } from '../../src/ui/DemoBanner.js';
import { Avatar } from '../../src/ui/Avatar.js';
import { FadeIn, PressableScale } from '../../src/ui/animations.js';
import type { DisplayPresence } from '../../src/presence/PresenceManager.js';
import { avatarColorFor, initialOf } from '../../src/profile/profileCrypto.js';

interface SearchResult {
  id: string;
  username: string;
  uid: string;
}

export default function SearchScreen() {
  const { search, engine, demo, leaveDemo, listFriends, addFriend } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [presence, setPresence] = useState<Record<string, DisplayPresence>>({});
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadFriendIds = useCallback(async () => {
    try {
      const list = await listFriends();
      setFriendIds(new Set(list.map((f) => f.userId)));
    } catch {
      // 拿不到好友名单时按"都不是好友"处理，不阻断搜索
    }
  }, [listFriends]);

  useEffect(() => {
    void loadFriendIds();
  }, [loadFriendIds]);

  const refreshPresence = useCallback(
    async (ids: string[]) => {
      if (!engine || ids.length === 0) return;
      try {
        setPresence(await engine.fetchPresence(ids));
      } catch {
        // 在线状态是增强信息，拿不到就留空
      }
    },
    [engine],
  );

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setSearched(true);
    try {
      setResults(await search(q));
    } catch {
      setResults([]);
      setToast('搜索失败，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    setFriendIds(await listFriends().then((l) => new Set(l.map((f) => f.userId))).catch(() => new Set<string>()));
    if (query.trim()) void runSearch();
  }

  async function handleAdd(item: SearchResult) {
    setAddingId(item.id);
    try {
      await addFriend({ userId: item.id, username: item.username, uid: item.uid });
      setFriendIds((prev) => new Set(prev).add(item.id));
      setToast(`已添加 ${item.username}`);
    } catch {
      setToast('添加失败，请重试');
    } finally {
      setAddingId(null);
    }
  }

  // 结果变化时拉一次在线状态
  useEffect(() => {
    void refreshPresence(results.map((r) => r.id));
  }, [results, refreshPresence]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <Appbar.Header>
        <Appbar.Content title="搜索" />
      </Appbar.Header>

      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}

      <Surface style={styles.searchBar} elevation={0}>
        <TextInput
          label="用户名或 6 位 UID"
          mode="outlined"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          left={<TextInput.Icon icon="magnify" />}
          style={styles.input}
        />
        <Button
          mode="contained"
          onPress={runSearch}
          loading={busy}
          disabled={busy || !query.trim()}
        >
          搜索
        </Button>
      </Surface>

      {busy ? <ActivityIndicator style={styles.loader} /> : null}

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <Divider />}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} />}
        renderItem={({ item, index }) => {
          const p = presence[item.id];
          const isFriend = friendIds.has(item.id);
          return (
            <FadeIn delay={Math.min(index * 40, 240)}>
              <PressableScale
                onPress={() =>
                  router.push({
                    pathname: '/chat/[userId]',
                    params: { userId: item.id, username: item.username },
                  })
                }
              >
                <List.Item
                  title={item.username}
                  description={item.uid ? `UID ${item.uid}` : ''}
                  left={() => (
                    <Avatar
                      label={initialOf(item.username, '?')}
                      color={avatarColorFor(item.id)}
                      size={44}
                      online={!!p?.online && !p?.hidden}
                    />
                  )}
                  // 注意：right 只能写一个，写两个后一个会覆盖前一个
                  // —— 之前在线状态一直不显示就是这个原因
                  right={(props) => (
                    <View style={styles.rightWrap}>
                      <Text variant="bodySmall" style={styles.presenceText}>
                        {p && !p.hidden ? p.label : ''}
                      </Text>
                      {isFriend ? (
                        <List.Icon {...props} icon="chevron-right" />
                      ) : (
                        <Button
                          compact
                          mode="contained-tonal"
                          loading={addingId === item.id}
                          disabled={addingId === item.id}
                          onPress={() => void handleAdd(item)}
                        >
                          添加
                        </Button>
                      )}
                    </View>
                  )}
                />
              </PressableScale>
            </FadeIn>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="bodyMedium" style={{ opacity: 0.6 }}>
              {searched ? '没有找到该用户' : '输入用户名或 6 位 UID 搜索'}
            </Text>
          </View>
        }
      />

      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2200}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchBar: { padding: 16, gap: 12 },
  input: { backgroundColor: 'transparent' },
  loader: { marginTop: 16 },
  empty: { alignItems: 'center', marginTop: 48 },
  rightWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  presenceText: { opacity: 0.6 },
});
