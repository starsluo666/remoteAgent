//! 本地模式 WS 服务：/ws 处理协议消息，静态托管 web/dist。
//! M2 起本模块的角色变为"到中继的出站连接"，消息处理逻辑保持复用。

use std::sync::atomic::Ordering;
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
    /// 本机信息：/api/local 面板展示与中继控制（仅 127.0.0.1 可见）
    pub local: Arc<LocalShared>,
    /// 身份可变（自定义令牌热更新，验证点每次握手现读）
    pub identity: Arc<std::sync::RwLock<crate::config::Identity>>,
    /// 中继连接任务句柄（启动/停止由本地面板与 CLI 驱动）
    pub relay: Arc<std::sync::Mutex<RelayCtl>>,
    /// 本地 ws 单连接占用（v0.1 单 viewer 语义：本地与远程不并行抢输出）
    pub local_busy: Arc<std::sync::atomic::AtomicBool>,
}

/// 本机共享状态：身份可变（自定义令牌热更新），中继状态可变（连接/断开/重试时更新）
pub struct LocalShared {
    pub device_id: String,
    pub access_token: std::sync::RwLock<String>,
    relay: std::sync::Mutex<RelayState>,
}

#[derive(Clone, Default, serde::Serialize)]
pub struct RelayState {
    pub url: Option<String>,
    pub name: String,
    pub online: bool,
    pub note: String,
    /// 本次注册成功时刻（unix 秒；0 = 未连接）
    pub connected_at: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl LocalShared {
    pub fn new(device_id: String, access_token: String) -> Self {
        Self {
            device_id,
            access_token: std::sync::RwLock::new(access_token),
            relay: std::sync::Mutex::new(RelayState::default()),
        }
    }

    pub fn relay_state(&self) -> RelayState {
        self.relay.lock().unwrap().clone()
    }

    pub fn set_relay_target(&self, name: &str, url: Option<String>) {
        let mut r = self.relay.lock().unwrap();
        r.name = name.to_string();
        r.url = url;
        if r.url.is_none() {
            r.online = false;
            r.connected_at = 0;
            r.note = "未连接".into();
        }
    }

    pub fn set_relay_note(&self, online: bool, note: impl Into<String>) {
        let mut r = self.relay.lock().unwrap();
        if online && !r.online {
            r.connected_at = now_secs();
        }
        r.online = online;
        r.note = note.into();
    }
}

/// 中继任务控制：watch 通道发出停止信号，任务在连接循环边界退出
pub struct RelayCtl {
    stop_tx: Option<tokio::sync::watch::Sender<bool>>,
}

impl RelayCtl {
    pub fn stopped() -> Self {
        Self { stop_tx: None }
    }

    /// 启动（或替换）中继任务；旧任务（若有）先被停止。
    /// identity 共享句柄：令牌热更新后，重连/验证自动用新值
    pub fn start(
        &mut self,
        name: &str,
        url: String,
        identity: Arc<std::sync::RwLock<crate::config::Identity>>,
        state: AppState,
    ) {
        self.stop();
        state.local.set_relay_target(name, Some(url.clone()));
        let (tx, rx) = tokio::sync::watch::channel(false);
        self.stop_tx = Some(tx);
        tokio::spawn(crate::relay_client::run_relay_mode(url, identity, state, rx));
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(true);
        }
    }
}

pub async fn handle_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    // 单连接占用：CAS 失败即拒绝（对齐中继侧 device_busy 语义）
    if state
        .local_busy
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        let err = serde_json::json!({
            "t": "error", "code": "local_busy",
            "msg": "another local viewer is already connected",
        });
        let mut socket = socket;
        let _ = socket.send(Message::Text(err.to_string().into())).await;
        return;
    }
    let result = handle_socket_inner(socket, state.clone()).await;
    state.local_busy.store(false, Ordering::Release);
    if let Err(e) = result {
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
                    SessionEvent::Output(chunk, seq) => DaemonMsg::Output {
                        session_id: sid.clone(),
                        seq,
                        data: STANDARD.encode(chunk),
                    },
                    SessionEvent::Exited(code) => {
                        state.sessions.remove(&sid);
                        DaemonMsg::SessionExited { session_id: sid.clone(), exit_code: code }
                    }
                    SessionEvent::Agent(snap) => DaemonMsg::AgentStatus {
                        session_id: sid.clone(),
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
                    // kill 语义即"删除"：已死会话的 wait 线程早已结束，
                    // 不会再有 exited 事件 —— 这里必须无条件清条目，否则死会话关不掉
                    state.sessions.remove(&session_id);
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
