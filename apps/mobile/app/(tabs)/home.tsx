/**
 * 主界面（会话）
 *
 * 微信风格：头像 + 名字 + 最后一条消息 + 时间，按最近时间倒序。
 * 有聊天记录的排前面；还没聊过的好友排后面，方便直接发起会话。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import {
  Text,
  Surface,
  List,
  Divider,
  ActivityIndicator,
  useTheme,
  IconButton,
  FAB,
  Portal,
  Dialog,
  Button,
  Appbar,
} from 'react-native-paper';
import { useRouter, useFocusEffect } from 'expo-router';
import { useChat } from '../../src/chat/ChatProvider.js';
import { DemoBanner } from '../../src/ui/DemoBanner.js';
import { Avatar } from '../../src/ui/Avatar.js';
import { FadeIn, PressableScale } from '../../src/ui/animations.js';
import { formatConversationTime, formatPreview } from '../../src/ui/timeFormat.js';
import type { DisplayPresence } from '../../src/presence/PresenceManager.js';
import type { Friend } from '../../src/friends/Friends.js';
import type { ConversationSummary } from '../../src/chat/ChatEngine.js';
import { avatarColorFor, initialOf } from '../../src/profile/profileCrypto.js';

/** 列表项：要么是已有会话，要么是还没聊过的好友 */
interface Row {
  userId: string;
  username: string;
  preview: string;
  lastAt: number;
  /** 好友记录；为 null 表示会话已存在但好友已被移除 */
  friend: Friend | null;
  conversation: ConversationSummary | null;
}

