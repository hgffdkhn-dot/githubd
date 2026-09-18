import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChatEngine, type DecryptedMessage } from './ChatEngine.js';
import { recordError } from '../ui/crashLog.js';
import { getServerUrl, setServerUrl, resetServerUrl } from '../network/serverConfig.js';
import { MockEngine } from '../dev/MockEngine.js';
import { isDevUnlocked } from '../dev/devMode.js';

/** UI 真正用到的方法集合，真实引擎与演示引擎都满足 */
export interface EngineLike {
  onMessage(listener: (m: DecryptedMessage) => void): () => void;
  register(username: string, password: string): Promise<void>;
  login(username: string, password: string): Promise<void>;
  restoreSession(): Promise<boolean>;
  start(): Promise<void>;
  sendText(peerUserId: string, peerDeviceId: string, text: string): Promise<void>;
  resolvePeerDevice(userId: string): Promise<{ deviceId: string; identityKey: Uint8Array }>;
  safetyNumberWith(peerIdentityKey: Uint8Array): string;
  searchUsers(query: string): Promise<{ id: string; username: string }[]>;
  stop(): void;
}

interface ChatContextValue {
  engine: EngineLike | null;
  messages: DecryptedMessage[];
  status: 'guest' | 'ready' | 'broken';
  error: string | null;
  serverUrl: string | null;
  /** 演示模式：不加密、不联网，仅验证界面 */
  demo: boolean;
  register: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  send: (peerUserId: string, peerDeviceId: string, text: string) => Promise<void>;
  search: (query: string) => Promise<{ id: string; username: string }[]>;
  changeServer: (url: string) => Promise<void>;
  restoreServer: () => Promise<void>;
  enterDemo: () => Promise<void>;
  leaveDemo: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [status, setStatus] = useState<'guest' | 'ready' | 'broken'>('guest');
  const [demo, setDemo] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getServerUrl()
      .then((url) => {
        if (cancelled) return;
        setServerUrlState(url);
        try {
          setEngine(new ChatEngine(url));
        } catch (e) {
          void recordError('engine-init', e);
          setStatus('broken');
          setError('本地加密环境初始化失败：quick-crypto 或 SQLite 不可用');
        }
      })
      .catch((e) => void recordError('server-url', e));
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (!engine || started.current || demo) return;
    started.current = true;
    engine
      .restoreSession()
      .then(async (restored) => {
        if (!restored) return;
        await engine.start();
        setStatus('ready');
      })
      .catch((e) => {
        void recordError('restore', e);
      });
  }, [engine, demo]);

  const value = useMemo<ChatContextValue>(
    () => ({
      engine,
      messages,
      status,
      error,
      serverUrl,
      demo,
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
      async changeServer(url) {
        const next = url.trim();
        if (!next) throw new Error('地址不能为空');
        try {
          new URL(next);
        } catch {
          throw new Error('地址格式不正确，应形如 http://192.168.1.100:8787');
        }
        await setServerUrl(next);
        setServerUrlState(next);
        started.current = false;
        setMessages([]);
        setStatus('guest');
        setError(null);
        setDemo(false);
        engine?.stop();
        setEngine(new ChatEngine(next));
      },
      async restoreServer() {
        await resetServerUrl();
        const fallback = await getServerUrl();
        setServerUrlState(fallback);
        started.current = false;
        setMessages([]);
        setStatus('guest');
        setError(null);
        setDemo(false);
        engine?.stop();
        setEngine(new ChatEngine(fallback));
      },
      async enterDemo() {
        if (!isDevUnlocked()) throw new Error('未通过演示口令校验');
        started.current = true; // 演示模式不走会话恢复
        setMessages([]);
        setStatus('guest');
        setError(null);
        setDemo(true);
        engine?.stop();
        setEngine(new MockEngine());
      },
      async leaveDemo() {
        const url = serverUrl ?? (await getServerUrl());
        started.current = false;
        setMessages([]);
        setStatus('guest');
        setError(null);
        setDemo(false);
        engine?.stop();
        setEngine(new ChatEngine(url));
      },
    }),
    [engine, messages, status, error, serverUrl, demo],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat 必须在 ChatProvider 内使用');
  return context;
}
