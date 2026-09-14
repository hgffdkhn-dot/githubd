import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChatEngine, type DecryptedMessage } from './ChatEngine.js';

const DEFAULT_SERVER = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

interface ChatContextValue {
  engine: ChatEngine | null;
  messages: DecryptedMessage[];
  status: 'guest' | 'ready' | 'broken';
  error: string | null;
  register: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  send: (peerUserId: string, peerDeviceId: string, text: string) => Promise<void>;
  search: (query: string) => Promise<{ id: string; username: string }[]>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  // 构造 ChatEngine 会注入 quick-crypto 并打开 SQLite，任一环节失败都不能让整棵树崩掉
  const [engine] = useState<ChatEngine | null>(() => {
    try {
      return new ChatEngine(DEFAULT_SERVER);
    } catch (error) {
      console.error('[E2EE] ChatEngine 初始化失败:', error);
      return null;
    }
  });

  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [status, setStatus] = useState<'guest' | 'ready' | 'broken'>(
    engine ? 'guest' : 'broken',
  );
  const [error, setError] = useState<string | null>(
    engine ? null : '本地加密环境初始化失败：quick-crypto 或 SQLite 不可用',
  );
  const started = useRef(false);

  useEffect(() => {
    if (!engine) return;
    const unsubscribe = engine.onMessage((message) => {
      setMessages((prev) => [...prev, message]);
    });
    return () => {
      unsubscribe();
      engine.stop();
    };
  }, [engine]);

  useEffect(() => {
    if (!engine || started.current) return;
    started.current = true;
    engine
      .restoreSession()
      .then(async (restored) => {
        if (!restored) return;
        await engine.start();
        setStatus('ready');
      })
      .catch((e) => {
        // 恢复失败不算致命错误，停在登录页即可，但要让用户知道
        console.error('[E2EE] 会话恢复失败:', e);
      });
  }, [engine]);

  const value = useMemo<ChatContextValue>(
    () => ({
      engine,
      messages,
      status,
      error,
      async register(username, password) {
        if (!engine) throw new Error('本地加密环境不可用');
        try {
          setError(null);
          await engine.register(username, password);
          await engine.start();
          setStatus('ready');
        } catch (e) {
          setError((e as Error).message);
          throw e;
        }
      },
      async login(username, password) {
        if (!engine) throw new Error('本地加密环境不可用');
        try {
          setError(null);
          await engine.login(username, password);
          await engine.start();
          setStatus('ready');
        } catch (e) {
          setError((e as Error).message);
          throw e;
        }
      },
      async send(peerUserId, peerDeviceId, text) {
        if (!engine) throw new Error('本地加密环境不可用');
        await engine.sendText(peerUserId, peerDeviceId, text);
      },
      async search(query) {
        if (!engine) return [];
        return engine.searchUsers(query);
      },
    }),
    [engine, messages, status, error],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat 必须在 ChatProvider 内使用');
  return context;
}
