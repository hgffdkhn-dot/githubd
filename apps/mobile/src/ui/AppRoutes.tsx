/**
 * 路由表
 *
 * 单独成文件是为了能放在 PaperProvider 内部 ——
 * 这样 useTheme() 拿到的是用户切换后的动态主题，Appbar 配色才会跟着变。
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from 'react-native-paper';

export function AppRoutes() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.primary },
        headerTintColor: theme.colors.onPrimary,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Stack.Screen name="index" options={{ title: '登录' }} />
      <Stack.Screen name="contacts" options={{ title: '联系人' }} />
      <Stack.Screen name="settings" options={{ title: '设置' }} />
      <Stack.Screen name="settings/account" options={{ title: '账号设置' }} />
      <Stack.Screen name="settings/profile" options={{ title: '个人主页' }} />
      <Stack.Screen name="settings/appearance" options={{ title: '外观' }} />
      <Stack.Screen name="settings/privacy" options={{ title: '隐私' }} />
      <Stack.Screen name="chat/[userId]" options={{ title: '会话' }} />
    </Stack>
  );
}
