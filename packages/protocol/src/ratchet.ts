/**
 * Double Ratchet（双棘轮）—— Signal 规范的核心会话算法
 *
 * 两条棘轮：
 * - 对称密钥棘轮：每条消息推进一次链，消息密钥用完即弃 → 前向安全
 * - Diffie-Hellman 棘轮：每次收发方向反转时引入新 DH 输出 → 后向安全（受损恢复）
 *
 * 本实现省略的部分（生产必须补齐，见 docs/THREAT-MODEL.md）：
 * - Header key 加密（Signal 的 AHEAD）：明文消息头会暴露 ratchet key 与序号，
 *   服务端虽不能解密正文，但能观察会话节奏。
 */

import {
  deriveKey,
  generateX25519KeyPair,
  hmacSha256,
  open,
  seal,
  wipe,
  x25519SharedSecret,
} from './primitives.js';
import { concat, fromBase64, readU32be, toBase64, u32be } from './encoding.js';
import {
  MAX_SKIP,
  MAX_SKIPPED_KEYS,
  type MessageHeader,
  type RatchetState,
  type SkippedKeyEntry,
} from './types.js';

const CHAIN_INPUT_MESSAGE = new Uint8Array([0x01]);
const CHAIN_INPUT_NEXT = new Uint8Array([0x02]);
const RATCHET_KDF = 'E2EEChat/DoubleRatchet/v1';

/** 链棘轮：一次推进产出一个消息密钥与下一条链密钥 */
function kdfChain(chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  return {
    messageKey: hmacSha256(chainKey, CHAIN_INPUT_MESSAGE),
    nextChainKey: hmacSha256(chainKey, CHAIN_INPUT_NEXT),
  };
}

/** 根棘轮：一次 DH 输出同时刷新根密钥与链密钥，旧链密钥不可推导 */
function kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const out = deriveKey(dhOutput, rootKey, `${RATCHET_KDF}/root-kdf`, 64);
  const nextRoot = out.slice(0, 32);
  const chainKey = out.slice(32, 64);
  return { rootKey: nextRoot, chainKey };
}

export function serializeHeader(header: MessageHeader): Uint8Array {
  return concat(header.ratchetPublic, u32be(header.messageNumber), u32be(header.previousChainLength));
}

export function deserializeHeader(bytes: Uint8Array): MessageHeader {
  if (bytes.length < 40) throw new Error('Ratchet: 消息头长度非法');
  return {
    ratchetPublic: bytes.slice(0, 32),
    messageNumber: readU32be(bytes, 32),
    previousChainLength: readU32be(bytes, 36),
  };
}

function key(ratchetPublic: Uint8Array, messageNumber: number): string {
  return `${toBase64(ratchetPublic)}:${messageNumber}`;
}

export class RatchetSession {
  private skipped = new Map<string, Uint8Array>();

  constructor(public state: RatchetState) {}

  /** 从持久化状态恢复时，需要把跳过的消息密钥一起灌回来 */
  restoreSkippedKeys(entries: SkippedKeyEntry[]): void {
    for (const e of entries) this.skipped.set(key(e.ratchetPublic, e.messageNumber), e.messageKey);
  }

  exportSkippedKeys(): SkippedKeyEntry[] {
    const out: SkippedKeyEntry[] = [];
    for (const [k, messageKey] of this.skipped) {
      const idx = k.lastIndexOf(':');
      out.push({
        ratchetPublic: fromBase64(k.slice(0, idx)),
        messageNumber: Number(k.slice(idx + 1)),
        messageKey,
      });
    }
    return out;
  }

  private skipMessageKeys(until: number): void {
    if (until - this.state.receiveMessageNumber > MAX_SKIP) {
      throw new Error(`Ratchet: 跳过消息数超过上限 ${MAX_SKIP}，拒绝处理`);
    }
    if (!this.state.receivingChainKey || !this.state.dhRemotePublic) return;

    while (this.state.receiveMessageNumber < until) {
      const { messageKey, nextChainKey } = kdfChain(this.state.receivingChainKey);
      this.skipped.set(key(this.state.dhRemotePublic, this.state.receiveMessageNumber), messageKey);
      this.state.receivingChainKey = nextChainKey;
      this.state.receiveMessageNumber += 1;
    }
    this.trimSkipped();
  }

  /** 跳过密钥必须设上限，否则恶意对端可让本地内存/数据库无界增长 */
  private trimSkipped(): void {
    while (this.skipped.size > MAX_SKIPPED_KEYS) {
      const oldest = this.skipped.keys().next();
      if (oldest.done) break;
      wipe(this.skipped.get(oldest.value)!);
      this.skipped.delete(oldest.value);
    }
  }

