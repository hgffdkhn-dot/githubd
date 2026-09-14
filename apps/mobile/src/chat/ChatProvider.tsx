import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChatEngine, type DecryptedMessage } from './ChatEngine.js';

const DEFAULT_SERVER = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

interface ChatContextValue {
  engine: ChatEngine;
  messages: DecryptedMessage[];
  status: 'guest' | 'ready';
  error: string | null;
  register: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  send: (peerUserId: string, peerDeviceId: string, text: string) => Promise<void>;
  search: (query: string) => Promise<{ id: string; username: string }[]>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const engine = useMemo(() => new ChatEngine(DEFAULT_SERVER), []);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [status, setStatus] = useState<'guest' | 'ready'>('guest');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const unsubscribe = engine.onMessage((message) => {
      setMessages((prev) => [...prev, message]);
    });
    return () => {
      unsubscribe();
      engine.stop();
    };
  }, [engine]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    engine
      .restoreSession()
      .then(async (restored) => {
        if (!restored) return false;
        await engine.start();
        setStatus('ready');
        return true;
      })
      .catch(() => undefined);
  }, [engine]);

  const value = useMemo<ChatContextValue>(
    () => ({
      engine,
      messages,
      status,
      error,
      async register(username, password) {
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
        await engine.sendText(peerUserId, peerDeviceId, text);
      },
      async search(query) {
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
