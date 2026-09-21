// RemoteAgent daemon — M1 本地模式。
// 只监听回环地址，浏览器直连；M2 起改为出站连接中继。

mod protocol;
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

    let state = ws::AppState {
        sessions: Arc::new(session::SessionManager::new()),
    };

    // 开发期直接托管前端构建产物；web 端用 Vite dev server 时走 proxy。
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
