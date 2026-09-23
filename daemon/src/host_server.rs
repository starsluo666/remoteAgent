//! 会话宿主模式（--session-host）：PTY 会话的常驻载体。
//! daemon 崩溃/升级只影响连接层 —— 宿主进程持有全部 ConPTY 与环形缓冲，
//! daemon 重启后重连即接管，会话内容与 AI 进程不中断。
//!
//! 协议：127.0.0.1 回环 TCP，行分隔 JSON。与 viewer↔daemon 的会话消息
//! （ClientMsg/DaemonMsg）同方言，外加三条内部信令：
//!   hello:  {"t":"host.hello","token":...} → {"t":"host.ack","pid":...}
//!   应答结束标记: {"t":"host.reply.end","reqId":N}（请求的全部应答已发完）
//!   心跳: {"t":"host.ping"} → {"t":"host.pong"}
//! 安全：仅本机回环 + 随机令牌（写在用户 TEMP 下的 json 里，同用户可读）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::protocol::{ClientMsg, DaemonMsg};
use crate::session::{EventTx, SessionEvent, SessionManager};

fn host_file() -> std::path::PathBuf {
    std::env::temp_dir().join("remoteagent-host.json")
}

/// 宿主信息文件内容（daemon 侧据此连接）
fn write_host_file(port: u16, token: &str) {
    let v = serde_json::json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
    });
    let _ = std::fs::write(host_file(), v.to_string());
}

pub async fn run() -> anyhow::Result<()> {
    let token = format!(
        "{}",
        uuid::Uuid::new_v4().simple()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    write_host_file(port, &token);
    tracing::info!(port, pid = std::process::id(), "session host listening");

    // 单客户端（daemon）语义：一次服务一条连接；断开后保留全部会话等下一次
    // 宿主级单例：会话生命周期 = 宿主进程生命周期（daemon 断连重连不重建）
    let sessions = std::sync::Arc::new(SessionManager::new());
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!(error = %e, "host accept error");
                continue;
            }
        };
        if let Err(e) = serve_conn(stream, &token, sessions.clone()).await {
            tracing::warn!(error = %e, "host connection ended");
        }
        tracing::info!("host: daemon disconnected, sessions preserved");
    }
}

async fn serve_conn(
    stream: tokio::net::TcpStream,
    token: &str,
    sessions: std::sync::Arc<SessionManager>,
) -> anyhow::Result<()> {
    stream.set_nodelay(true).ok();
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // —— 握手：必须先出示令牌 ——
    let first = match lines.next_line().await? {
        Some(l) => l,
        None => anyhow::bail!("closed before hello"),
    };
    let hello: serde_json::Value = serde_json::from_str(&first)?;
    if hello["t"].as_str() != Some("host.hello") || hello["token"].as_str() != Some(token) {
        let _ = serde_json::to_writer(
            std::io::stdout(),
            &serde_json::json!({"t": "host.error", "msg": "bad token"}),
        );
        anyhow::bail!("host auth failed");
    }
    let ack = serde_json::json!({"t": "host.ack", "pid": std::process::id()});
    writer.write_all(format!("{ack}\n").as_bytes()).await?;

    // —— 会话服务：与旧 daemon 本地 ws 循环同构 ——
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, SessionEvent)>();

    loop {
        tokio::select! {
            evt = rx.recv() => {
                let Some((sid, evt)) = evt else { break };
                let msg = match evt {
                    SessionEvent::Output(chunk, seq) => DaemonMsg::Output {
                        session_id: sid.clone(),
                        seq,
                        data: STANDARD.encode(chunk),
                    },
                    SessionEvent::Exited(code) => {
                        sessions.remove(&sid);
                        DaemonMsg::SessionExited { session_id: sid, exit_code: code }
                    }
                    SessionEvent::Agent(snap) => DaemonMsg::AgentStatus {
                        session_id: sid,
                        agent: snap.agent,
                        status: match snap.status {
                            crate::detector::AgentStatus::Starting => "starting".into(),
                            crate::detector::AgentStatus::Working => "working".into(),
                            crate::detector::AgentStatus::Error => "error".into(),
                            crate::detector::AgentStatus::Finished => "finished".into(),
                        },
                        detail: snap.detail,
                    },
                };
                let line = serde_json::to_string(&msg)?;
                writer.write_all(format!("{line}\n").as_bytes()).await?;
            }
            line = lines.next_line() => {
                let line = match line {
                    Ok(Some(l)) => l,
                    Ok(None) | Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                // 内部信令
                if trimmed.contains("\"host.ping\"") {
                    writer.write_all(b"{\"t\":\"host.pong\"}\n").await?;
                    continue;
                }
                let replies = match serde_json::from_str::<ClientMsg>(trimmed) {
                    Ok(m) => handle_msg(&sessions, &tx, m),
                    Err(e) => vec![DaemonMsg::Error {
                        req_id: None,
                        code: "protocol_error".into(),
                        msg: e.to_string(),
                    }],
                };
                let req_id = req_id_of(trimmed);
                for r in replies {
                    let frame = serde_json::to_string(&r)?;
                    writer.write_all(format!("{frame}\n").as_bytes()).await?;
                }
                let end = serde_json::json!({"t": "host.reply.end", "reqId": req_id});
                writer.write_all(format!("{end}\n").as_bytes()).await?;
            }
        }
    }
    Ok(())
}

