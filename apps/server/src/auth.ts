/**
 * 口令处理
 *
 * E2EE 服务端的口令只用于"证明你是这个账号"，不参与任何密钥派生。
 * 若把口令派生出的材料用于加密，服务端或中间人就能离线爆破 —— 这是 E2EE 项目最典型的越界。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, KEYLEN);
  return { salt, hash: hash.toString('hex') };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await scrypt(password, salt, KEYLEN);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
