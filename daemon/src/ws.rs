//! 本地模式 WS 服务：/ws 处理协议消息，静态托管 web/dist。
//! M2 起本模块的角色变为"到中继的出站连接"，消息处理逻辑保持复用。

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::protocol::{ClientMsg, DaemonMsg};
use crate::session::{SessionEvent, SessionManager};

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionManager>,
    /// 本机信息：/api/local 面板展示用（仅 127.0.0.1 可见）
    pub local: Arc<LocalInfo>,
}

/// 本地面板数据（daemon 身份与中继配置的只读快照）
pub struct LocalInfo {
    pub device_id: String,
    pub access_token: String,
    pub relay_url: Option<String>,
}

pub async fn handle_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    if let Err(e) = handle_socket_inner(socket, state).await {
        tracing::warn!(error = %e, "ws connection ended with error");
    }
}

async fn handle_socket_inner(mut socket: WebSocket, state: AppState) -> anyhow::Result<()> {
    // 握手：第一条必须是 hello v1（M1 本地模式不校验 token，M2 起接入）
    match socket.recv().await {
        Some(Ok(Message::Text(text))) => {
            let msg: ClientMsg = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(e) => {
                    let err = DaemonMsg::Error {
                        req_id: None,
                        code: "protocol_error".into(),
                        msg: e.to_string(),
                    };
                    socket
                        .send(Message::Text(serde_json::to_string(&err)?.into()))
                        .await?;
                    return Ok(());
                }
            };
            match msg {
                ClientMsg::Hello { v: 1, .. } => {}
                ClientMsg::Hello { v, .. } => {
                    let err = DaemonMsg::Error {
                        req_id: None,
                        code: "unsupported_version".into(),
                        msg: format!("want proto v1, got v{v}"),
                    };
                    socket
                        .send(Message::Text(serde_json::to_string(&err)?.into()))
                        .await?;
                    return Ok(());
                }
                _ => {
                    let err = DaemonMsg::Error {
                        req_id: None,
                        code: "protocol_error".into(),
                        msg: "first message must be hello".into(),
                    };
                    socket
                        .send(Message::Text(serde_json::to_string(&err)?.into()))
                        .await?;
                    return Ok(());
                }
            }
        }
        _ => return Ok(()),
    }
    let ack = DaemonMsg::HelloAck {
        device_id: "local-daemon".into(),
    };
    socket
        .send(Message::Text(serde_json::to_string(&ack)?.into()))
        .await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, SessionEvent)>();
    let (mut sink, mut stream) = socket.split();

    'conn: loop {
        tokio::select! {
            evt = rx.recv() => {
                let Some((sid, evt)) = evt else { break };
                let msg = match evt {
                    SessionEvent::Output(chunk) => DaemonMsg::Output {
                        session_id: sid.clone(),
                        seq: 0, // 由客户端按到达顺序消费；真实 seq 在 M3 加密信封时启用
                        data: STANDARD.encode(chunk),
                    },
                    SessionEvent::Exited(code) => {
                        state.sessions.remove(&sid);
                        DaemonMsg::SessionExited { session_id: sid.clone(), exit_code: code }
                    }
                };
                if sink.send(Message::Text(serde_json::to_string(&msg)?.into())).await.is_err() {
                    break;
                }
                let _ = sid;
            }
            msg = stream.next() => {
                let msg = match msg {
                    None | Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(m)) => m,
                };
                match msg {
                    Message::Text(text) => {
                        let replies = match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(m) => handle_msg(&state, &tx, m),
                            Err(e) => vec![DaemonMsg::Error {
                                req_id: None,
                                code: "protocol_error".into(),
                                msg: e.to_string(),
                            }],
                        };
                        for r in replies {
                            let frame = serde_json::to_string(&r)?;
                            if sink.send(Message::Text(frame.into())).await.is_err() {
                                break 'conn;
                            }
                        }
                    }
                    Message::Ping(p) => {
                        if sink.send(Message::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    state.sessions.clear_subscribers();
    tracing::info!("client disconnected");
    Ok(())
}

/// 处理一条客户端消息，返回需要回发的消息（可能为空）。
/// 推送类事件（output/exited）走 session 订阅通道，不在这里。
pub(crate) fn handle_msg(
    state: &AppState,
    tx: &crate::session::EventTx,
    msg: ClientMsg,
) -> Vec<DaemonMsg> {
    match msg {
        ClientMsg::Ping => vec![DaemonMsg::Pong],
        ClientMsg::Hello { .. } => vec![], // 已在握手阶段处理
        // 中继模式在认证门处理；本地模式不应出现
        ClientMsg::AuthProof { .. } => vec![DaemonMsg::Error {
            req_id: None,
            code: "protocol_error".into(),
            msg: "auth.proof only valid in relay mode".into(),
        }],

        ClientMsg::SessionList { req_id } => vec![DaemonMsg::SessionListResult {
            req_id,
            sessions: state.sessions.list(),
        }],

        ClientMsg::SessionCreate { req_id, cols, rows, cwd, cmd } => {
            match state.sessions.create(cols, rows, cwd.as_deref(), cmd.as_deref()) {
                Ok(s) => vec![DaemonMsg::SessionCreated { req_id, session_id: s.id.clone() }],
                Err(e) => vec![DaemonMsg::Error {
                    req_id: Some(req_id),
                    code: "spawn_failed".into(),
                    msg: e.to_string(),
                }],
            }
        }

        ClientMsg::SessionAttach { req_id, session_id } => {
            match state.sessions.get(&session_id) {
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
            }
        }

        ClientMsg::SessionKill { req_id, session_id } => {
            match state.sessions.get(&session_id) {
                Some(s) => {
                    // 进程可能已退出，kill 失败不视为错误；exited 事件由 wait 线程发出
                    if let Err(e) = s.kill() {
                        tracing::debug!(session = %session_id, error = %e, "kill (may already be dead)");
                    }
                    vec![DaemonMsg::SessionKilled { req_id, session_id }]
                }
                None => vec![DaemonMsg::Error {
                    req_id: Some(req_id),
                    code: "session_not_found".into(),
                    msg: format!("no session {session_id}"),
                }],
            }
        }

        ClientMsg::Input { session_id, data } => {
            match (state.sessions.get(&session_id), STANDARD.decode(&data)) {
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
            if let Some(s) = state.sessions.get(&session_id) {
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
