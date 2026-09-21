//! 出站中继模式：daemon 主动连 relay（无需公网 IP），握手后消息处理与本地模式
//! 完全复用（handle_msg）。断线指数退避重连，session 与环形缓冲全程存活。

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Identity;
use crate::protocol::{ClientMsg, DaemonMsg};
use crate::session::SessionEvent;
use crate::ws::{handle_msg, AppState};

pub async fn run_relay_mode(url: String, identity: Identity, state: AppState) {
    let mut backoff_secs: u64 = 1;
    loop {
        match connect_and_run(&url, &identity, &state).await {
            Ok(()) => tracing::warn!("relay connection closed"),
            Err(e) => tracing::warn!(error = %e, "relay connection error"),
        }
        state.sessions.clear_subscribers();
        tracing::info!(retry_in_secs = backoff_secs, "reconnecting to relay");
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn connect_and_run(url: &str, identity: &Identity, state: &AppState) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;
    tracing::info!(%url, "relay connected");

    let (mut sink, mut stream) = ws.split();

    let hello = serde_json::json!({
        "t": "hello", "v": 1, "role": "daemon",
        "deviceId": identity.device_id, "token": identity.token,
    });
    sink.send(Message::Text(hello.to_string().into())).await?;

    // 等握手结果
    match stream.next().await {
        Some(Ok(Message::Text(t))) => {
            let v: serde_json::Value = serde_json::from_str(&t)?;
            match v["t"].as_str() {
                Some("hello_ack") => {
                    tracing::info!(device = %identity.device_id, "registered at relay");
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

    'conn: loop {
        tokio::select! {
            evt = rx.recv() => {
                let Some((sid, evt)) = evt else { break };
                let msg = match evt {
                    SessionEvent::Output(chunk) => DaemonMsg::Output {
                        session_id: sid.clone(),
                        seq: 0,
                        data: base64::engine::general_purpose::STANDARD.encode(chunk),
                    },
                    SessionEvent::Exited(code) => {
                        state.sessions.remove(&sid);
                        DaemonMsg::SessionExited { session_id: sid, exit_code: code }
                    }
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
                if let Message::Text(text) = msg {
                    let replies = match serde_json::from_str::<ClientMsg>(&text) {
                        Ok(m) => handle_msg(state, &tx, m),
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
            }
        }
    }
    Ok(())
}
