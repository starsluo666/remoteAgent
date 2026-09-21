// E2E 加密（协议 §5）：与 daemon/src/crypto.rs 对应。
// X25519 + HKDF-SHA256 + AES-256-GCM；PSK = accessToken（只以 HMAC 形式上线）。

import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const HKDF_INFO = new TextEncoder().encode('remoteagent-payload-v1');

const b64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const unb64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const randBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

export class E2EClient {
  private key: Uint8Array | null = null;

  get established(): boolean {
    return this.key !== null;
  }

  /** 生成客户端密钥对与 auth.proof 消息（明文发送，含 HMAC 证明） */
  proofMessage(accessToken: string): string {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    (this as { priv?: Uint8Array }).priv = priv;
    const mac = hmac(sha256, new TextEncoder().encode(accessToken), pub);
    return JSON.stringify({ t: 'auth.proof', pub: b64(pub), mac: b64(mac) });
  }

  /** 校验 daemon 应答并派生会话密钥 */
  finish(accessToken: string, daemonPubB64: string, daemonMacB64: string): void {
    const daemonPub = unb64(daemonPubB64);
    const expect = hmac(sha256, new TextEncoder().encode(accessToken), daemonPub);
    const got = unb64(daemonMacB64);
    if (expect.length !== got.length || !expect.every((b, i) => b === got[i])) {
      throw new Error('daemon auth failed (bad mac)');
    }
    const priv = (this as { priv?: Uint8Array }).priv;
    if (!priv) throw new Error('handshake not started');
    const clientPub = x25519.getPublicKey(priv);
    const shared = x25519.getSharedSecret(priv, daemonPub);
    // 盐按角色定序：daemon_pub || client_pub（与 daemon/src/crypto.rs 一致）
    const salt = new Uint8Array(64);
    salt.set(daemonPub, 0);
    salt.set(clientPub, 32);
    this.key = new Uint8Array(hkdf(sha256, shared, salt, HKDF_INFO, 32));
    (this as { priv?: Uint8Array }).priv = undefined;
  }

  /** 明文 JSON 字符串 → enc 信封 JSON 字符串 */
  seal(plaintext: string): string {
    if (!this.key) throw new Error('E2E not established');
    const nonce = randBytes(12);
    const ct = gcm(this.key, nonce).encrypt(new TextEncoder().encode(plaintext));
    return JSON.stringify({ t: 'enc', nn: b64(nonce), ct: b64(ct) });
  }

  /** enc 信封 JSON 字符串 → 明文 JSON 字符串 */
  open(envelope: string): string {
    if (!this.key) throw new Error('E2E not established');
    const v = JSON.parse(envelope) as { t: string; nn: string; ct: string };
    if (v.t !== 'enc') throw new Error('not an enc envelope');
    const pt = gcm(this.key, unb64(v.nn)).decrypt(unb64(v.ct));
    return new TextDecoder().decode(pt);
  }
}
