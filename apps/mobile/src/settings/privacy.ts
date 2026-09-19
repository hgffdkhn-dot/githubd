/**
 * 隐私设置：是否向他人展示自己的在线动态
 *
 * 默认开启（社交软件常见行为），但用户可随时关闭。
 * 关闭后服务端不保存可见时间戳，对查询方返回"不显示"。
 */

import * as safeStore from '../storage/safeStore.js';

const KEY = 'e2ee.privacy.presence';

export interface PrivacyState {
  /** 是否展示自己的在线动态 */
  shareOnline: boolean;
}

export const DEFAULT_PRIVACY: PrivacyState = { shareOnline: true };

export async function loadPrivacy(): Promise<PrivacyState> {
  const raw = await safeStore.getItem(KEY);
  if (!raw) return DEFAULT_PRIVACY;
  try {
    const parsed = JSON.parse(raw) as Partial<PrivacyState>;
    return { shareOnline: parsed.shareOnline !== false };
  } catch {
    return DEFAULT_PRIVACY;
  }
}

export async function savePrivacy(state: PrivacyState): Promise<void> {
  await safeStore.setItem(KEY, JSON.stringify(state));
}
