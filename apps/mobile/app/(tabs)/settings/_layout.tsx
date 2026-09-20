/**
 * 设置 Tab 的内部栈
 *
 * 设置菜单在底部栏里，但它的子页面（个人主页 / 账号 / 外观 / 隐私）
 * 需要带返回箭头的顶栏 —— 所以这个 Tab 内部再套一层 Stack。
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from 'react-native-paper';

export default function SettingsStackLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.primary },
        headerTintColor: theme.colors.onPrimary,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Stack.Screen name="index" options={{ title: '设置' }} />
      <Stack.Screen name="profile" options={{ title: '个人主页' }} />
      <Stack.Screen name="account" options={{ title: '账号设置' }} />
      <Stack.Screen name="appearance" options={{ title: '外观' }} />
      <Stack.Screen name="privacy" options={{ title: '隐私' }} />
      <Stack.Screen name="security" options={{ title: '安全' }} />
    </Stack>
  );
}
