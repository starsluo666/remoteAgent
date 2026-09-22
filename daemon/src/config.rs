//! 设备身份：deviceId + 中继密钥 + 访问 token，落盘 ~/.remoteagent/identity.json。
//! - relay_key：daemon 向中继注册的身份（中继可见）。
//! - access_token：客户端配对凭据，**永不明文上链路**，只以 HMAC 证明形式出现。
//! 两者独立轮换：--rotate-access-token 只换 access_token，中继注册不受影响。

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub device_id: String,
    pub relay_key: String,
    pub access_token: String,
}

fn identity_path() -> Result<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .context("no home directory")?;
    let dir = PathBuf::from(home).join(".remoteagent");
    fs::create_dir_all(&dir).context("create ~/.remoteagent")?;
    Ok(dir.join("identity.json"))
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// 设备号：随机 9 位数字（首位非零）。设备 ID 非机密（真正的凭据是
/// access_token，E2E HMAC 验证），9 位数字便于口头/手动输入；
/// 冲突空间 10^9，自建中继规模下可忽略（撞号注册会被拒绝，可再换）。
fn new_device_id() -> String {
    let n = (uuid::Uuid::new_v4().as_u128() % 900_000_000) + 100_000_000;
    n.to_string()
}

/// 重设设备号（换新 9 位随机数字；旧配对链接里的 device 参数随之失效）
pub fn reset_device_id() -> Result<Identity> {
    let mut id = load_or_create()?;
    id.device_id = new_device_id();
    let path = identity_path()?;
    fs::write(&path, serde_json::to_string_pretty(&id)?).context("write identity.json")?;
    Ok(id)
}

pub fn load_or_create() -> Result<Identity> {
    let path = identity_path()?;

    // M2 旧格式迁移：token → relay_key，补生成 access_token
    if path.exists() {
        let raw = fs::read_to_string(&path).context("read identity.json")?;
        let mut v: serde_json::Value = serde_json::from_str(&raw).context("parse identity.json")?;
        if v.get("access_token").is_none() {
            v["access_token"] = serde_json::json!(new_token());            if v.get("relay_key").is_none() {
                v["relay_key"] = v["token"].clone();
            }
            fs::write(&path, serde_json::to_string_pretty(&v)?)?;
            tracing::info!("identity migrated to split-token format");
        }
        let id: Identity = serde_json::from_value(v).context("parse identity.json")?;
        return Ok(id);
    }

    let id = Identity {
        device_id: new_device_id(),
        relay_key: new_token(),
        access_token: new_token(),
    };
    fs::write(&path, serde_json::to_string_pretty(&id)?).context("write identity.json")?;
    tracing::info!(path = %path.display(), "created new device identity");
    Ok(id)
}

/// 轮换访问 token（客户端旧配对链接立即失效）
pub fn rotate_access_token() -> Result<Identity> {
    let mut id = load_or_create()?;
    id.access_token = new_token();
    let path = identity_path()?;
    fs::write(&path, serde_json::to_string_pretty(&id)?).context("write identity.json")?;
    Ok(id)
}

/// 设置自定义访问 token（用户口令，最短 8 位；长度与字符校验由调用方负责）
pub fn set_access_token(token: &str) -> Result<Identity> {
    let mut id = load_or_create()?;
    id.access_token = token.to_string();
    let path = identity_path()?;
    fs::write(&path, serde_json::to_string_pretty(&id)?).context("write identity.json")?;
    Ok(id)
}

/// 运行设置：界面里配置的中继列表，重启后自动恢复连接（active 指向恢复目标）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// 旧字段兼容：单中继地址（读取时合并进 relays 并设为 active）
    pub relay_url: Option<String>,
    /// 多中继：name 仅本机显示用
    #[serde(default)]
    pub relays: Vec<RelayConfig>,
    /// 当前选择的中继地址（None = 保持断开）
    #[serde(default)]
    pub active: Option<String>,
    /// 会话环境变量注入（如 HTTP_PROXY/HTTPS_PROXY，供 Codex 等需要代理的 Agent 使用）
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    pub name: String,
    pub url: String,
}

impl Settings {
    /// 归一化：旧 relay_url 合并为无名中继并视为 active；去重
    pub fn normalized(mut self) -> Self {
        if let Some(url) = self.relay_url.take() {
            if !self.relays.iter().any(|r| r.url == url) {
                self.relays.insert(
                    0,
                    RelayConfig {
                        name: "默认中继".into(),
                        url: url.clone(),
                    },
                );
            }
            if self.active.is_none() {
                self.active = Some(url);
            }
        }
        // active 必须指向列表中的地址
        if let Some(a) = &self.active {
            if !self.relays.iter().any(|r| &r.url == a) {
                self.active = None;
            }
        }
        self
    }
}

fn settings_path() -> Result<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .context("no home directory")?;
    let dir = PathBuf::from(home).join(".remoteagent");
    fs::create_dir_all(&dir).context("create ~/.remoteagent")?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings() -> Settings {
    settings_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

pub fn save_settings(s: &Settings) -> Result<()> {
    let path = settings_path()?;
    fs::write(&path, serde_json::to_string_pretty(s)?).context("write settings.json")?;
    Ok(())
}
