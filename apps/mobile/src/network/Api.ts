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
  }): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        deviceId: params.deviceId,
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
  }): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        deviceId: params.deviceId,
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

  async searchUsers(token: string, query: string): Promise<{ id: string; username: string }[]> {
    const result = await this.request<{ users: { id: string; username: string }[] }>(
      `/v1/users/search?q=${encodeURIComponent(query)}`,
      {},
      token,
    );
    return result.users;
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
}

export function generatePreKeyBundle(identity: LocalIdentity, spkId: number, startOpkId: number, count = 50) {
  return generatePreKeys(identity, spkId, startOpkId, count);
}
