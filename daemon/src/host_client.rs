//! 会话宿主客户端（daemon 侧）：连接/拉起宿主进程，代理会话操作。
//!
//! 请求串行化：gate 互斥保证同一时刻只有一个在途请求（PTY 操作毫秒级），
//! 应答帧无需改写 reqId —— 带 reqId 的帧累积进当前收集器，host.reply.end
//! 一次性交付。事件帧（output/exited/agent.status，无 reqId）进 broadcast，
//! relay 与本地 viewer 各自订阅。

use std::sync::Arc;

use crate::protocol::{ClientMsg, DaemonMsg};

#[derive(Clone)]
pub struct SessionHost {
    inner: Arc<Shared>,
}

struct Shared {
    /// 请求串行门（整个请求-应答周期持锁）
    gate: tokio::sync::Mutex<()>,
    write: tokio::sync::Mutex<Option<WriteHalf>>,
    /// 当前请求的应答收集器（reader 线程写入；std 锁，临界区内无 await）
    pending: std::sync::Mutex<Option<Collector>>,
    events: tokio::sync::broadcast::Sender<DaemonMsg>,
}

struct Collector {
    tx: tokio::sync::oneshot::Sender<Vec<DaemonMsg>>,
    buf: Vec<DaemonMsg>,
}

type WriteHalf = tokio::net::tcp::OwnedWriteHalf;

fn host_file() -> std::path::PathBuf {
    std::env::temp_dir().join("remoteagent-host.json")
}

struct HostInfo {
    port: u16,
    token: String,
}

