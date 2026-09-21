// RemoteAgent daemon。
// 默认：本地模式（127.0.0.1:9800，浏览器直连）。
// --relay <url>：出站中继模式（连中继，手机/外网经中继访问），本地服务停用。

mod config;
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

    let identity = config::load_or_create()?;

    let state = ws::AppState {
        sessions: Arc::new(session::SessionManager::new()),
    };

    let relay_url = std::env::args().nth(1).and_then(|a| {
        if a == "--relay" {
            std::env::args().nth(2)
        } else {
            None
        }
    });

    if let Some(url) = relay_url {
        let host = url
            .trim_start_matches("ws://")
            .trim_start_matches("wss://")
            .split('/')
            .next()
            .unwrap_or("relay");
        tracing::info!(device = %identity.device_id, token = %identity.token, "relay mode");
        tracing::info!("pair with: http://{host}/?device={}&token={}", identity.device_id, identity.token);
        relay_client::run_relay_mode(url, identity, state).await;
        return Ok(());
    }

    // 本地模式：/ws + 托管前端构建产物
    let web_dist = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(ws::handle_ws))
        .with_state(state)
        .fallback_service(ServeDir::new(web_dist));

    let addr = "127.0.0.1:9800";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "daemon listening (local mode), web UI at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
