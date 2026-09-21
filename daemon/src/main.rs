// RemoteAgent daemon。
// 本地面板/本地直连始终监听 127.0.0.1:9800（/api/local 身份信息 + /ws + web UI）。
// --relay <url>：额外从中继出站连接（手机/外网经中继访问），面板不受影响。

mod config;
mod crypto;
mod protocol;
mod relay_client;
mod session;
mod ws;

use std::sync::Arc;

use tower_http::services::ServeDir;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    if std::env::args().any(|a| a == "--rotate-access-token") {
        let id = config::rotate_access_token()?;
        tracing::info!(device = %id.device_id, "access token rotated");
        tracing::info!("new pairing token: {}", id.access_token);
        return Ok(());
    }

    let identity = config::load_or_create()?;

    let relay_url = std::env::args().nth(1).and_then(|a| {
        if a == "--relay" {
            std::env::args().nth(2)
        } else {
            None
        }
    });

    let state = ws::AppState {
        sessions: Arc::new(session::SessionManager::new()),
        local: Arc::new(ws::LocalInfo {
            device_id: identity.device_id.clone(),
            access_token: identity.access_token.clone(),
            relay_url: relay_url.clone(),
        }),
    };

    // 中继模式：打印配对信息，后台出站连接；本地面板服务器照常常驻
    if let Some(url) = relay_url {
        let secure = url.starts_with("wss://");
        let scheme = if secure { "https" } else { "http" };
        let host = url
            .trim_start_matches("ws://")
            .trim_start_matches("wss://")
            .split('/')
            .next()
            .unwrap_or("relay");
        tracing::info!(device = %identity.device_id, "relay mode");
        tracing::info!(
            "pair with: {scheme}://{host}/?device={}&token={}",
            identity.device_id,
            identity.access_token
        );
        let relay_state = state.clone();
        let relay_identity = identity.clone();
        tokio::spawn(relay_client::run_relay_mode(
            url,
            relay_identity,
            relay_state,
        ));
    }

    // 本地面板 + 本地直连：/api/local（身份信息）+ /ws + 托管前端构建产物，仅 127.0.0.1
    let web_dist = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
    let app = axum::Router::new()
        .route("/api/local", axum::routing::get(local_info))
        .route("/ws", axum::routing::get(ws::handle_ws))
        .with_state(state)
        .fallback_service(ServeDir::new(web_dist));

    let addr = "127.0.0.1:9800";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "daemon local panel at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// 本地面板信息（仅 127.0.0.1）：设备身份 + 中继配置 + 配对链接
async fn local_info(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
) -> axum::Json<serde_json::Value> {
    let ws::LocalInfo {
        device_id,
        access_token,
        relay_url,
    } = &*state.local;
    let pairing_url = relay_url.as_ref().map(|url| {
        let secure = url.starts_with("wss://");
        let scheme = if secure { "https" } else { "http" };
        let host = url
            .trim_start_matches("ws://")
            .trim_start_matches("wss://")
            .split('/')
            .next()
            .unwrap_or("relay");
        format!("{scheme}://{host}/?device={device_id}&token={access_token}")
    });
    axum::Json(serde_json::json!({
        "deviceId": device_id,
        "accessToken": access_token,
        "relayUrl": relay_url,
        "pairingUrl": pairing_url,
    }))
}
