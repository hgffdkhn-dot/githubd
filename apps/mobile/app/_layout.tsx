import { Stack } from 'expo-router';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatProvider } from '../src/chat/ChatProvider.js';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.js';
import { lightTheme } from '../src/ui/theme.js';
import { installGlobalHandlers } from '../src/ui/crashLog.js';

// 必须在渲染之前接管，否则 release 构建下的未捕获异常只会表现为白屏
installGlobalHandlers();

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <PaperProvider theme={lightTheme}>
          <ChatProvider>
            <Stack
              screenOptions={{
                headerShown: true,
                headerStyle: { backgroundColor: lightTheme.colors.primary },
                headerTintColor: lightTheme.colors.onPrimary,
                headerTitleStyle: { fontWeight: '600' },
              }}
            />
          </ChatProvider>
        </PaperProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
