//! 设备身份：deviceId + 配对 token，首次运行生成，落盘 ~/.remoteagent/identity.json。
//! M2 为共享配对 token（daemon 注册、client 凭同一个 token 加入）；
//! M3 按协议拆分为中继会话密钥与设备访问 token。

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub device_id: String,
    pub token: String,
}

fn identity_path() -> Result<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .context("no home directory")?;
    let dir = PathBuf::from(home).join(".remoteagent");
    fs::create_dir_all(&dir).context("create ~/.remoteagent")?;
    Ok(dir.join("identity.json"))
}

pub fn load_or_create() -> Result<Identity> {
    let path = identity_path()?;
    if path.exists() {
        let raw = fs::read_to_string(&path).context("read identity.json")?;
        let id: Identity = serde_json::from_str(&raw).context("parse identity.json")?;
        return Ok(id);
    }
    let id = Identity {
        device_id: uuid::Uuid::new_v4().to_string(),
        token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
    };
    fs::write(&path, serde_json::to_string_pretty(&id)?).context("write identity.json")?;
    tracing::info!(path = %path.display(), "created new device identity");
    Ok(id)
}
