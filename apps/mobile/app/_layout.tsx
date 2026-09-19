import React from 'react';
import { PaperProvider, type MD3Theme } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatProvider } from '../src/chat/ChatProvider.js';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.js';
import {
  buildTheme,
  getSettings,
  loadSettings,
  subscribeSettings,
} from '../src/settings/appearance.js';
import { installGlobalHandlers } from '../src/ui/crashLog.js';
import { AppRoutes } from '../src/ui/AppRoutes.js';

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

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeHost>
          <ChatProvider>
            <AppRoutes />
          </ChatProvider>
        </ThemeHost>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
