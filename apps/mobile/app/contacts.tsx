import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, Button } from 'react-native';
import { useRouter } from 'expo-router';
import { useChat } from '../src/chat/ChatProvider.js';

export default function ContactsScreen() {
  const { search } = useChat();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; username: string }[]>([]);

  async function runSearch() {
    setResults(await search(query));
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>找人聊天</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="输入用户名"
          autoCapitalize="none"
          value={query}
          onChangeText={setQuery}
        />
        <Button title="搜索" onPress={runSearch} />
      </View>

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        renderItem={({ item }: { item: { id: string; username: string } }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() => router.push({ pathname: '/chat/[userId]', params: { userId: item.id, username: item.username } })}
          >
            <Text style={styles.itemText}>{item.username}</Text>
            <Text style={styles.itemHint}>建立加密会话</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={styles.empty}>搜索结果会出现在这里</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
  item: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#eee' },
  itemText: { fontSize: 16 },
  itemHint: { fontSize: 12, color: '#888' },
  empty: { marginTop: 24, color: '#999', textAlign: 'center' },
});
