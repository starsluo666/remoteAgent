// RemoteAgent daemon。
// 本地面板/本地直连始终监听 127.0.0.1:9800（/api/local 身份与中继控制 + /ws + web UI）。
// 中继连接三种来源：CLI --relay（当次有效）> 面板/设置 settings.json（持久，重启自动恢复）。

mod config;
mod detector;
mod crypto;
mod protocol;
mod relay_client;
mod session;
mod ws;

use std::sync::Arc;

use axum::response::IntoResponse;
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

    if std::env::args().any(|a| a == "--reset-device-id") {
        let id = config::reset_device_id()?;
        tracing::info!("new device id: {}", id.device_id);
        tracing::info!("旧配对链接里的 device 参数已失效，重启 daemon 生效");
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
    let relay_start = relay_url.clone().or_else(|| settings.active.clone());
    let relay_name_of = |url: &str| {
        settings
            .relays
            .iter()
            .find(|r| r.url == url)
            .map(|r| r.name.clone())
            .unwrap_or_else(|| "默认中继".into())
    };

    let state = ws::AppState {
        sessions: Arc::new(session::SessionManager::new()),
        local: Arc::new(ws::LocalShared::new(
            identity.device_id.clone(),
            identity.access_token.clone(),
        )),
        identity: Arc::new(std::sync::RwLock::new(identity.clone())),
        relay: Arc::new(std::sync::Mutex::new(ws::RelayCtl::stopped())),
        local_busy: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        let name = relay_name_of(&url);
        tracing::info!(device = %identity.device_id, relay = %name, "relay mode");
        tracing::info!(
            "relay web: {scheme}://{host}/ （手机端输入该地址 + 设备 ID + 访问令牌连接）"
        );
        state
            .relay
            .lock()
            .unwrap()
            .start(&name, url, state.identity.clone(), state.clone());
    }

    // 本地面板 + 本地直连：/api/local（身份/中继控制）+ /ws + 前端静态资源，仅 127.0.0.1
    // Host 校验：防 DNS rebinding（恶意域名解析到 127.0.0.1 后浏览器携带其 Host 直连本地服务）
    let web_dist = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist");
    let app = axum::Router::new()
        .route("/api/local", axum::routing::get(local_info))
        .route("/api/local/relay", axum::routing::post(set_relay))
        .route("/api/local/relays", axum::routing::post(manage_relays))
        .route("/api/local/token", axum::routing::post(set_token))
        .route("/api/sessions", axum::routing::get(list_sessions))
        .route("/ws", axum::routing::get(ws::handle_ws))
        .with_state(state)
        .fallback_service(ServeDir::new(web_dist))
        .layer(axum::middleware::from_fn(guard_local_host))
        .layer(axum::middleware::from_fn(cors_tauri))
        .layer(axum::middleware::from_fn(set_cache_headers));

    let addr = "127.0.0.1:9800";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "daemon local panel at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// 静态资源缓存策略：index.html 永远回源校验（避免拿到旧前端），带哈希的 assets 长缓存
async fn set_cache_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    let cache = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(v) = cache.parse() {
        res.headers_mut().insert(axum::http::header::CACHE_CONTROL, v);
    }
    res
}

/// 仅放行本机来源的 Host 头（防 DNS rebinding 读取本地 API / 直连本地 ws）
async fn guard_local_host(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    const ALLOWED: [&str; 3] = ["127.0.0.1:9800", "localhost:9800", "[::1]:9800"];
    let ok = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| ALLOWED.contains(&h));
    if ok {
        next.run(req).await
    } else {
        (axum::http::StatusCode::FORBIDDEN, "host not allowed").into_response()
    }
}

