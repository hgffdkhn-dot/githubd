/**
 * Safety Number（安全码）—— 用户可人工比对的会话指纹
 *
 * 作用：让用户通过带外通道（面对面扫码、语音核对）确认身份公钥未被替换。
 * 局限：它证明的是"此刻双方持有的身份公钥一致"，不能证明设备未被入侵，
 *      也不能防御历史备份被导入后的变更。产品文案不得夸大其保证范围。
 */

import { deriveKey } from './primitives.js';
import { concat } from './encoding.js';

const GROUPS = 12;

function sorted(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? concat(a, b) : concat(b, a);
  }
  return concat(a, b);
}

/** 生成 12 组 5 位数字，共 60 位，与 Signal 的展示形态一致 */
export function computeSafetyNumber(localIdentityKey: Uint8Array, remoteIdentityKey: Uint8Array): string {
  const derived = deriveKey(sorted(localIdentityKey, remoteIdentityKey), new Uint8Array(32), 'E2EEChat/safety-number/v1', GROUPS * 4);
  const view = new DataView(derived.buffer, derived.byteOffset, derived.byteLength);
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(String(view.getUint32(i * 4, false) % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** 变化历史：只保留哈希，不保留原始密钥 */
export function safetyNumberFingerprint(safetyNumber: string): Uint8Array {
  return deriveKey(new TextEncoder().encode(safetyNumber), new Uint8Array(32), 'E2EEChat/fingerprint/v1', 16);
}
