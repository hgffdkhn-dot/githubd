/**
 * 底部导航栏（Material 3 风格）
 *
 * 三个 Tab：会话（主界面）/ 搜索 / 设置。
 * 注册或登录成功后直接进"会话"，符合聊天 App 的习惯。
 */

import React from 'react';
import { Tabs } from 'expo-router';
import { useTheme } from 'react-native-paper';
import { SafeIcon } from '../../src/ui/SafeIcon.js';
import { ScaleOnFocus } from '../../src/ui/animations.js';

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.outlineVariant,
          elevation: 3,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: '会话',
          tabBarIcon: ({ focused, color, size }) => (
            <ScaleOnFocus focused={focused}>
              <SafeIcon name={focused ? 'message' : 'message-outline'} size={size} color={color} />
            </ScaleOnFocus>
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: '搜索',
          tabBarIcon: ({ focused, color, size }) => (
            <ScaleOnFocus focused={focused}>
              <SafeIcon
                name={focused ? 'account-search' : 'account-search-outline'}
                size={size}
                color={color}
              />
            </ScaleOnFocus>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ focused, color, size }) => (
            <ScaleOnFocus focused={focused}>
              <SafeIcon name={focused ? 'cog' : 'cog-outline'} size={size} color={color} />
            </ScaleOnFocus>
          ),
        }}
      />
    </Tabs>
  );
}
