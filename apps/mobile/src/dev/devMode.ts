/**
 * 演示模式（开发模式）
 *
 * 目的：在没有服务端的情况下也能验证 UI 与交互流程。
 * 它**完全绕过端到端加密**——消息不加密、密钥不生成、服务端不参与。
 *
 * ⚠️ 安全要求：
 *  - 进入需要密码，避免普通用户误入后误以为在用真实加密聊天
 *  - 进入后界面全程显示"演示模式"横幅
 *  - 正式发布前应移除整个 src/dev，或至少移除登录页入口
 */

/** 进入演示模式的口令 */
export const DEV_PASSWORD = 'E2EE-DEV-2026-K7x9Qm';

/** 一次会话内只需输入一次 */
let unlocked = false;

export function isDevUnlocked(): boolean {
  return unlocked;
}

/** 口令比对（去掉首尾空格，大小写不敏感，方便输入） */
export function tryUnlock(input: string): boolean {
  const ok = input.trim().toLowerCase() === DEV_PASSWORD.toLowerCase();
  if (ok) unlocked = true;
  return ok;
}

export function lockDev(): void {
  unlocked = false;
}