/// 从原始行里取 reqId 做结束标记（serde 键序不定，不能靠前缀判断）
fn req_id_of(line: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v["reqId"].as_u64())
        .unwrap_or(0)
}

/// 处理一条会话消息（原 ws::handle_msg 迁入，仅依赖 SessionManager）。
/// 推送类事件（output/exited/agent）走订阅通道，不在这里。
pub(crate) fn handle_msg(
    sessions: &std::sync::Arc<SessionManager>,
    tx: &EventTx,
    msg: ClientMsg,
) -> Vec<DaemonMsg> {
    match msg {
        ClientMsg::Ping => vec![DaemonMsg::Pong],
        ClientMsg::Hello { .. } => vec![],
        ClientMsg::AuthProof { .. } => vec![DaemonMsg::Error {
            req_id: None,
            code: "protocol_error".into(),
            msg: "auth.proof not valid for host".into(),
        }],

        ClientMsg::SessionList { req_id } => vec![DaemonMsg::SessionListResult {
            req_id,
            sessions: sessions.list(),
        }],

        ClientMsg::SessionCreate { req_id, cols, rows, cwd, cmd } => {
            match sessions.create(cols, rows, cwd.as_deref(), cmd.as_deref()) {
                Ok(s) => vec![DaemonMsg::SessionCreated { req_id, session_id: s.id.clone() }],
                Err(e) => vec![DaemonMsg::Error {
                    req_id: Some(req_id),
                    code: "spawn_failed".into(),
                    msg: e.to_string(),
                }],
            }
        }

        ClientMsg::SessionAttach { req_id, session_id } => match sessions.get(&session_id) {
            Some(s) => {
                s.set_subscriber(tx.clone());
                let (bytes, seq) = s.snapshot();
                vec![
                    DaemonMsg::SessionAttached { req_id, session_id: s.id.clone() },
                    DaemonMsg::Snapshot {
                        session_id: s.id.clone(),
                        seq,
                        data: STANDARD.encode(bytes),
                    },
                ]
            }
            None => vec![DaemonMsg::Error {
                req_id: Some(req_id),
                code: "session_not_found".into(),
                msg: format!("no session {session_id}"),
            }],
        },

        ClientMsg::SessionKill { req_id, session_id } => match sessions.get(&session_id) {
            Some(s) => {
                if let Err(e) = s.kill() {
                    tracing::debug!(session = %session_id, error = %e, "kill (may already be dead)");
                }
                sessions.remove(&session_id);
                vec![DaemonMsg::SessionKilled { req_id, session_id }]
            }
            None => vec![DaemonMsg::Error {
                req_id: Some(req_id),
                code: "session_not_found".into(),
                msg: format!("no session {session_id}"),
            }],
        },

        ClientMsg::Input { session_id, data } => {
            match (sessions.get(&session_id), STANDARD.decode(&data)) {
                (Some(s), Ok(bytes)) => {
                    if let Err(e) = s.write_input(&bytes) {
                        vec![DaemonMsg::Error {
                            req_id: None,
                            code: "internal".into(),
                            msg: e.to_string(),
                        }]
                    } else {
                        vec![]
                    }
                }
                (Some(_), Err(e)) => vec![DaemonMsg::Error {
                    req_id: None,
                    code: "protocol_error".into(),
                    msg: format!("bad base64: {e}"),
                }],
                (None, _) => vec![DaemonMsg::Error {
                    req_id: None,
                    code: "session_not_found".into(),
                    msg: format!("no session {session_id}"),
                }],
            }
        }

        ClientMsg::Resize { session_id, cols, rows } => {
            if let Some(s) = sessions.get(&session_id) {
                if let Err(e) = s.resize(cols, rows) {
                    return vec![DaemonMsg::Error {
                        req_id: None,
                        code: "internal".into(),
                        msg: e.to_string(),
                    }];
                }
            }
            vec![]
        }
    }
}
