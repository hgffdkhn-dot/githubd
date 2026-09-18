/**
 * 本地数据库
 *
 * 落库的内容：会话状态（受保护）、消息密文、投递状态、跳过密钥。
 * 绝不落库：明文正文、身份私钥（身份私钥在 Keychain 里）。
 *
 * 生产建议把 expo-sqlite 换成 op-sqlite(SQLCipher)，
 * 让整库由 Keystore 中的 DBKEK 加密；接口保持一致即可平滑替换。
 */

import type * as SQLite from 'expo-sqlite';
import { toBase64, fromBase64, type RatchetState, type SkippedKeyEntry } from '@e2ee/protocol';

// 延迟 require：原生模块顶层 import 在链接失败时会让整个 bundle 加载失败（白屏）
let sqliteModule: typeof SQLite | null = null;

function sqlite(): typeof SQLite {
  if (!sqliteModule) {
    sqliteModule = require('expo-sqlite') as typeof SQLite;
  }
  return sqliteModule;
}

let db: SQLite.SQLiteDatabase | null = null;

export function openDatabase(name = 'e2ee.db'): SQLite.SQLiteDatabase {
  if (db) return db;
  db = sqlite().openDatabaseSync(name);
  db.execSync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      peer_key TEXT PRIMARY KEY,
      root_key TEXT NOT NULL,
      dh_self_private TEXT,
      dh_self_public TEXT,
      dh_remote_public TEXT,
      sending_chain_key TEXT,
      receiving_chain_key TEXT,
      send_message_number INTEGER NOT NULL,
      receive_message_number INTEGER NOT NULL,
      previous_chain_length INTEGER NOT NULL,
      remote_identity_key TEXT NOT NULL,
      remote_signing_key TEXT NOT NULL,
      associated_data TEXT NOT NULL,
      pending_x3dh TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skipped_keys (
      peer_key TEXT NOT NULL,
      ratchet_public TEXT NOT NULL,
      message_number INTEGER NOT NULL,
      key_blob TEXT NOT NULL,
      PRIMARY KEY (peer_key, ratchet_public, message_number)
    );

    CREATE TABLE IF NOT EXISTS messages (
      envelope_id TEXT PRIMARY KEY,
      peer_key TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      header TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','failed')),
      plaintext_preview TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages (peer_key, created_at);
  `);
  return db;
}

export interface MessageRow {
  envelopeId: string;
  peerKey: string;
  direction: 'in' | 'out';
  ciphertext: string;
  nonce: string;
  header: string;
  createdAt: number;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
}

export function saveMessage(row: MessageRow): void {
  openDatabase().runSync(
    `INSERT OR REPLACE INTO messages
     (envelope_id, peer_key, direction, ciphertext, nonce, header, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.envelopeId, row.peerKey, row.direction, row.ciphertext, row.nonce, row.header, row.createdAt, row.status],
  );
}

export function updateMessageStatus(envelopeId: string, status: MessageRow['status']): void {
  openDatabase().runSync(`UPDATE messages SET status = ? WHERE envelope_id = ?`, [status, envelopeId]);
}

export function listMessages(peerKey: string): MessageRow[] {
  return openDatabase().getAllSync<MessageRow>(
    `SELECT * FROM messages WHERE peer_key = ? ORDER BY created_at ASC`,
    [peerKey],
  );
}

export function saveSession(
  peerKey: string,
  state: RatchetState,
  skipped: SkippedKeyEntry[],
  pendingX3dh: string | null,
): void {
  const database = openDatabase();
  database.withTransactionSync(() => {
    database.runSync(
      `INSERT OR REPLACE INTO sessions
       (peer_key, root_key, dh_self_private, dh_self_public, dh_remote_public,
        sending_chain_key, receiving_chain_key, send_message_number, receive_message_number,
        previous_chain_length, remote_identity_key, remote_signing_key, associated_data,
        pending_x3dh, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        peerKey,
        toBase64(state.rootKey),
        state.dhSelfPrivate ? toBase64(state.dhSelfPrivate) : null,
        state.dhSelfPublic ? toBase64(state.dhSelfPublic) : null,
        state.dhRemotePublic ? toBase64(state.dhRemotePublic) : null,
        state.sendingChainKey ? toBase64(state.sendingChainKey) : null,
        state.receivingChainKey ? toBase64(state.receivingChainKey) : null,
        state.sendMessageNumber,
        state.receiveMessageNumber,
        state.previousChainLength,
        toBase64(state.remoteIdentity.identityKey),
        toBase64(state.remoteIdentity.signingKey),
        toBase64(state.associatedData),
        pendingX3dh,
        Date.now(),
      ],
    );

    database.runSync(`DELETE FROM skipped_keys WHERE peer_key = ?`, [peerKey]);
    for (const entry of skipped) {
      database.runSync(
        `INSERT OR REPLACE INTO skipped_keys (peer_key, ratchet_public, message_number, key_blob)
         VALUES (?, ?, ?, ?)`,
        [peerKey, toBase64(entry.ratchetPublic), entry.messageNumber, toBase64(entry.messageKey)],
      );
    }
  });
}

export interface StoredSession {
  state: RatchetState;
  skippedKeys: SkippedKeyEntry[];
  pendingX3dh?: string | null;
}

export function loadSession(peerKey: string): StoredSession | undefined {
  const database = openDatabase();
  const row = database.getFirstSync<Record<string, string | number | null>>(
    `SELECT * FROM sessions WHERE peer_key = ?`,
    [peerKey],
  );
  if (!row) return undefined;

  const b64 = (value: unknown): Uint8Array | undefined =>
    typeof value === 'string' && value.length > 0 ? fromBase64(value) : undefined;

  const skippedRows = database.getAllSync<{
    ratchet_public: string;
    message_number: number;
    key_blob: string;
  }>(
    `SELECT * FROM skipped_keys WHERE peer_key = ?`,
    [peerKey],
  );

  return {
    state: {
      rootKey: fromBase64(String(row.root_key)),
      dhSelfPrivate: b64(row.dh_self_private),
      dhSelfPublic: b64(row.dh_self_public),
      dhRemotePublic: b64(row.dh_remote_public),
      sendingChainKey: b64(row.sending_chain_key),
      receivingChainKey: b64(row.receiving_chain_key),
      sendMessageNumber: Number(row.send_message_number),
      receiveMessageNumber: Number(row.receive_message_number),
      previousChainLength: Number(row.previous_chain_length),
      remoteIdentity: {
        identityKey: fromBase64(String(row.remote_identity_key)),
        signingKey: fromBase64(String(row.remote_signing_key)),
      },
      associatedData: fromBase64(String(row.associated_data)),
    },
    skippedKeys: skippedRows.map((r) => ({
      ratchetPublic: fromBase64(r.ratchet_public),
      messageNumber: Number(r.message_number),
      messageKey: fromBase64(r.key_blob),
    })),
    pendingX3dh: row.pending_x3dh ? String(row.pending_x3dh) : null,
  };
}

export function deleteSession(peerKey: string): void {
  const database = openDatabase();
  database.withTransactionSync(() => {
    database.runSync(`DELETE FROM sessions WHERE peer_key = ?`, [peerKey]);
    database.runSync(`DELETE FROM skipped_keys WHERE peer_key = ?`, [peerKey]);
    database.runSync(`DELETE FROM messages WHERE peer_key = ?`, [peerKey]);
  });
}
