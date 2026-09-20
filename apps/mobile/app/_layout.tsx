import React from 'react';
import { Stack } from 'expo-router';
import { PaperProvider, useTheme, type MD3Theme } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatProvider } from '../src/chat/ChatProvider.js';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.js';
import { buildTheme, getSettings, loadSettings, subscribeSettings } from '../src/settings/appearance.js';
import { installGlobalHandlers } from '../src/ui/crashLog.js';

// 必须在渲染之前接管，否则 release 构建下的未捕获异常只会表现为白屏
installGlobalHandlers();

/** 主题随外观设置实时重建：切换主题色或深色模式后立刻生效 */
function ThemeHost({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = React.useState<MD3Theme>(() => buildTheme(getSettings()));

  React.useEffect(() => {
    void loadSettings().then((s) => setTheme(buildTheme(s)));
    return subscribeSettings((s) => setTheme(buildTheme(s)));
  }, []);

  return <PaperProvider theme={theme}>{children}</PaperProvider>;
}

/**
 * 根栈
 *
 * - index：登录页，不显示顶栏（它自己就是一屏）
 * - (tabs)：底部三 Tab，顶栏由各 Tab 自己渲染
 * - chat/[userId]：会话页，需要带返回箭头的顶栏
 */
function RootStack() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: theme.colors.primary },
        headerTintColor: theme.colors.onPrimary,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[userId]" options={{ headerShown: true, title: '会话' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeHost>
          <ChatProvider>
            <RootStack />
          </ChatProvider>
        </ThemeHost>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