fn read_host_file() -> Option<HostInfo> {
    let raw = std::fs::read_to_string(host_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(HostInfo {
        port: v["port"].as_u64()? as u16,
        token: v["token"].as_str()?.to_string(),
    })
}

impl SessionHost {
    pub async fn start() -> anyhow::Result<Self> {
        let (events, _) = tokio::sync::broadcast::channel(8192);
        let host = Self {
            inner: Arc::new(Shared {
                gate: tokio::sync::Mutex::new(()),
                write: tokio::sync::Mutex::new(None),
                pending: std::sync::Mutex::new(None),
                events,
            }),
        };
        host.attach_or_spawn().await?;
        Ok(host)
    }

    /// 先试连现有宿主；不行则拉起一个新宿主再连
    async fn attach_or_spawn(&self) -> anyhow::Result<()> {
        if let Some(info) = read_host_file() {
            if self.connect_into(&info).await.is_ok() {
                tracing::info!(port = info.port, "attached to existing session host");
                return Ok(());
            }
            tracing::info!("stale host file, respawning session host");
        }
        self.spawn_host().await?;
        for _ in 0..40 {
            if let Some(info) = read_host_file() {
                if self.connect_into(&info).await.is_ok() {
                    tracing::info!(port = info.port, "session host spawned & connected");
                    return Ok(());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        anyhow::bail!("session host did not come up")
    }

    async fn spawn_host(&self) -> anyhow::Result<()> {
        let exe = std::env::current_exe()?;
        let mut cmd = std::process::Command::new(&exe);
        cmd.arg("--session-host");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 宿主日志与 daemon 同文件；CREATE_NO_WINDOW 无闪窗
            let log = std::fs::File::options()
                .create(true)
                .append(true)
                .open(std::env::temp_dir().join("remoteagent-daemon.log"))
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null());
            cmd.creation_flags(0x0800_0000)
                .stdout(log)
                .stderr(std::process::Stdio::null());
        }
        let child = cmd.spawn()?;
        // 脱离父进程生命周期：daemon 退出不带走宿主（这正是持久化的意义）
        std::mem::forget(child);
        Ok(())
    }

    /// 建立连接：握手 → 写半存入 Shared → reader 任务持有同一 Shared 路由帧
    async fn connect_into(&self, info: &HostInfo) -> anyhow::Result<()> {
        let stream = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::net::TcpStream::connect(("127.0.0.1", info.port)),
        )
        .await??;
        stream.set_nodelay(true).ok();
        let (read, mut write) = stream.into_split();

        let hello = serde_json::json!({"t": "host.hello", "token": info.token});
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        write.write_all(format!("{hello}\n").as_bytes()).await?;
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(3), reader.read_line(&mut line))
            .await??;
        if n == 0 || !line.contains("host.ack") {
            anyhow::bail!("host handshake rejected");
        }

        *self.inner.write.lock().await = Some(write);

        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut reader = reader;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let raw = line.trim();
                        if raw.is_empty() {
                            continue;
                        }
                        let v: serde_json::Value = match serde_json::from_str(raw) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        match v["t"].as_str() {
                            Some("host.reply.end") => {
                                let done = {
                                    let mut p = inner.pending.lock().unwrap();
                                    p.take().map(|c| c.tx.send(c.buf).is_ok())
                                };
                                let _ = done;
                            }
                            Some("host.pong") => {}
                            Some("host.error") => {
                                tracing::warn!("host error: {}", v["msg"].as_str().unwrap_or("?"));
                            }
                            _ => {
                                let msg: DaemonMsg = match serde_json::from_str(raw) {
                                    Ok(m) => m,
                                    Err(_) => continue,
                                };
                                if has_req_id(&msg) {
                                    let mut p = inner.pending.lock().unwrap();
                                    if let Some(c) = p.as_mut() {
                                        c.buf.push(msg);
                                    }
                                } else {
                                    let _ = inner.events.send(msg);
                                }
                            }
                        }
                    }
                }
            }
            tracing::warn!("session host connection lost");
            *inner.write.lock().await = None;
        });
        Ok(())
    }

    /// 订阅事件流（output / exited / agent.status）
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<DaemonMsg> {
        self.inner.events.subscribe()
    }

    /// 发起一次会话请求，拿到全部应答帧；宿主断连时自动重连重试
    pub async fn request(&self, msg: ClientMsg) -> Vec<DaemonMsg> {
        let _gate = self.inner.gate.lock().await;
        for _ in 0..3 {
            match self.request_once(&msg).await {
                Ok(r) => return r,
                Err(e) => {
                    tracing::warn!(error = %e, "host request failed, reconnecting");
                    self.reconnect().await;
                }
            }
        }
        vec![DaemonMsg::Error {
            req_id: req_id_of(&msg),
            code: "host_unavailable".into(),
            msg: "session host unreachable".into(),
        }]
    }

    async fn request_once(&self, msg: &ClientMsg) -> anyhow::Result<Vec<DaemonMsg>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Vec<DaemonMsg>>();
        {
            let mut p = self.inner.pending.lock().unwrap();
            *p = Some(Collector { tx, buf: Vec::new() });
        }
        let line = serde_json::to_string(msg)?;
        {
            let mut w = self.inner.write.lock().await;
            let Some(w) = w.as_mut() else {
                // 连接不在了：清掉收集器再报错
                *self.inner.pending.lock().unwrap() = None;
                anyhow::bail!("host not connected");
            };
            use tokio::io::AsyncWriteExt;
            if let Err(e) = w.write_all(format!("{line}\n").as_bytes()).await {
                *self.inner.pending.lock().unwrap() = None;
                anyhow::bail!(e);
            }
        }
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(frames)) => Ok(frames),
            Ok(Err(_)) => anyhow::bail!("collector dropped"),
            Err(_) => {
                *self.inner.pending.lock().unwrap() = None;
                anyhow::bail!("host request timeout")
            }
        }
    }

    async fn reconnect(&self) {
        if let Some(info) = read_host_file() {
            if self.connect_into(&info).await.is_ok() {
                return;
            }
        }
        // 宿主也没了：拉起一个新的（旧会话已丢失，但恢复服务可用性）
        if self.spawn_host().await.is_ok() {
            for _ in 0..20 {
                if let Some(info) = read_host_file() {
                    if self.connect_into(&info).await.is_ok() {
                        return;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
    }

    /// 面板用：会话列表（best effort）
    pub async fn list(&self) -> Vec<crate::protocol::SessionInfo> {
        let r = self.request(ClientMsg::SessionList { req_id: 0 }).await;
        for m in r {
            if let DaemonMsg::SessionListResult { sessions, .. } = m {
                return sessions;
            }
        }
        Vec::new()
    }
}

fn has_req_id(m: &DaemonMsg) -> bool {
    match m {
        DaemonMsg::SessionListResult { .. }
        | DaemonMsg::SessionCreated { .. }
        | DaemonMsg::SessionAttached { .. }
        | DaemonMsg::SessionKilled { .. } => true,
        DaemonMsg::Error { req_id, .. } => req_id.is_some(),
        _ => false,
    }
}

fn req_id_of(m: &ClientMsg) -> Option<u64> {
    match m {
        ClientMsg::SessionList { req_id }
        | ClientMsg::SessionCreate { req_id, .. }
        | ClientMsg::SessionAttach { req_id, .. }
        | ClientMsg::SessionKill { req_id, .. } => Some(*req_id),
        _ => None,
    }
}
