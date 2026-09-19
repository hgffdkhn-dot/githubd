/**
 * 个人主页管理
 *
 * friends 模式：昵称/简介/头像只以密文上传，服务端无法读取
 * public 模式：明文上传，任何人搜索可见 —— 切换时明确提示用户
 */

import type { ApiClient, OwnProfileDto, PeerProfileDto } from '../network/Api.js';
import {
  ownProfileKey,
  peerProfileKey,
  sealProfile,
  openProfile,
  initialOf,
  avatarColorFor,
  type ProfilePayload,
} from './profileCrypto.js';

export interface ResolvedProfile {
  displayName: string;
  bio: string;
  avatarBg: string;
  avatarInitial: string;
  /** 资料来自哪种可见性；friends 且未建立会话时无法解密 */
  visibility: 'friends' | 'public';
  /** friends 模式下资料不可读（尚未建立会话） */
  locked: boolean;
}

function emptyProfile(userId: string): ResolvedProfile {
  return {
    displayName: '',
    bio: '',
    avatarBg: avatarColorFor(userId),
    avatarInitial: '?',
    visibility: 'friends',
    locked: false,
  };
}

export class ProfileManager {
  constructor(
    private readonly api: ApiClient,
    private readonly identity: { identityPrivateKey: Uint8Array },
  ) {}

  /** 读取自己的资料（服务端只存密文，本地解开） */
  async loadOwn(userId: string): Promise<ResolvedProfile & { visibility: 'friends' | 'public' }> {
    const dto = await this.api.getMyProfile(await this.token());
    if (dto.visibility === 'public' && dto.publicFields) {
      const name = dto.publicFields.displayName || '';
      return {
        displayName: name,
        bio: dto.publicFields.bio || '',
        avatarBg: avatarColorFor(userId),
        avatarInitial: initialOf(name, '?'),
        visibility: 'public',
        locked: false,
      };
    }
    const payload = dto.encrypted
      ? await openProfile(ownProfileKey(this.identity.identityPrivateKey), dto.encrypted)
      : null;

    if (!payload) return { ...emptyProfile(userId), visibility: dto.visibility };
    return {
      displayName: payload.displayName,
      bio: payload.bio,
      avatarBg: payload.avatarBg,
      avatarInitial: payload.avatarInitial || initialOf(payload.displayName, '?'),
      visibility: dto.visibility,
      locked: false,
    };
  }

  async saveOwn(
    userId: string,
    input: { displayName: string; bio: string },
    visibility: 'friends' | 'public',
  ): Promise<void> {
    const payload: ProfilePayload = {
      displayName: input.displayName.trim().slice(0, 64),
      bio: input.bio.trim().slice(0, 300),
      avatarBg: avatarColorFor(userId),
      avatarInitial: initialOf(input.displayName, '?'),
    };

    if (visibility === 'public') {
      if (!payload.displayName) throw new Error('公开模式需要填写昵称');
      await this.api.putMyProfile(await this.token(), {
        visibility: 'public',
        publicFields: { displayName: payload.displayName, bio: payload.bio },
      });
      return;
    }

    // friends 模式：密文上传，服务端拿不到明文
    const enc = await sealProfile(ownProfileKey(this.identity.identityPrivateKey), payload);
    await this.api.putMyProfile(await this.token(), { visibility: 'friends', encrypted: enc });
  }

  /**
   * 读取好友资料
   *
   * friends 模式需要「自己私钥 × 对方公钥」派生的密钥；
   * 没有对方身份公钥（尚未建立会话）时只能显示锁定态。
   */
  async loadPeer(userId: string, peerIdentityPublic?: Uint8Array): Promise<ResolvedProfile> {
    const dto: PeerProfileDto | null = await this.api.getUserProfile(await this.token(), userId);
    if (!dto) return emptyProfile(userId);

    if (dto.visibility === 'public') {
      const name = dto.displayName || '';
      return {
        displayName: name,
        bio: dto.bio || '',
        avatarBg: avatarColorFor(userId),
        avatarInitial: initialOf(name, '?'),
        visibility: 'public',
        locked: false,
      };
    }

    if (!peerIdentityPublic) {
      // 还没握过手，拿不到对方身份公钥 → 无法解密，明确显示锁定
      return { ...emptyProfile(userId), visibility: 'friends', locked: true };
    }

    const payload = await openProfile(
      peerProfileKey(this.identity.identityPrivateKey, peerIdentityPublic),
      dto.encrypted,
    );
    if (!payload) return { ...emptyProfile(userId), visibility: 'friends', locked: true };

    return {
      displayName: payload.displayName,
      bio: payload.bio,
      avatarBg: payload.avatarBg || avatarColorFor(userId),
      avatarInitial: payload.avatarInitial || initialOf(payload.displayName, '?'),
      visibility: 'friends',
      locked: false,
    };
  }

  /** token 由外部注入，避免 Manager 持有会话状态 */
  private tokenProvider: () => Promise<string> = async () => '';

  setTokenProvider(provider: () => Promise<string>): void {
    this.tokenProvider = provider;
  }

  private async token(): Promise<string> {
    return this.tokenProvider();
  }
}
