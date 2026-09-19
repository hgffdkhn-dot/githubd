/**
 * 外观设置：主题色与深色模式
 *
 * 持久化到安全存储，切换后即时重建 Material 主题。
 */

import * as safeStore from '../storage/safeStore.js';
import { MD3LightTheme, MD3DarkTheme, type MD3Theme } from 'react-native-paper';
import type { SettingsState } from './types.js';

const KEY = 'e2ee.appearance';

/** 预设主题色：都保证与白色文字有足够对比度 */
export const COLOR_PRESETS: { id: string; name: string; seed: string }[] = [
  { id: 'purple', name: '紫罗兰', seed: 'rgb(103, 80, 164)' },
  { id: 'blue', name: '静谧蓝', seed: 'rgb(11, 92, 165)' },
  { id: 'teal', name: '湖水绿', seed: 'rgb(0, 105, 100)' },
  { id: 'green', name: '森野绿', seed: 'rgb(40, 106, 61)' },
  { id: 'orange', name: '暖阳橙', seed: 'rgb(163, 81, 23)' },
  { id: 'rose', name: '玫瑰红', seed: 'rgb(150, 45, 70)' },
];

export const DEFAULT_SETTINGS: SettingsState = {
  colorId: 'purple',
  darkMode: false,
};

type Listener = (state: SettingsState) => void;

const listeners = new Set<Listener>();
let current: SettingsState = DEFAULT_SETTINGS;

export function getSettings(): SettingsState {
  return current;
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function emit(next: SettingsState): Promise<void> {
  current = next;
  for (const l of listeners) l(next);
}

export async function loadSettings(): Promise<SettingsState> {
  const raw = await safeStore.getItem(KEY);
  if (!raw) {
    current = DEFAULT_SETTINGS;
    return current;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    current = {
      colorId: COLOR_PRESETS.some((c) => c.id === parsed.colorId)
        ? (parsed.colorId as string)
        : DEFAULT_SETTINGS.colorId,
      darkMode: parsed.darkMode === true,
    };
  } catch {
    current = DEFAULT_SETTINGS;
  }
  return current;
}

export async function updateSettings(patch: Partial<SettingsState>): Promise<SettingsState> {
  const next = { ...current, ...patch };
  await safeStore.setItem(KEY, JSON.stringify(next));
  await emit(next);
  return next;
}

function seedOf(colorId: string): string {
  return (COLOR_PRESETS.find((c) => c.id === colorId) ?? COLOR_PRESETS[0]).seed;
}

/** 由设置构建 Material 主题 */
export function buildTheme(state: SettingsState): MD3Theme {
  const base = state.darkMode ? MD3DarkTheme : MD3LightTheme;
  const primary = seedOf(state.colorId);
  return {
    ...base,
    colors: {
      ...base.colors,
      primary,
      // primaryContainer 需要跟随主色变化，否则界面几乎看不出换了颜色
      primaryContainer: state.darkMode ? withAlpha(primary, 0.32) : withAlpha(primary, 0.16),
      onPrimary: '#ffffff',
    },
  };
}

/** 解析 rgb(r, g, b) 并按透明度合成到背景色上 */
function withAlpha(color: string, alpha: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (!m) return color;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const bg = 255;
  const mix = (c: number) => Math.round(c * alpha + bg * (1 - alpha));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
