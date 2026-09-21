//! 端到端加密（协议 §5）：X25519 + HKDF-SHA256 + AES-256-GCM。
//!
//! 握手（PSK=accessToken，永不明文上链路）：
//!   client → daemon: {t:"auth.proof", pub, mac=HMAC(token, client_pub)}
//!   daemon → client: {t:"auth.ok",   pub, mac=HMAC(token, daemon_pub)}
//! 双向 HMAC 认证后各自以 ECDH 派生同一会话密钥；此后载荷全部走 enc 信封。
//! 中继只见到公钥与 HMAC，无私钥无从解密，也无法伪造（不知 token）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey};

const HKDF_INFO: &[u8] = b"remoteagent-payload-v1";
const NONCE_LEN: usize = 12;

type HmacSha256 = Hmac<Sha256>;

pub struct Handshake {
    secret: EphemeralSecret,
    pub public: PublicKey,
}

pub struct SessionCrypto {
    aead: Aes256Gcm,
}

fn hmac_b64(token: &str, data: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).unwrap();
    mac.update(data);
    STANDARD.encode(mac.finalize().into_bytes())
}

impl Handshake {
    pub fn start() -> Self {
        let secret = EphemeralSecret::random();
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// 客户端证明：HMAC(accessToken, client_pub)
    pub fn proof_json(&self, access_token: &str) -> String {
        serde_json::json!({
            "t": "auth.proof",
            "pub": STANDARD.encode(self.public.as_bytes()),
            "mac": hmac_b64(access_token, self.public.as_bytes()),
        })
        .to_string()
    }

    /// daemon 侧验证客户端证明，成功则生成自己的密钥对与应答。
    pub fn verify_client(access_token: &str, pub_b64: &str, mac_b64: &str) -> Result<(Self, String)> {
        let client_pub = decode_pub(pub_b64)?;
        let mut expect = HmacSha256::new_from_slice(access_token.as_bytes()).unwrap();
        expect.update(&client_pub);
        let mac = STANDARD
            .decode(mac_b64)
            .map_err(|_| anyhow!("bad mac base64"))?;
        expect
            .verify_slice(&mac)
            .map_err(|_| anyhow!("access token mismatch"))?;

        let hs = Handshake::start();
        let reply = serde_json::json!({
            "t": "auth.ok",
            "pub": STANDARD.encode(hs.public.as_bytes()),
            "mac": hmac_b64(access_token, hs.public.as_bytes()),
        })
        .to_string();
        Ok((hs, reply))
    }

    /// 客户端侧验证 daemon 应答的 mac（防中继伪造 daemon）。
    pub fn verify_peer_mac(&self, access_token: &str, peer_pub_b64: &str, peer_mac_b64: &str) -> Result<()> {
        let peer = decode_pub(peer_pub_b64)?;
        let mut expect = HmacSha256::new_from_slice(access_token.as_bytes()).unwrap();
        expect.update(&peer);
        let mac = STANDARD.decode(peer_mac_b64).map_err(|_| anyhow!("bad mac"))?;
        expect.verify_slice(&mac).map_err(|_| anyhow!("daemon auth failed"))
    }

    /// 用对端公钥完成握手，派生会话密钥。
    pub fn finish(self, peer_pub_b64: &str) -> Result<SessionCrypto> {
        let peer = PublicKey::from(decode_pub(peer_pub_b64)?);
        let shared = self.secret.diffie_hellman(&peer);
        let mut salt = Vec::with_capacity(64);
        salt.extend_from_slice(self.public.as_bytes());
        salt.extend_from_slice(peer.as_bytes());
        let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
        let mut key = [0u8; 32];
        hk.expand(HKDF_INFO, &mut key).expect("32 bytes");
        Ok(SessionCrypto {
            aead: Aes256Gcm::new((&key).into()),
        })
    }
}

impl SessionCrypto {
    /// 明文 JSON → enc 信封 JSON
    pub fn seal(&self, plaintext: &str) -> Result<String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce_bytes).map_err(|_| anyhow!("os entropy"))?;
        let ct = self
            .aead
            .encrypt((&nonce_bytes).into(), plaintext.as_bytes())
            .map_err(|_| anyhow!("encrypt failed"))?;
        Ok(serde_json::json!({
            "t": "enc",
            "nn": STANDARD.encode(nonce_bytes),
            "ct": STANDARD.encode(ct),
        })
        .to_string())
    }

    /// enc 信封 JSON → 明文 JSON
    pub fn open(&self, envelope: &str) -> Result<String> {
        let v: serde_json::Value = serde_json::from_str(envelope)?;
        if v["t"] != "enc" {
            bail!("not an enc envelope");
        }
        let nn = STANDARD.decode(v["nn"].as_str().unwrap_or_default())?;
        let ct = STANDARD.decode(v["ct"].as_str().unwrap_or_default())?;
        let nonce: [u8; NONCE_LEN] = nn.try_into().map_err(|_| anyhow!("bad nonce"))?;
        let pt = self
            .aead
            .decrypt((&nonce).into(), ct.as_slice())
            .map_err(|_| anyhow!("decrypt failed"))?;
        Ok(String::from_utf8(pt)?)
    }
}

fn decode_pub(b64: &str) -> Result<[u8; 32]> {
    let raw = STANDARD.decode(b64).map_err(|_| anyhow!("bad pub base64"))?;
    raw.try_into().map_err(|_| anyhow!("bad pub length"))
}
