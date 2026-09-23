//! 本地模式 WS 服务：/ws 接入本地 viewer。
//! M9 起会话逻辑住在宿主进程（host_server），本模块只做 socket 与代理；
//! 事件经 SessionHost 广播下发。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};

use crate::protocol::{ClientMsg, DaemonMsg};

#[derive(Clone)]
pub struct AppState {
    /// 会话宿主客户端（M9 持久化：PTY 活在独立宿主进程，daemon 只做代理）
    pub host: Arc<crate::host_client::SessionHost>,
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

    let mut events = state.host.subscribe();
    let (mut sink, mut stream) = socket.split();

    'conn: loop {
        tokio::select! {
            evt = events.recv() => {
                let msg = match evt {
                    Ok(m) => m,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "event fanout lagged");
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if sink.send(Message::Text(serde_json::to_string(&msg)?.into())).await.is_err() {
                    break;
                }
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
                            Ok(m) => state.host.request(m).await,
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

    tracing::info!("client disconnected");
    Ok(())
}
