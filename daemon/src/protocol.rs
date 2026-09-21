//! 线协议消息类型，契约见 docs/protocol.md。
//! 字段命名 camelCase，与协议文档一致。

use serde::{Deserialize, Serialize};

/// 客户端 → daemon（M2 起 relay 透传，M1 直连）
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    #[serde(rename = "hello")]
    #[allow(dead_code)] // role/device_id 在 M2 接入中继时使用
    Hello {
        v: u8,
        role: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "session.list")]
    SessionList { req_id: u64 },
    #[serde(rename = "session.create")]
    SessionCreate {
        req_id: u64,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        cmd: Option<String>,
    },
    #[serde(rename = "session.attach")]
    SessionAttach { req_id: u64, session_id: String },
    #[serde(rename = "session.kill")]
    SessionKill { req_id: u64, session_id: String },
    #[serde(rename = "input")]
    Input { session_id: String, data: String },
    #[serde(rename = "resize")]
    Resize { session_id: String, cols: u16, rows: u16 },
    /// E2E 握手（仅中继模式，M3）：HMAC(accessToken, client_pub)
    #[serde(rename = "auth.proof")]
    AuthProof {
        #[serde(rename = "pub")]
        pub_key: String,
        mac: String,
    },
}

/// daemon → 客户端
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum DaemonMsg {
    #[serde(rename = "hello_ack")]
    HelloAck { device_id: String },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "session.list.result")]
    SessionListResult { req_id: u64, sessions: Vec<SessionInfo> },
    #[serde(rename = "session.created")]
    SessionCreated { req_id: u64, session_id: String },
    #[serde(rename = "session.attached")]
    SessionAttached { req_id: u64, session_id: String },
    #[serde(rename = "output")]
    Output { session_id: String, seq: u64, data: String },
    #[serde(rename = "snapshot")]
    Snapshot { session_id: String, seq: u64, data: String },
    #[serde(rename = "session.exited")]
    SessionExited { session_id: String, exit_code: Option<u32> },
    #[serde(rename = "error")]
    Error { req_id: Option<u64>, code: String, msg: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub cmd: String,
    pub started_at: i64,
}
