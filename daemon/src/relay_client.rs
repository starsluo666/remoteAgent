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
    identity: Identity,
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
    identity: &Identity,
    state: &AppState,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    state.local.set_relay_note(false, "连接中");
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;
    tracing::info!(%url, "relay connected");

    let (mut sink, mut stream) = ws.split();

    let hello = serde_json::json!({
        "t": "hello", "v": 1, "role": "daemon",
        "deviceId": identity.device_id, "token": identity.relay_key,
    });
    sink.send(Message::Text(hello.to_string().into())).await?;

    match stream.next().await {
        Some(Ok(Message::Text(t))) => {
            let v: serde_json::Value = serde_json::from_str(&t)?;
            match v["t"].as_str() {
                Some("hello_ack") => {
                    tracing::info!(device = %identity.device_id, "registered at relay");
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

    'conn: loop {
        tokio::select! {
            // 停止信号：连接空闲时也能及时退出（changed 在未被消费前保持就绪）
            _ = stop.changed() => break 'conn,
            evt = rx.recv() => {
                let Some((sid, evt)) = evt else { break };
                let msg = match evt {
                    SessionEvent::Output(chunk) => DaemonMsg::Output {
                        session_id: sid.clone(),
                        seq: 0,
                        data: STANDARD.encode(chunk),
                    },
                    SessionEvent::Exited(code) => {
                        state.sessions.remove(&sid);
                        DaemonMsg::SessionExited { session_id: sid, exit_code: code }
                    }
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
                        match Handshake::verify_client(&identity.access_token, &pub_key, &mac) {
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
