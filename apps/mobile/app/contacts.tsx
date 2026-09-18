import React, { useState } from 'react';
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

export default function ContactsScreen() {
  const { search, demo, leaveDemo } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; username: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

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
        <Button mode="contained" onPress={runSearch} loading={busy} disabled={busy || !query.trim()}>
          搜索
        </Button>
      </Surface>

      {busy ? <ActivityIndicator style={styles.loader} /> : null}

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({ item }) => (
          <List.Item
            title={item.username}
            description="点击建立加密会话"
            left={(props) => <List.Icon {...props} icon="account-circle" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() =>
              router.push({
                pathname: '/chat/[userId]',
                params: { userId: item.id, username: item.username },
              })
            }
          />
        )}
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
  input: { backgroundColor: 'transparent' },
  loader: { marginTop: 16 },
  empty: { alignItems: 'center', marginTop: 48, gap: 4 },
});