/// Tauri 桌面壳（tauri.localhost 源）跨源访问本机 API 的 CORS 放行。
/// 仅白名单两个源：网页无法伪造 Origin 头，而 /api/local 含 accessToken，
/// 不可对任意源开放（Host 校验之外的第二道针对性门槛）。
async fn cors_tauri(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    const ALLOWED: [&str; 2] = ["http://tauri.localhost", "https://tauri.localhost"];
    let origin = req
        .headers()
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| ALLOWED.contains(o))
        .map(str::to_owned);
    // JSON POST 会先触发预检
    if req.method() == axum::http::Method::OPTIONS {
        if let Some(o) = &origin {
            return axum::http::Response::builder()
                .status(axum::http::StatusCode::NO_CONTENT)
                .header("Access-Control-Allow-Origin", o)
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .body(axum::body::Body::empty())
                .unwrap()
                .into();
        }
    }
    let mut res = next.run(req).await;
    if let Some(o) = origin {
        if let Ok(v) = o.parse() {
            res.headers_mut()
                .insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
    }
    res
}

/// 本地面板信息（仅 127.0.0.1）：设备身份 + 中继状态（含 viewers / 配置列表）
async fn local_info(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
) -> axum::Json<serde_json::Value> {
    let relay = state.local.relay_state();
    let settings = config::load_settings();
    let relay_key = state.identity.read().unwrap().relay_key.clone();
    let viewers = fetch_viewers(&relay.url, &state.local.device_id, &relay_key).await;
    axum::Json(serde_json::json!({
        "deviceId": state.local.device_id,
        "accessToken": state.local.access_token.read().unwrap().clone(),
        "relayUrl": relay.url,
        "relayName": relay.name,
        "relayOnline": relay.online,
        "relayNote": relay.note,
        "relayConnectedAt": relay.connected_at,
        "relayViewers": viewers,
        "relays": settings.relays,
        "activeRelay": settings.active,
    }))
}

/// 活跃连接数：查中继 /api/presence（全私有模型：单设备查询，relay_key 门槛）
async fn fetch_viewers(relay_url: &Option<String>, device_id: &str, relay_key: &str) -> Option<u32> {
    let url = relay_url.as_ref()?;
    let base = url
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches("/ws")
        .to_string();
    let resp = http_get_json(format!(
        "{base}/api/presence?device={device_id}&key={relay_key}"
    ))
    .await
    .ok()?;
    resp.get("viewers").and_then(|x| x.as_u64()).map(|x| x as u32)
}

/// 极简 JSON GET（http 探测用；wss 公网场景经反代同样提供 http 的 /api）
pub async fn http_get_json(url: String) -> anyhow::Result<serde_json::Value> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("only http probe supported"))?;
    let (hostport, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{p}")),
        None => (rest.to_string(), "/".to_string()),
    };
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(&hostport),
    )
    .await??;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let req = format!("GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;
    let mut buf = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(2), stream.read_to_end(&mut buf)).await??;
    let body = String::from_utf8_lossy(&buf);
    let json_part = body
        .split("\r\n\r\n")
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("no body"))?;
    Ok(serde_json::from_str(json_part.trim())?)
}

/// 本机会话列表（概览/Sessions 页轮询用）
async fn list_sessions(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
) -> axum::Json<serde_json::Value> {
    let sessions: Vec<crate::protocol::SessionInfo> = state.sessions.list();
    axum::Json(serde_json::json!({ "sessions": sessions }))
}

fn host_of(url: &str) -> String {
    url.trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .split('/')
        .next()
        .unwrap_or("中继")
        .to_string()
}

#[derive(serde::Deserialize)]
struct RelayBody {
    url: Option<String>,
}

#[derive(serde::Deserialize)]
struct TokenBody {
    token: String,
}

