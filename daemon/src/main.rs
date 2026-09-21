// RemoteAgent daemon。
// 本地面板/本地直连始终监听 127.0.0.1:9800（/api/local 身份与中继控制 + /ws + web UI）。
// 中继连接三种来源：CLI --relay（当次有效）> 面板/设置 settings.json（持久，重启自动恢复）。

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

    // 中继来源：CLI --relay 优先，否则取界面保存的设置（重启自动恢复）
    let settings = config::load_settings();
    let relay_start = relay_url.or_else(|| settings.relay_url.clone());

    let state = ws::AppState {
        sessions: Arc::new(session::SessionManager::new()),
        local: Arc::new(ws::LocalShared::new(
            identity.device_id.clone(),
            identity.access_token.clone(),
        )),
        identity: Arc::new(identity.clone()),
        relay: Arc::new(std::sync::Mutex::new(ws::RelayCtl::stopped())),
    };

    if let Some(url) = relay_start {
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
            "relay web: {scheme}://{host}/ （手机端输入该地址 + 设备 ID + 访问令牌连接）"
        );
        state.local.set_relay_url(Some(url.clone()));
        state
            .relay
            .lock()
            .unwrap()
            .start(url, identity, state.clone());
    }

    // 本地面板 + 本地直连：/api/local（身份/中继控制）+ /ws + 前端静态资源，仅 127.0.0.1
    let web_dist = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
    let app = axum::Router::new()
        .route("/api/local", axum::routing::get(local_info))
        .route("/api/local/relay", axum::routing::post(set_relay))
        .route("/ws", axum::routing::get(ws::handle_ws))
        .with_state(state)
        .fallback_service(ServeDir::new(web_dist));

    let addr = "127.0.0.1:9800";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "daemon local panel at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// 本地面板信息（仅 127.0.0.1）：设备身份 + 中继状态
async fn local_info(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
) -> axum::Json<serde_json::Value> {
    let relay = state.local.relay_state();
    axum::Json(serde_json::json!({
        "deviceId": state.local.device_id,
        "accessToken": state.local.access_token,
        "relayUrl": relay.url,
        "relayOnline": relay.online,
        "relayNote": relay.note,
    }))
}

#[derive(serde::Deserialize)]
struct RelayBody {
    url: Option<String>,
}

/// 界面配置中继：url=null 断开；否则连接指定中继（持久化，重启自动恢复）
async fn set_relay(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
    axum::Json(body): axum::Json<RelayBody>,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let mut settings = config::load_settings();
    match body.url.as_deref() {
        None => {
            settings.relay_url = None;
            config::save_settings(&settings)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            state.relay.lock().unwrap().stop();
            state.local.set_relay_url(None);
            state.local.set_relay_note(false, "未连接");
            tracing::info!("relay disconnected from panel");
        }
        Some(url) => {
            let url = url.trim().to_string();
            if !url.starts_with("ws://") && !url.starts_with("wss://") {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "中继地址需以 ws:// 或 wss:// 开头".into(),
                ));
            }
            settings.relay_url = Some(url.clone());
            config::save_settings(&settings)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            state.local.set_relay_url(Some(url.clone()));
            state.relay.lock().unwrap().start(
                url,
                (*state.identity).clone(),
                state.clone(),
            );
            tracing::info!("relay connect requested from panel");
        }
    }
    let relay = state.local.relay_state();
    Ok(axum::Json(serde_json::json!({
        "relayUrl": relay.url,
        "relayOnline": relay.online,
        "relayNote": relay.note,
    })))
}
