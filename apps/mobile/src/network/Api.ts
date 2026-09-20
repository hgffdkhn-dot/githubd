/**
 * 服务端 API 客户端
 *
 * 所有请求只发送"公开材料 + 密文"。
 * 任何打算往这里加明文字段的改动，都是在摧毁 E2EE 的承诺。
 */

import {
  toBase64,
  fromBase64,
  generatePreKeys,
  type GeneratedPreKeys,
  type LocalIdentity,
  type PreKeyBundle,
  type EnvelopeDto,
} from '@e2ee/protocol';
import { describeNetworkFailure } from './serverConfig.js';

export interface AuthResult {
  userId: string;
  deviceId: string;
  token: string;
  /** 服务端分配的 6 位 UID；老版本服务端可能不返回 */
  uid?: string;
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      // 原生 fetch 对连接失败只给一句 "Network request failed"，看不出原因
      throw new Error(describeNetworkFailure(this.baseUrl));
    }

    if (!response.ok) {
      throw new Error(`API ${path} 失败: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async register(params: {
    username: string;
    password: string;
    deviceId: string;
    identity: LocalIdentity;
    preKeys: GeneratedPreKeys;
    /** 设备型号等展示信息；不传服务端会显示"未命名设备" */
    deviceLabel?: string;
    devicePlatform?: string;
  }): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        deviceId: params.deviceId,
        deviceLabel: params.deviceLabel,
        devicePlatform: params.devicePlatform,
        identityKey: toBase64(params.identity.identityKey),
        signingKey: toBase64(params.identity.signingKey),
        signedPreKey: {
          keyId: params.preKeys.signedPreKey.keyId,
          publicKey: toBase64(params.preKeys.signedPreKey.publicKey),
          signature: toBase64(params.preKeys.signedPreKey.signature),
        },
        oneTimePreKeys: params.preKeys.oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          publicKey: toBase64(k.publicKey),
        })),
      }),
    });
  }

  async login(params: {
    username: string;
    password: string;
    deviceId: string;
    identity: LocalIdentity;
    deviceLabel?: string;
    devicePlatform?: string;
  }): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        deviceId: params.deviceId,
        deviceLabel: params.deviceLabel,
        devicePlatform: params.devicePlatform,
        identityKey: toBase64(params.identity.identityKey),
        signingKey: toBase64(params.identity.signingKey),
      }),
    });
  }

  async publishPreKeys(
    token: string,
    bundle: { signedPreKey?: GeneratedPreKeys['signedPreKey']; oneTimePreKeys?: GeneratedPreKeys['oneTimePreKeys'] },
  ): Promise<{ oneTimePreKeyCount: number; low: boolean }> {
    return this.request(
      '/v1/prekeys/publish',
      {
        method: 'POST',
        body: JSON.stringify({
          signedPreKey: bundle.signedPreKey
            ? {
                keyId: bundle.signedPreKey.keyId,
                publicKey: toBase64(bundle.signedPreKey.publicKey),
                signature: toBase64(bundle.signedPreKey.signature),
              }
            : undefined,
          oneTimePreKeys: bundle.oneTimePreKeys?.map((k) => ({
            keyId: k.keyId,
            publicKey: toBase64(k.publicKey),
          })),
        }),
      },
      token,
    );
  }

  async fetchBundle(token: string, userId: string, deviceId: string): Promise<PreKeyBundle> {
    const raw = await this.request<{
      userId: string;
      deviceId: string;
      identityKey: string;
      signingKey: string;
      signedPreKey: { keyId: number; publicKey: string; signature: string };
      oneTimePreKey: { keyId: number; publicKey: string } | null;
    }>(`/v1/prekeys/bundle/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`, {}, token);

    return {
      userId: raw.userId,
      deviceId: raw.deviceId,
      identityKey: fromBase64(raw.identityKey),
      signingKey: fromBase64(raw.signingKey),
      signedPreKey: {
        keyId: raw.signedPreKey.keyId,
        publicKey: fromBase64(raw.signedPreKey.publicKey),
        signature: fromBase64(raw.signedPreKey.signature),
      },
      oneTimePreKey: raw.oneTimePreKey
        ? { keyId: raw.oneTimePreKey.keyId, publicKey: fromBase64(raw.oneTimePreKey.publicKey) }
        : undefined,
    };
  }

  async listDevices(
    token: string,
    userId: string,
  ): Promise<{ deviceId: string; identityKey: string; signingKey: string }[]> {
    const result = await this.request<{ devices: { deviceId: string; identityKey: string; signingKey: string }[] }>(
      `/v1/devices/${encodeURIComponent(userId)}`,
      {},
      token,
    );
    return result.devices;
  }

  async searchUsers(
    token: string,
    query: string,
  ): Promise<{ id: string; username: string; uid: string }[]> {
    const result = await this.request<{ users: { id: string; username: string; uid: string }[] }>(
      `/v1/users/search?q=${encodeURIComponent(query)}`,
      {},
      token,
    );
    return result.users.map((u) => ({ id: u.id, username: u.username, uid: u.uid ?? '' }));
  }

  async sendEnvelope(token: string, envelope: EnvelopeDto): Promise<{ envelopeId: string; queued: boolean }> {
    return this.request('/v1/messages', { method: 'POST', body: JSON.stringify(envelope) }, token);
  }

  async fetchPending(token: string): Promise<EnvelopeDto[]> {
    const result = await this.request<{ envelopes: EnvelopeDto[] }>('/v1/messages/pending', {}, token);
    return result.envelopes;
  }

  async acknowledge(token: string, envelopeIds: string[]): Promise<void> {
    if (envelopeIds.length === 0) return;
    await this.request('/v1/messages/ack', {
      method: 'POST',
      body: JSON.stringify({ envelopeIds }),
    }, token);
  }

  // ------------------------------------------------------------------
  // 设备管理（设置 → 隐私 → 设备管理）
  // ------------------------------------------------------------------

  async listMyDevices(token: string): Promise<MyDevice[]> {
    const result = await this.request<{ devices: MyDevice[] }>('/v1/devices/mine', {}, token);
    return result.devices;
  }

  async revokeDevice(token: string, deviceId: string): Promise<void> {
    await this.request(
      '/v1/devices/revoke',
      { method: 'POST', body: JSON.stringify({ deviceId }) },
      token,
    );
  }

  /**
   * 上报/更新本设备的展示名称
   *
   * 会话恢复路径（restoreSession）不会走 register/login，
   * 所以老版本的设备名永远得不到更新，设备管理里就一直显示占位文案。
   * 这里单独提供一个接口，让任何登录态都能刷新设备名。
   */
  async updateDeviceLabel(
    token: string,
    deviceId: string,
    label: string,
    platform: string,
  ): Promise<void> {
    await this.request(
      '/v1/devices/label',
      { method: 'POST', body: JSON.stringify({ deviceId, label, platform }) },
      token,
    );
  }

  /** 按 userId 查基本信息，用于回填会话列表里显示不出的用户名 */
  async getUserById(token: string, userId: string): Promise<{ id: string; username: string; uid: string } | null> {
    const result = await this.request<{ user: { id: string; username: string; uid: string } | null }>(
      `/v1/users/${encodeURIComponent(userId)}`,
      {},
      token,
    );
    return result.user;
  }

  // ------------------------------------------------------------------
  // 个人主页
  // ------------------------------------------------------------------

  async getMyProfile(token: string): Promise<OwnProfileDto> {
    const result = await this.request<{ profile: OwnProfileDto; uid?: string | null }>(
      '/v1/profile',
      {},
      token,
    );
    // 老账号本地没缓存 UID，服务端会在读取资料时一并给出
    return { ...result.profile, uid: result.uid ?? result.profile.uid ?? null };
  }

  async putMyProfile(token: string, body: PutProfileBody): Promise<{ updatedAt: number }> {
    return this.request<{ ok: boolean; updatedAt: number }>(
      '/v1/profile',
      { method: 'PUT', body: JSON.stringify(body) },
      token,
    );
  }

  async getUserProfile(token: string, userId: string): Promise<PeerProfileDto | null> {
    const result = await this.request<{ profile: PeerProfileDto | null }>(
      `/v1/profile/user/${encodeURIComponent(userId)}`,
      {},
      token,
    );
    return result.profile;
  }

  // ------------------------------------------------------------------
  // 在线状态
  // ------------------------------------------------------------------

  async heartbeat(token: string, visible: boolean): Promise<void> {
    await this.request(
      '/v1/presence/heartbeat',
      { method: 'POST', body: JSON.stringify({ visible }) },
      token,
    );
  }

  async fetchPresence(token: string, userIds: string[]): Promise<Record<string, PresenceEntry>> {
    if (userIds.length === 0) return {};
    const ids = userIds.slice(0, 200).map(encodeURIComponent).join(',');
    const result = await this.request<{ presence: Record<string, PresenceEntry> }>(
      `/v1/presence?ids=${ids}`,
      {},
      token,
    );
    return result.presence;
  }
}

export interface MyDevice {
  id: string;
  label: string;
  platform: string;
  createdAt: number;
  lastSeen: number;
  revokedAt?: number;
  current: boolean;
}

export interface PresenceEntry {
  online: boolean;
  lastSeen: number;
  hidden: boolean;
}

export interface OwnProfileDto {
  userId: string;
  /** 服务端返回的 UID，可能为 null（老账号且服务端过旧） */
  uid?: string | null;
  visibility: 'friends' | 'public';
  encrypted?: { nonce: string; ciphertext: string };
  publicFields?: { displayName: string; bio: string };
  updatedAt: number;
}

export interface PeerProfileDto {
  visibility: 'friends' | 'public';
  displayName?: string;
  bio?: string;
  encrypted?: { nonce: string; ciphertext: string };
  updatedAt: number;
}

export interface PutProfileBody {
  visibility: 'friends' | 'public';
  encrypted?: { nonce: string; ciphertext: string };
  publicFields?: { displayName: string; bio: string };
}

export function generatePreKeyBundle(identity: LocalIdentity, spkId: number, startOpkId: number, count = 50) {
  return generatePreKeys(identity, spkId, startOpkId, count);
}
