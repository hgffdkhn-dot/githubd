import { Stack } from 'expo-router';
import { ChatProvider } from '../src/chat/ChatProvider.js';

export default function RootLayout() {
  return (
    <ChatProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </ChatProvider>
  );
}