export default function HomeScreen() {
  const {
    engine,
    demo,
    leaveDemo,
    listFriends,
    removeFriend,
    listConversations,
    resolveUser,
    connectionStatus,
  } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [rows, setRows] = useState<Row[]>([]);
  const [presence, setPresence] = useState<Record<string, DisplayPresence>>({});
  const [loading, setLoading] = useState(true);
  const [pendingRemove, setPendingRemove] = useState<Row | null>(null);
  const [removing, setRemoving] = useState(false);
  const connected = connectionStatus === 'open';

  const refresh = useCallback(async () => {
    if (!engine) return;
    try {
      const [friends, conversations] = await Promise.all([
        listFriends().catch(() => [] as Friend[]),
        listConversations().catch(() => [] as ConversationSummary[]),
      ]);

      const friendById = new Map(friends.map((f) => [f.userId, f]));
      const merged: Row[] = [];

      // 1) 有聊天记录的：按最近消息时间倒序（微信主界面的排序方式）
      for (const c of conversations) {
        merged.push({
          userId: c.userId,
          // 本地没好友记录时先放空，稍后统一向服务端回填真名，
          // 直接写"未知用户"会让人以为是故障
          username: friendById.get(c.userId)?.username ?? '',
          preview: c.preview,
          lastAt: c.lastAt,
          friend: friendById.get(c.userId) ?? null,
          conversation: c,
        });
      }

      // 回填未知用户名：会话存在但本地无好友记录（对方删了我 / 换设备聊过）
      const unknown = merged.filter((r) => !r.username).map((r) => r.userId);
      if (unknown.length > 0) {
        const resolved = await Promise.all(
          unknown.map((id) => resolveUser(id).catch(() => null)),
        );
        const nameById = new Map<string, string>();
        resolved.forEach((u, i) => {
          if (u?.username) nameById.set(unknown[i], u.username);
        });
        for (const r of merged) {
          if (!r.username) r.username = nameById.get(r.userId) ?? r.userId.slice(0, 8);
        }
      }

      // 2) 还没聊过的好友：按添加时间倒序排在后面
      const talked = new Set(conversations.map((c) => c.userId));
      for (const f of friends) {
        if (talked.has(f.userId)) continue;
        merged.push({
          userId: f.userId,
          username: f.username,
          preview: '',
          lastAt: f.addedAt,
          friend: f,
          conversation: null,
        });
      }

      setRows(merged);

      if (merged.length > 0 && engine.fetchPresence) {
        setPresence(await engine.fetchPresence(merged.map((r) => r.userId)));
      }
    } catch {
      // 在线状态失败不影响列表本身
    } finally {
      setLoading(false);
    }
  }, [engine, listFriends, listConversations, resolveUser]);

  // 每次回到主界面都刷新：聊完返回后能立刻看到最新消息
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      await removeFriend(pendingRemove.userId);
      setPendingRemove(null);
      await refresh();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      {/*
        右上角显示连接状态；搜索入口只保留下方 FAB 一个，
        顶栏再加一个会重复（这也是之前被指出的两个按钮问题）
      */}
      <Appbar.Header>
        <Appbar.Content title="会话" />
        <View style={styles.statusWrap}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: connected ? '#2e7d32' : theme.colors.outline },
            ]}
          />
          <Text variant="bodySmall" style={styles.statusText}>
            {connected ? '通信中' : '连接中…'}
          </Text>
        </View>
      </Appbar.Header>

      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}

      {loading ? (
        <ActivityIndicator style={styles.loader} />
      ) : rows.length === 0 ? (
        <FadeIn style={styles.empty}>
          <IconButton icon="account-plus-outline" size={48} iconColor={theme.colors.outline} />
          <Text variant="titleSmall" style={styles.emptyTitle}>
            还没有会话
          </Text>
          <Text variant="bodySmall" style={styles.emptyHint}>
            到「搜索」里按用户名或 6 位 UID 找到对方，添加后即可开始加密会话。
          </Text>
          <Button mode="contained" onPress={() => router.push('/search')} style={styles.emptyBtn}>
            去添加好友
          </Button>
        </FadeIn>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.userId}
          ItemSeparatorComponent={() => <Divider />}
          renderItem={({ item, index }) => {
            const p = presence[item.userId];
            const hasTalked = !!item.conversation;
            return (
              <FadeIn delay={Math.min(index * 40, 240)}>
                <PressableScale
                  onPress={() =>
                    router.push({
                      pathname: '/chat/[userId]',
                      params: { userId: item.userId, username: item.username },
                    })
                  }
                  onLongPress={() => item.friend && setPendingRemove(item)}
                >
                  <Surface style={styles.rowSurface} elevation={0}>
                    <List.Item
                      title={item.username}
                      titleStyle={styles.name}
                      description={
                        hasTalked
                          ? formatPreview(item.preview) || '（消息内容未缓存）'
                          : '点击开始加密会话'
                      }
                      descriptionNumberOfLines={1}
                      left={() => (
                        <Avatar
                          label={initialOf(item.username, '?')}
                          color={avatarColorFor(item.userId)}
                          size={48}
                          online={!!p?.online && !p.hidden}
                        />
                      )}
                      // right 只能写一个：写两个后一个会覆盖前一个
                      // （曾因此导致在线状态一直不显示）
                      right={(props) => (
                        <View style={styles.rightWrap}>
                          <View style={styles.rightText}>
                            <Text variant="bodySmall" style={styles.time}>
                              {hasTalked ? formatConversationTime(item.lastAt) : ''}
                            </Text>
                            <Text variant="bodySmall" style={styles.presenceText}>
                              {p && !p.hidden ? p.label : ''}
                            </Text>
                          </View>
                          {item.friend ? (
                            <IconButton
                              {...props}
                              icon="account-remove-outline"
                              size={20}
                              onPress={() => setPendingRemove(item)}
                            />
                          ) : null}
                        </View>
                      )}
                    />
                  </Surface>
                </PressableScale>
              </FadeIn>
            );
          }}
        />
      )}

      <FAB
        icon="account-plus"
        style={styles.fab}
        onPress={() => router.push('/search')}
        accessibilityLabel="添加好友"
      />

      <Portal>
        <Dialog visible={!!pendingRemove} onDismiss={() => setPendingRemove(null)}>
          <Dialog.Title>删除好友？</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              将从本机好友名单中移除「{pendingRemove?.username ?? ''}」，本机会话记录一并清除。
              对方不会收到通知。
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPendingRemove(null)} disabled={removing}>
              取消
            </Button>
            <Button
              onPress={confirmRemove}
              loading={removing}
              disabled={removing}
              textColor={theme.colors.error}
            >
              删除
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loader: { marginTop: 32 },
  empty: { alignItems: 'center', marginTop: 64, paddingHorizontal: 32, gap: 6 },
  emptyTitle: { fontWeight: '700', marginTop: 4 },
  emptyHint: { opacity: 0.65, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { marginTop: 12 },
  rowSurface: { backgroundColor: 'transparent' },
  name: { fontWeight: '600', fontSize: 16 },
  rightWrap: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  rightText: { alignItems: 'flex-end', marginRight: 4 },
  time: { opacity: 0.55, fontSize: 11 },
  presenceText: { opacity: 0.5, fontSize: 11 },
  fab: { position: 'absolute', right: 16, bottom: 16 },
  statusWrap: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 14 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { opacity: 0.85, fontSize: 12 },
});
