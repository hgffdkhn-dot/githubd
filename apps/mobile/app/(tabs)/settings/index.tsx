import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Text, Surface, List, Divider, useTheme } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useChat } from '../../../src/chat/ChatProvider.js';
import { DemoBanner } from '../../../src/ui/DemoBanner.js';

export default function SettingsScreen() {
  const { demo, leaveDemo, engine } = useChat();
  const router = useRouter();
  const theme = useTheme();

  const who = engine ? '已登录' : '未登录';

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      {demo ? <DemoBanner onExit={() => void leaveDemo()} /> : null}
      <ScrollView contentContainerStyle={styles.content}>
        <Surface style={styles.card} elevation={1}>
          <List.Item
            title="账号设置"
            description="UID、退出账号"
            left={(p) => <List.Icon {...p} icon="account-cog" />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/settings/account')}
          />
          <Divider />
          <List.Item
            title="个人主页"
            description="头像、昵称、个人简介"
            left={(p) => <List.Icon {...p} icon="account-edit" />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/settings/profile')}
          />
          <Divider />
          <List.Item
            title="外观"
            description="主题色、深色模式"
            left={(p) => <List.Icon {...p} icon="palette" />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/settings/appearance')}
          />
          <Divider />
          <List.Item
            title="安全"
            description="代理、本地消息缓存"
            left={(p) => <List.Icon {...p} icon="shield-lock" />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/settings/security')}
          />
          <Divider />
          <List.Item
            title="隐私"
            description="设备管理、在线显示"
            left={(p) => <List.Icon {...p} icon="shield-account" />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/settings/privacy')}
          />
        </Surface>

        <Text variant="bodySmall" style={styles.note}>
          当前状态：{who}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 12 },
  card: { borderRadius: 16, overflow: 'hidden' },
  note: { opacity: 0.6, paddingHorizontal: 8 },
});