  private dhRatchet(header: MessageHeader): void {
    if (!this.state.rootKey) throw new Error('Ratchet: 缺少根密钥');

    this.state.previousChainLength = this.state.sendMessageNumber;
    this.state.sendMessageNumber = 0;
    this.state.receiveMessageNumber = 0;
    this.state.dhRemotePublic = header.ratchetPublic;

    const self = this.state.dhSelfPrivate;
    if (!self) throw new Error('Ratchet: 缺少本地棘轮私钥');

    // 接收链：用旧的本地密钥对
    const receive = kdfRoot(this.state.rootKey, x25519SharedSecret(self, header.ratchetPublic));
    this.state.rootKey = receive.rootKey;
    this.state.receivingChainKey = receive.chainKey;

    // 发送链：立即生成新密钥对，使下一条消息进入新棘轮轮次
    const next = generateX25519KeyPair();
    this.state.dhSelfPrivate = next.privateKey;
    this.state.dhSelfPublic = next.publicKey;
    const send = kdfRoot(this.state.rootKey, x25519SharedSecret(next.privateKey, header.ratchetPublic));
    this.state.rootKey = send.rootKey;
    this.state.sendingChainKey = send.chainKey;
  }

  /** 加密一条消息。每条消息使用全新消息密钥，nonce 随机且随密文传输 */
  async encrypt(plaintext: Uint8Array): Promise<{ header: MessageHeader; nonce: Uint8Array; ciphertext: Uint8Array }> {
    let sendingChainKey = this.state.sendingChainKey;
    if (!sendingChainKey || !this.state.dhSelfPublic) {
      // 首条回复场景：本地还没有发送链，先做一次 DH 棘轮建立
      if (!this.state.dhRemotePublic) throw new Error('Ratchet: 会话尚未建立');
      const next = generateX25519KeyPair();
      this.state.dhSelfPrivate = next.privateKey;
      this.state.dhSelfPublic = next.publicKey;
      const send = kdfRoot(this.state.rootKey, x25519SharedSecret(next.privateKey, this.state.dhRemotePublic));
      this.state.rootKey = send.rootKey;
      this.state.sendingChainKey = send.chainKey;
      this.state.previousChainLength = this.state.sendMessageNumber;
      this.state.sendMessageNumber = 0;
      sendingChainKey = send.chainKey;
    }

    const { messageKey, nextChainKey } = kdfChain(sendingChainKey);
    const header: MessageHeader = {
      ratchetPublic: this.state.dhSelfPublic,
      messageNumber: this.state.sendMessageNumber,
      previousChainLength: this.state.previousChainLength,
    };

    const ad = concat(serializeHeader(header), this.state.associatedData);
    const { ciphertext, nonce } = await seal(messageKey, plaintext, ad);

    this.state.sendingChainKey = nextChainKey;
    this.state.sendMessageNumber += 1;
    wipe(messageKey);

    return { header, nonce, ciphertext };
  }

  /** 解密一条消息。任何认证失败都会抛错，调用方必须终止并标记会话异常 */
  async decrypt(header: MessageHeader, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const skippedKeyId = key(header.ratchetPublic, header.messageNumber);
    const cached = this.skipped.get(skippedKeyId);
    if (cached) {
      const plaintext = await open(cached, nonce, ciphertext, concat(serializeHeader(header), this.state.associatedData));
      this.skipped.delete(skippedKeyId);
      wipe(cached);
      return plaintext;
    }

    const isNewRatchet =
      !this.state.dhRemotePublic ||
      header.ratchetPublic.length !== this.state.dhRemotePublic.length ||
      header.ratchetPublic.some((b, i) => b !== this.state.dhRemotePublic![i]);

    if (isNewRatchet) {
      if (!this.state.dhRemotePublic) {
        // X3DH 首包：对端棘轮公钥即其临时密钥，接收链已由 SK 派生，直接进入下一轮
        this.state.dhRemotePublic = header.ratchetPublic;
      } else {
        this.skipMessageKeys(header.previousChainLength);
        this.dhRatchet(header);
      }
    }

    this.skipMessageKeys(header.messageNumber);

    if (!this.state.receivingChainKey) throw new Error('Ratchet: 缺少接收链密钥');
    const { messageKey, nextChainKey } = kdfChain(this.state.receivingChainKey);
    const plaintext = await open(
      messageKey,
      nonce,
      ciphertext,
      concat(serializeHeader(header), this.state.associatedData),
    );

    this.state.receivingChainKey = nextChainKey;
    this.state.receiveMessageNumber += 1;
    wipe(messageKey);

    return plaintext;
  }
}
