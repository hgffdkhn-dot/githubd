/**
 * 信封的 JSON 序列化
 *
 * 服务端只会看到这个 DTO：没有明文字段、没有会话状态、没有私钥。
 * 服务端 schema 应当显式拒绝任何 plaintext / identityPrivateKey 之类的字段。
 */

import { fromBase64, toBase64 } from './encoding.js';
import type { Envelope } from './types.js';

export interface EnvelopeDto {
  envelopeId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  x3dh?: {
    identityKey: string;
    signingKey?: string;
    ephemeralPublic: string;
    usedOneTimePreKeyId?: number;
    usedSignedPreKeyId: number;
  };
  header: { ratchetPublic: string; messageNumber: number; previousChainLength: number };
  nonce: string;
  ciphertext: string;
  createdAt: number;
}

export function encodeEnvelope(envelope: Envelope): EnvelopeDto {
  return {
    envelopeId: envelope.envelopeId,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    recipientUserId: envelope.recipientUserId,
    recipientDeviceId: envelope.recipientDeviceId,
    x3dh: envelope.x3dh
      ? {
          identityKey: toBase64(envelope.x3dh.identityKey),
          signingKey: envelope.x3dh.signingKey ? toBase64(envelope.x3dh.signingKey) : undefined,
          ephemeralPublic: toBase64(envelope.x3dh.ephemeralPublic),
          usedOneTimePreKeyId: envelope.x3dh.usedOneTimePreKeyId,
          usedSignedPreKeyId: envelope.x3dh.usedSignedPreKeyId,
        }
      : undefined,
    header: {
      ratchetPublic: toBase64(envelope.header.ratchetPublic),
      messageNumber: envelope.header.messageNumber,
      previousChainLength: envelope.header.previousChainLength,
    },
    nonce: toBase64(envelope.nonce),
    ciphertext: toBase64(envelope.ciphertext),
    createdAt: envelope.createdAt,
  };
}

export function decodeEnvelope(dto: EnvelopeDto): Envelope {
  return {
    envelopeId: dto.envelopeId,
    senderUserId: dto.senderUserId,
    senderDeviceId: dto.senderDeviceId,
    recipientUserId: dto.recipientUserId,
    recipientDeviceId: dto.recipientDeviceId,
    x3dh: dto.x3dh
      ? {
          identityKey: fromBase64(dto.x3dh.identityKey),
          signingKey: dto.x3dh.signingKey ? fromBase64(dto.x3dh.signingKey) : undefined,
          ephemeralPublic: fromBase64(dto.x3dh.ephemeralPublic),
          usedOneTimePreKeyId: dto.x3dh.usedOneTimePreKeyId,
          usedSignedPreKeyId: dto.x3dh.usedSignedPreKeyId,
        }
      : undefined,
    header: {
      ratchetPublic: fromBase64(dto.header.ratchetPublic),
      messageNumber: dto.header.messageNumber,
      previousChainLength: dto.header.previousChainLength,
    },
    nonce: fromBase64(dto.nonce),
    ciphertext: fromBase64(dto.ciphertext),
    createdAt: dto.createdAt,
  };
}

/** 服务端自检用：DTO 中不得出现任何私有材料字段 */
export function assertNoPrivateMaterial(dto: Record<string, unknown>): void {
  const forbidden = ['plaintext', 'messageText', 'identityPrivateKey', 'signingPrivateKey', 'sessionKey', 'rootKey', 'sk'];
  for (const field of forbidden) {
    if (field in dto) throw new Error(`信封包含禁止字段: ${field}`);
  }
}
