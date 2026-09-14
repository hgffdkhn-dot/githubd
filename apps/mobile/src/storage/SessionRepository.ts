/** 把 SessionManager 的持久化需求接到 SQLite 上 */

import type { SessionRecord, SessionStore } from '@e2ee/protocol';
import { fromBase64, toBase64 } from '@e2ee/protocol';
import { deleteSession, loadSession, saveSession } from './Database.js';

export class SqliteSessionStore implements SessionStore {
  async load(peerKey: string): Promise<SessionRecord | undefined> {
    const stored = loadSession(peerKey);
    if (!stored) return undefined;

    return {
      state: stored.state,
      skippedKeys: stored.skippedKeys,
      pendingX3dh: stored.pendingX3dh ? deserializeX3dh(stored.pendingX3dh) : undefined,
    };
  }

  async save(peerKey: string, record: SessionRecord): Promise<void> {
    saveSession(
      peerKey,
      record.state,
      record.skippedKeys,
      record.pendingX3dh ? JSON.stringify(serializeX3dh(record)) : null,
    );
  }

  async remove(peerKey: string): Promise<void> {
    deleteSession(peerKey);
  }
}

/** Uint8Array 不能直接 JSON 序列化，先转成 base64 */
function serializeX3dh(record: SessionRecord): unknown {
  const x3dh = record.pendingX3dh!;
  return {
    identityKey: toBase64(x3dh.identityKey),
    signingKey: x3dh.signingKey ? toBase64(x3dh.signingKey) : undefined,
    ephemeralPublic: toBase64(x3dh.ephemeralPublic),
    usedOneTimePreKeyId: x3dh.usedOneTimePreKeyId,
    usedSignedPreKeyId: x3dh.usedSignedPreKeyId,
  };
}

export function deserializeX3dh(raw: string): NonNullable<SessionRecord['pendingX3dh']> {
  const parsed = JSON.parse(raw) as Record<string, string | number | undefined>;
  return {
    identityKey: fromBase64(String(parsed.identityKey)),
    signingKey: parsed.signingKey ? fromBase64(String(parsed.signingKey)) : undefined,
    ephemeralPublic: fromBase64(String(parsed.ephemeralPublic)),
    usedOneTimePreKeyId: parsed.usedOneTimePreKeyId as number | undefined,
    usedSignedPreKeyId: Number(parsed.usedSignedPreKeyId),
  };
}
