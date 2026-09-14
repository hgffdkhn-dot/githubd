/** 协议层共享类型：客户端与服务端只交换这里定义的"可公开"字段 */

export interface PublicIdentity {
  /** X25519 身份公钥，用于 DH */
  identityKey: Uint8Array;
  /** Ed25519 签名公钥，用于校验 SPK 签名 */
  signingKey: Uint8Array;
}

export interface LocalIdentity extends PublicIdentity {
  identityPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
}

export interface SignedPreKey {
  keyId: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export interface OneTimePreKey {
  keyId: number;
  publicKey: Uint8Array;
}

/** 上传给服务端的完整 PreKey Bundle —— 全部为公开材料 */
export interface PreKeyBundleUpload {
  userId: string;
  deviceId: string;
  identityKey: Uint8Array;
  signingKey: Uint8Array;
  signedPreKey: SignedPreKey;
  oneTimePreKeys: OneTimePreKey[];
}

/** 服务端下发给发起方的 Bundle —— OPK 至多一个，被认领后服务端立即删除 */
export interface PreKeyBundle {
  userId: string;
  deviceId: string;
  identityKey: Uint8Array;
  signingKey: Uint8Array;
  signedPreKey: SignedPreKey;
  oneTimePreKey?: OneTimePreKey;
}

/** X3DH 握手结果：SK 只存在于内存，绝不落库、绝不上网 */
export interface X3dhResult {
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array;
  /** 关联数据，绑定双方身份公钥，防止身份替换 */
  associatedData: Uint8Array;
  ephemeralPublic: Uint8Array;
  usedOneTimePreKeyId?: number;
}

/** Double Ratchet 消息头，明文传输（Signal 规范中另有 header key 加密，见文档说明） */
export interface MessageHeader {
  /** 发送方当前棘轮公钥 */
  ratchetPublic: Uint8Array;
  /** 当前发送链中的消息序号 */
  messageNumber: number;
  /** 上一个发送链的长度，用于计算跳过的消息数 */
  previousChainLength: number;
}

/** 端到端加密信封：服务端与数据库只能看到这个结构 */
export interface Envelope {
  envelopeId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  /** X3DH 首次握手时携带的发起方信息，后续消息为空 */
  x3dh?: {
    identityKey: Uint8Array;
    signingKey?: Uint8Array;
    ephemeralPublic: Uint8Array;
    usedOneTimePreKeyId?: number;
    usedSignedPreKeyId: number;
  };
  header: MessageHeader;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  createdAt: number;
}

/** 会话持久化状态 —— 客户端保存时必须由 Keystore 密钥加密 */
export interface RatchetState {
  rootKey: Uint8Array;
  dhSelfPrivate?: Uint8Array;
  dhSelfPublic?: Uint8Array;
  dhRemotePublic?: Uint8Array;
  sendingChainKey?: Uint8Array;
  receivingChainKey?: Uint8Array;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousChainLength: number;
  remoteIdentity: PublicIdentity;
  associatedData: Uint8Array;
}

export interface SkippedKeyEntry {
  ratchetPublic: Uint8Array;
  messageNumber: number;
  messageKey: Uint8Array;
}

export const MAX_SKIP = 200;
export const MAX_SKIPPED_KEYS = 2000;
