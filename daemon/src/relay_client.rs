//! 出站中继模式：daemon 主动连 relay（无需公网 IP），断线指数退避重连。
//! 安全模型（M3）：中继零信任——
//!   1) daemon 用 relay_key 注册（中继可见，仅用于房间管理）；
//!   2) 客户端先发 auth.proof（HMAC(accessToken, pub)）由 daemon 验证；
//!   3) 验证通过后 X25519 握手派生会话密钥，全部载荷 AES-256-GCM 加密（enc 信封）。
//! 未认证客户端的消息（除 auth.proof/ping）一律拒绝；认证后拒绝明文载荷（防降级）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Identity;
use crate::crypto::{Handshake, SessionCrypto};
use crate::protocol::{ClientMsg, DaemonMsg};
use crate::session::SessionEvent;
use crate::ws::{handle_msg, AppState};

pub async fn run_relay_mode(
    url: String,
    identity: std::sync::Arc<std::sync::RwLock<Identity>>,
    state: AppState,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let mut backoff_secs: u64 = 1;
    state.local.set_relay_note(false, "连接中");
    loop {
        if *stop.borrow() {
            break;
        }
        let mut stop_wake = stop.clone();
        tokio::select! {
            r = connect_and_run(&url, &identity, &state, &mut stop) => match r {
                Ok(()) => tracing::warn!("relay connection closed"),
                Err(e) => tracing::warn!(error = %e, "relay connection error"),
            },
            _ = stop_wake.changed() => break,
        }
        if *stop.borrow() {
            break;
        }
        state.sessions.clear_subscribers();
        state
            .local
            .set_relay_note(false, format!("{backoff_secs} 秒后重试"));
        tracing::info!(retry_in_secs = backoff_secs, "reconnecting to relay");
        // 分片睡眠：停止信号可随时打断退避等待
        for _ in 0..(backoff_secs * 4) {
            if *stop.borrow() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        backoff_secs = (backoff_secs * 2).min(30);
    }
    state.local.set_relay_note(false, "已断开");
    tracing::info!("relay task stopped");
}

async fn send_plain(
    sink: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    s: &str,
) -> anyhow::Result<()> {
    Ok(sink.send(Message::Text(s.to_string().into())).await?)
}

async fn connect_and_run(
    url: &str,
    identity: &std::sync::Arc<std::sync::RwLock<Identity>>,
    state: &AppState,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    state.local.set_relay_note(false, "连接中");
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;
    tracing::info!(%url, "relay connected");

    let (mut sink, mut stream) = ws.split();

    // 连接时取身份快照（device_id/relay_key 不热更新；令牌在验证点现读）
    let snapshot = identity.read().unwrap().clone();
    let hello = serde_json::json!({
        "t": "hello", "v": 1, "role": "daemon",
        "deviceId": snapshot.device_id, "token": snapshot.relay_key,
    });
    sink.send(Message::Text(hello.to_string().into())).await?;

    match stream.next().await {
        Some(Ok(Message::Text(t))) => {
            let v: serde_json::Value = serde_json::from_str(&t)?;
            match v["t"].as_str() {
                Some("hello_ack") => {
                    tracing::info!(device = %snapshot.device_id, "registered at relay");
                    state.local.set_relay_note(true, "已连接");
                }
                Some("error") => {
                    anyhow::bail!("relay rejected hello: {}", v["msg"].as_str().unwrap_or("?"));
                }
                _ => anyhow::bail!("unexpected first message from relay: {t}"),
            }
        }
        _ => anyhow::bail!("relay closed before hello_ack"),
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, SessionEvent)>();
    let mut crypto: Option<SessionCrypto> = None;
    // 保活：周期 ping 维持 NAT/防火墙映射，配合中继读超时及时发现半开连接
    let mut ping_tick = tokio::time::interval(std::time::Duration::from_secs(30));
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // 防抢占：未完成 E2E 握手的 viewer 限时请离（否则可长期占用单 viewer 槽位）；
    // 用 interval 而非 sleep——sleep 会随每次收包重建，可被垃圾流量绕过
    let mut auth_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut auth_check = tokio::time::interval(std::time::Duration::from_secs(5));
    auth_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    'conn: loop {
        tokio::select! {
            // 停止信号：连接空闲时也能及时退出（changed 在未被消费前保持就绪）
            _ = stop.changed() => break 'conn,
            _ = ping_tick.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break 'conn;
                }
            }
            _ = auth_check.tick() => {
                if crypto.is_none() && tokio::time::Instant::now() > auth_deadline {
                    // 请中继断开未认证 viewer（保留 daemon↔relay 隧道），并重置窗口等下一位
                    tracing::warn!("unauthenticated viewer timed out, requesting kick");
                    let _ = send_plain(&mut sink, r#"{"t":"kick"}"#).await;
                    auth_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                }
            }
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
                        DaemonMsg::SessionExited { session_id: sid, exit_code: code }
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
                let frame = serde_json::to_string(&msg)?;
                let wire = match &crypto {
                    Some(c) => c.seal(&frame)?,
                    None => frame, // 无订阅者时不会有事件
                };
                if sink.send(Message::Text(wire.into())).await.is_err() {
                    break;
                }
            }
            msg = stream.next() => {
                let msg = match msg {
                    None | Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(m)) => m,
                };
                let Message::Text(text) = msg else { continue };
                // 注意：serde_json 默认按键名排序输出，不能用字符串前缀判断类型
                let peek: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let is_enc = peek["t"] == "enc";
                let is_proof = peek["t"] == "auth.proof";

                // 已建立加密通道后，明文载荷一律拒绝（防降级攻击）；
                // 例外：auth.proof 始终放行——新客户端接入即重新握手、重置密钥
                let plaintext = if is_enc {
                    match crypto.as_ref().map(|c| c.open(&text)) {
                        Some(Ok(p)) => p,
                        _ => {
                            tracing::warn!("undecryptable enc frame, dropping");
                            continue;
                        }
                    }
                } else {
                    if crypto.is_some() && !is_proof {
                        tracing::warn!("plaintext payload after handshake, rejected");
                        continue;
                    }
                    text.to_string()
                };

                let client_msg = match serde_json::from_str::<ClientMsg>(&plaintext) {
                    Ok(m) => m,
                    Err(e) => {
                        let err = DaemonMsg::Error {
                            req_id: None,
                            code: "protocol_error".into(),
                            msg: e.to_string(),
                        };
                        if send_plain(&mut sink, &serde_json::to_string(&err)?).await.is_err() {
                            break 'conn;
                        }
                        continue;
                    }
                };

                // —— 认证门（auth.proof 任意时刻可重新握手）——
                match client_msg {
                    ClientMsg::AuthProof { pub_key, mac } => {
                        // 令牌每次握手现读：自定义令牌热更新即刻生效（旧配对立即失效）
                        let token = identity.read().unwrap().access_token.clone();
                        match Handshake::verify_client(&token, &pub_key, &mac) {
                            Ok((hs, reply)) => {
                                if send_plain(&mut sink, &reply).await.is_err() {
                                    break 'conn;
                                }
                                match hs.finish(&pub_key) {
                                    Ok(c) => {
                                        crypto = Some(c);
                                        tracing::info!("client authenticated, E2E channel established");
                                    }
                                    Err(e) => tracing::warn!(error = %e, "handshake finish failed"),
                                }
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "client auth failed");
                                let err = DaemonMsg::Error {
                                    req_id: None,
                                    code: "auth_failed".into(),
                                    msg: "bad proof".into(),
                                };
                                if send_plain(&mut sink, &serde_json::to_string(&err)?).await.is_err() {
                                    break 'conn;
                                }
                            }
                        }
                        continue;
                    }
                    ClientMsg::Ping => {
                        if send_plain(&mut sink, "{\"t\":\"pong\"}").await.is_err() {
                            break;
                        }
                        continue;
                    }
                    _ if crypto.is_none() => {
                        let err = DaemonMsg::Error {
                            req_id: None,
                            code: "auth_required".into(),
                            msg: "send auth.proof first".into(),
                        };
                        if send_plain(&mut sink, &serde_json::to_string(&err)?).await.is_err() {
                            break 'conn;
                        }
                        continue;
                    }
                    _ => {}
                }

                let replies = handle_msg(state, &tx, client_msg);
                for r in replies {
                    let frame = serde_json::to_string(&r)?;
                    let wire = match &crypto {
                        Some(c) => c.seal(&frame)?,
                        None => frame,
                    };
                    if sink.send(Message::Text(wire.into())).await.is_err() {
                        break 'conn;
                    }
                }
            }
        }
    }
    Ok(())
}
