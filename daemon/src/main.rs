// RemoteAgent daemon — M0 skeleton.
// M1 起实现：本地 WS 服务 + PTY 管理；M2 起改为出站连接中继。

use anyhow::Result;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tracing::info!("remoteagent daemon stub (M0)");
    let device_id = uuid::Uuid::new_v4();
    tracing::info!(%device_id, "device identity would be generated here (persisted from M2)");
    Ok(())
}