/// 自定义访问令牌（≥8 位）：写入 identity + 热更新内存，旧配对立即失效。
/// 注意口令强度：E2E 握手的 HMAC 证明可被离线爆破，弱口令会显著降低配对门槛
async fn set_token(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
    axum::Json(body): axum::Json<TokenBody>,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let t = body.token.trim();
    let chars: usize = t.chars().count();
    if chars < 8 || chars > 128 {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "令牌长度需在 8–128 位之间".into(),
        ));
    }
    if t.chars().any(char::is_whitespace) {
        return Err((axum::http::StatusCode::BAD_REQUEST, "令牌不能包含空白字符".into()));
    }
    let id = config::set_access_token(t)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    *state.identity.write().unwrap() = id;
    *state.local.access_token.write().unwrap() = t.to_string();
    tracing::info!(len = chars, "access token updated (custom)");
    Ok(axum::Json(serde_json::json!({ "ok": true, "note": "已生效；旧配对链接立即失效" })))
}

/// 界面配置中继：url=null 断开；url=已存或新地址则连接（持久化，重启自动恢复）
async fn set_relay(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
    axum::Json(body): axum::Json<RelayBody>,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let mut settings = config::load_settings();
    match body.url.as_deref() {
        None => {
            settings.active = None;
            config::save_settings(&settings)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            state.relay.lock().unwrap().stop();
            state.local.set_relay_target("", None);
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
            if !settings.relays.iter().any(|r| r.url == url) {
                let name = host_of(&url);
                settings.relays.push(config::RelayConfig { name, url: url.clone() });
            }
            let name = settings
                .relays
                .iter()
                .find(|r| r.url == url)
                .map(|r| r.name.clone())
                .unwrap_or_default();
            settings.active = Some(url.clone());
            config::save_settings(&settings)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            state
                .relay
                .lock()
                .unwrap()
                .start(&name, url, state.identity.clone(), state.clone());
            tracing::info!(relay = %name, "relay connect requested from panel");
        }
    }
    let relay = state.local.relay_state();
    Ok(axum::Json(serde_json::json!({
        "relayUrl": relay.url,
        "relayName": relay.name,
        "relayOnline": relay.online,
        "relayNote": relay.note,
    })))
}

#[derive(serde::Deserialize)]
struct RelayListBody {
    action: String, // add | remove | rename
    name: Option<String>,
    url: Option<String>,
}

/// 多中继管理：添加 / 移除 / 重命名（不改变当前连接，remove 活跃项时断开）
async fn manage_relays(
    axum::extract::State(state): axum::extract::State<ws::AppState>,
    axum::Json(body): axum::Json<RelayListBody>,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let mut settings = config::load_settings();
    match body.action.as_str() {
        "add" => {
            let url = body.url.unwrap_or_default().trim().to_string();
            let name = body.name.unwrap_or_default().trim().to_string();
            if url.is_empty() {
                return Err((axum::http::StatusCode::BAD_REQUEST, "缺少地址".into()));
            }
            if !url.starts_with("ws://") && !url.starts_with("wss://") {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "地址需以 ws:// 或 wss:// 开头".into(),
                ));
            }
            if settings.relays.iter().any(|r| r.url == url) {
                return Err((axum::http::StatusCode::BAD_REQUEST, "该中继已在列表中".into()));
            }
            settings.relays.push(config::RelayConfig {
                name: if name.is_empty() { host_of(&url) } else { name },
                url,
            });
        }
        "remove" => {
            let url = body.url.unwrap_or_default();
            settings.relays.retain(|r| r.url != url);
            if settings.active.as_deref() == Some(url.as_str()) {
                settings.active = None;
                state.relay.lock().unwrap().stop();
                state.local.set_relay_target("", None);
            }
        }
        "rename" => {
            let url = body.url.unwrap_or_default();
            let name = body.name.unwrap_or_default();
            if let Some(r) = settings.relays.iter_mut().find(|r| r.url == url) {
                r.name = name.clone();
            }
            let cur = state.local.relay_state();
            if cur.url.as_deref() == Some(url.as_str()) {
                state.local.set_relay_target(&name, cur.url);
            }
        }
        other => {
            return Err((axum::http::StatusCode::BAD_REQUEST, format!("未知操作 {other}")));
        }
    }
    config::save_settings(&settings)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(serde_json::json!({
        "relays": settings.relays,
        "activeRelay": settings.active,
    })))
}
